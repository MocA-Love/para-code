/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドプリセットの集約サービス実装。
//   - ユーザーレベル: 設定 paradis.terminal.presets を購読
//   - リポジトリレベル: 各ワークスペースフォルダ直下の .paracode.json を correlated watcher で監視
//     （手法は upstream の workspaceDotMcpDiscovery.ts と同じ）
// 実行エンジンもここに持つ。エディタ領域ターミナルは1エディタ=1ターミナルのため、
// split モードはエディタグループの分割（右→下の交互）で疑似的に2Dグリッドを作る。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { parse as parseJsonc } from '../../../../base/common/jsonc.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { GeneralShellType, ITerminalEnvironment, WindowsShellType } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { editorGroupToColumn } from '../../../../workbench/services/editor/common/editorGroupColumn.js';
import { GroupDirection, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisTerminalScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisPresetDefinition,
	IParadisPresetService,
	IParadisResolvedPreset,
	IParadisRunPresetOptions,
	isValidPresetDefinition,
	paradisGetPresetTasks,
	PARADIS_PRESETS_SETTING,
	PARADIS_WORKSPACE_PRESET_FILE,
	ParadisPresetSource,
	paradisJoinPresetCommands,
} from '../common/paradisTerminalPresets.js';

/**
 * プリセット名をターミナルの初期タイトルとしてどう渡すかを決める。
 *
 * `name` で渡すと terminalInstance 側で「ユーザーが手で付けた固定タイトル」扱いになり、
 * **xterm の OSC タイトル購読自体が張られない**（terminalInstance.ts の `if (name && !titleTemplate)`
 * 側に入り、購読を張る else 側を通らない）。その結果 `sequence` が永久に未設定になり、
 * Claude / Codex が自分で出すタイトルも、そこから行うエージェント CLI の判別も一切効かなくなる。
 *
 * `titleTemplate` で渡せば購読が張られ、固定タイトルも付かないので、エージェントが動き出したら
 * そのタイトルへ切り替わる（切り替えの優先順位は terminalInstance.ts の PARA-PATCH が持つ）。
 *
 * ただし titleTemplate は `${cwd}` 等を展開するテンプレートで、`$` 以降が閉じ `}` まで変数名として
 * 食われ、閉じが無ければ丸ごと捨てられる（base/common/labels.ts の template）。`$` を含む名前だけは
 * 従来どおり `name` で渡す（その名前では自動リネームは効かないが、名前が壊れるよりはよい）。
 */
export function paradisPresetTitleConfig(name: string | undefined): { name?: string; titleTemplate?: string } {
	if (!name) {
		return {};
	}
	return name.includes('$') ? { name } : { titleTemplate: name };
}

/** リロードをまたいでプリセット名を戻すための台帳（永続プロセスID → プリセット名）。 */
const PRESET_TITLE_STORAGE_KEY = 'paradis.terminal.presets.restoredTitles';
/** 台帳に残す件数の上限。消えた端末の分を確実に掃除する手がないので、古いものから捨てる。 */
const MAX_REMEMBERED_PRESET_TITLES = 200;

export class ParadisPresetService extends Disposable implements IParadisPresetService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePresets = this._register(new Emitter<void>());
	readonly onDidChangePresets: Event<void> = this._onDidChangePresets.event;

	private readonly _folderStores = this._register(new DisposableStore());
	/** フォルダURI(string) → .paracode.json 由来のプリセット */
	private readonly _workspacePresets = new Map<string, IParadisResolvedPreset[]>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
		@ILogService private readonly logService: ILogService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// リロードで復元されたターミナルにプリセット名を戻す。すでに復元済みのものと、これから
		// 復元されるものの両方を見る（このサービスの生成と復元の順序は保証されていない）。
		for (const instance of this.terminalService.instances) {
			this._restorePresetTitle(instance);
		}
		this._register(this.terminalService.onDidCreateInstance(instance => this._restorePresetTitle(instance)));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_PRESETS_SETTING)) {
				this._onDidChangePresets.fire();
			}
		}));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this._refreshFolders()));
		// 信頼状態が変わったら workspace 由来プリセットの表示可否が変わる
		this._register(this.workspaceTrustService.onDidChangeTrust(() => this._onDidChangePresets.fire()));
		this._refreshFolders();
	}

	/**
	 * リポジトリ由来 (.paracode.json) のプリセットは「リポジトリを開いただけで任意コマンドの
	 * ボタンが生える」攻撃面になるため、Workspace Trust で信頼されるまで一切表示・実行しない
	 * (upstream が tasks.json を Workspace Trust で守っているのと同じ整理)。
	 */
	private get _workspacePresetsAllowed(): boolean {
		return this.workspaceTrustService.isWorkspaceTrusted();
	}

	// --- 読み込み --------------------------------------------------------------------------------

	get presets(): readonly IParadisResolvedPreset[] {
		const result: IParadisResolvedPreset[] = [];
		if (this._workspacePresetsAllowed) {
			for (const folder of this.contextService.getWorkspace().folders) {
				result.push(...(this._workspacePresets.get(folder.uri.toString()) ?? []));
			}
		}
		result.push(...this._readUserPresets().filter(preset => this._matchesCurrentWorkspace(preset)));
		return result;
	}

	private _readUserPresets(): IParadisResolvedPreset[] {
		const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.filter(isValidPresetDefinition).map(definition => ({
			...definition,
			source: 'user' as const,
			key: `user:${definition.name}`,
		}));
	}

	private _matchesCurrentWorkspace(preset: IParadisPresetDefinition): boolean {
		if (!Array.isArray(preset.appliesTo) || preset.appliesTo.length === 0) {
			return true;
		}
		const folders = this.contextService.getWorkspace().folders;
		return preset.appliesTo.some(entry => folders.some(folder =>
			entry === basename(folder.uri) || entry === folder.uri.fsPath));
	}

	async getPresetsForFolder(folderUri: URI): Promise<readonly IParadisResolvedPreset[]> {
		const result: IParadisResolvedPreset[] = [];
		// ここは「いま開いていないフォルダ」も指定されうる（モバイルからの一覧要求は、PC で
		// 開いていないスペースを指す）。その場合に現在のワークスペースの信頼で可否を決めると、
		// 手元が信頼済みというだけで、開いてもいないリポジトリの .paracode.json が読まれる。
		// 対象フォルダ自身の信頼で判断する。
		if ((await this.workspaceTrustService.getUriTrustInfo(folderUri)).trusted) {
			result.push(...await this._loadWorkspacePresetFile(joinPath(folderUri, PARADIS_WORKSPACE_PRESET_FILE)));
		}
		result.push(...this._readUserPresets().filter(preset => {
			if (!Array.isArray(preset.appliesTo) || preset.appliesTo.length === 0) {
				return true;
			}
			return preset.appliesTo.some(entry => entry === basename(folderUri) || entry === folderUri.fsPath);
		}));
		return result;
	}

	private _refreshFolders(): void {
		this._folderStores.clear();
		this._workspacePresets.clear();
		for (const folder of this.contextService.getWorkspace().folders) {
			this._watchFolder(folder);
		}
		this._onDidChangePresets.fire();
	}

	private _watchFolder(folder: IWorkspaceFolder): void {
		const store = new DisposableStore();
		this._folderStores.add(store);
		const presetFile = joinPath(folder.uri, PARADIS_WORKSPACE_PRESET_FILE);

		const update = async () => {
			const presets = await this._loadWorkspacePresetFile(presetFile);
			if (store.isDisposed) {
				return;
			}
			this._workspacePresets.set(folder.uri.toString(), presets);
			this._onDidChangePresets.fire();
		};

		const throttler = store.add(new RunOnceScheduler(update, 300));
		const watcher = store.add(this.fileService.createWatcher(presetFile, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(() => throttler.schedule()));
		void update();
	}

	private async _loadWorkspacePresetFile(presetFile: URI): Promise<IParadisResolvedPreset[]> {
		try {
			const content = await this.fileService.readFile(presetFile);
			const parsed = parseJsonc<{ presets?: unknown[] }>(content.value.toString());
			if (!parsed || !Array.isArray(parsed.presets)) {
				return [];
			}
			return parsed.presets.filter(isValidPresetDefinition).map(definition => ({
				...definition,
				appliesTo: undefined,
				source: 'workspace' as const,
				sourceUri: presetFile,
				key: `workspace:${presetFile.toString()}:${definition.name}`,
			}));
		} catch (error) {
			// ファイルが無いのは正常。壊れた JSON は警告だけ出して無視する
			if ((error as { fileOperationResult?: unknown })?.fileOperationResult === undefined) {
				this.logService.warn(`[ParadisPresets] Failed to parse ${presetFile.toString()}`, error);
			}
			return [];
		}
	}

	// --- 保存 ------------------------------------------------------------------------------------

	async savePreset(definition: IParadisPresetDefinition, target: ParadisPresetSource, replaceName?: string): Promise<void> {
		if (target === 'user') {
			const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
			const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
			const nameToReplace = replaceName ?? definition.name;
			const index = list.findIndex(entry => isValidPresetDefinition(entry) && entry.name === nameToReplace);
			if (index >= 0) {
				list[index] = definition;
			} else {
				list.push(definition);
			}
			await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
		} else {
			const folder = this.contextService.getWorkspace().folders[0];
			if (!folder) {
				throw new Error('No workspace folder is open.');
			}
			// リポジトリレベルには appliesTo は不要（そのリポジトリ自体が対象）
			const { appliesTo: _appliesTo, ...cleaned } = definition;
			const presetFile = joinPath(folder.uri, PARADIS_WORKSPACE_PRESET_FILE);
			let parsed: { presets?: unknown[];[key: string]: unknown } = {};
			try {
				const content = await this.fileService.readFile(presetFile);
				parsed = parseJsonc<typeof parsed>(content.value.toString()) ?? {};
			} catch {
				// ファイルが無ければ新規作成
			}
			const list: unknown[] = Array.isArray(parsed.presets) ? [...parsed.presets] : [];
			const nameToReplace = replaceName ?? cleaned.name;
			const index = list.findIndex(entry => isValidPresetDefinition(entry) && entry.name === nameToReplace);
			if (index >= 0) {
				list[index] = cleaned;
			} else {
				list.push(cleaned);
			}
			parsed.presets = list;
			await this.fileService.writeFile(presetFile, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
		}
	}

	async movePreset(preset: IParadisResolvedPreset, direction: -1 | 1): Promise<void> {
		// 表示順（this.presets）を基準に、同一スコープの隣接プリセットと入れ替える。
		// appliesTo でユーザープリセットの一部が非表示でも、実際に隣り合って見えている2件を
		// 入れ替えるため、表示上の直感どおりに並び替えられる。
		const ordered = this.presets;
		const currentIndex = ordered.findIndex(candidate => candidate.key === preset.key);
		if (currentIndex < 0) {
			return;
		}
		const targetIndex = currentIndex + direction;
		if (targetIndex < 0 || targetIndex >= ordered.length) {
			return;
		}
		const neighbor = ordered[targetIndex];
		// スコープをまたぐ移動は不可（workspace 群は常に user 群より前）
		if (neighbor.source !== preset.source) {
			return;
		}
		if (preset.source === 'user') {
			await this._swapUserPresets(preset.name, neighbor.name);
		} else {
			// 同一 .paracode.json 内でのみ入れ替える
			if (!preset.sourceUri || !neighbor.sourceUri || preset.sourceUri.toString() !== neighbor.sourceUri.toString()) {
				return;
			}
			await this._swapWorkspacePresets(preset.sourceUri, preset.name, neighbor.name);
		}
	}

	private async _swapUserPresets(nameA: string, nameB: string): Promise<void> {
		const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
		const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
		const indexA = list.findIndex(entry => isValidPresetDefinition(entry) && entry.name === nameA);
		const indexB = list.findIndex(entry => isValidPresetDefinition(entry) && entry.name === nameB);
		if (indexA < 0 || indexB < 0) {
			return;
		}
		[list[indexA], list[indexB]] = [list[indexB], list[indexA]];
		await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
	}

	private async _swapWorkspacePresets(presetFile: URI, nameA: string, nameB: string): Promise<void> {
		const content = await this.fileService.readFile(presetFile);
		const parsed = parseJsonc<{ presets?: unknown[];[key: string]: unknown }>(content.value.toString()) ?? {};
		const list: unknown[] = Array.isArray(parsed.presets) ? [...parsed.presets] : [];
		const indexA = list.findIndex(entry => isValidPresetDefinition(entry) && entry.name === nameA);
		const indexB = list.findIndex(entry => isValidPresetDefinition(entry) && entry.name === nameB);
		if (indexA < 0 || indexB < 0) {
			return;
		}
		[list[indexA], list[indexB]] = [list[indexB], list[indexA]];
		parsed.presets = list;
		await this.fileService.writeFile(presetFile, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
	}

	async deletePreset(preset: IParadisResolvedPreset): Promise<void> {
		if (preset.source === 'user') {
			const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
			const list: unknown[] = Array.isArray(raw) ? raw.filter(entry => !(isValidPresetDefinition(entry) && entry.name === preset.name)) : [];
			await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
		} else if (preset.sourceUri) {
			const content = await this.fileService.readFile(preset.sourceUri);
			const parsed = parseJsonc<{ presets?: unknown[];[key: string]: unknown }>(content.value.toString()) ?? {};
			parsed.presets = Array.isArray(parsed.presets)
				? parsed.presets.filter(entry => !(isValidPresetDefinition(entry) && entry.name === preset.name))
				: [];
			await this.fileService.writeFile(preset.sourceUri, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
		}
	}

	// --- 実行 ------------------------------------------------------------------------------------

	async runPreset(preset: IParadisResolvedPreset, options?: IParadisRunPresetOptions): Promise<void> {
		const { tasks, layout } = paradisGetPresetTasks(preset);
		if (tasks.length === 0) {
			return;
		}

		if (layout === 'current') {
			// 全タスクのコマンドを連結してアクティブなターミナルへ送る（旧 current-terminal 相当）。
			const commands = tasks.flatMap(task => task.commands);
			const cwd = this._resolveCwd(preset, preset.cwd, options?.cwd);
			let instance = options?.forceNewTerminal ? undefined : this.terminalService.activeInstance;
			if (!instance) {
				instance = await this._createTerminalInActiveGroup(cwd, preset.name, options?.env);
				options?.onDidCreateTerminal?.(instance.instanceId);
				if (options?.stateKey) {
					// 生成〜表示の間にユーザーが別スコープへ切り替えても、既定の（生成時点で
					// アクティブなスコープへの）暗黙タグ付けを明示的に上書きし、正しいスコープに紐付ける。
					this.terminalScopeService.assignInstanceScope(instance.instanceId, options.stateKey);
				}
				options?.onDidStart?.();
				await this._waitForTerminalProcess(instance);
				await instance.sendText(paradisJoinPresetCommands(commands, instance.shellType), true);
			} else {
				await this._waitForTerminalProcess(instance);
				if (preset.cwd && cwd) {
					// 既存ターミナルは作業ディレクトリが不明なので cd を前置する
					const changeDirectory = await this._buildChangeDirectoryCommand(instance, cwd);
					await instance.sendText(paradisJoinPresetCommands([changeDirectory, ...commands], instance.shellType), true);
				} else {
					await instance.sendText(paradisJoinPresetCommands(commands, instance.shellType), true);
				}
				options?.onDidStart?.();
			}
			instance.focus(true);
			return;
		}

		// tabs / split: タスクごとに名前付きターミナルを作って並べる
		let first: ITerminalInstance | undefined;
		let group = this.editorGroupsService.activeGroup;
		for (let index = 0; index < tasks.length; index++) {
			const task = tasks[index];
			const cwd = this._resolveCwd(preset, task.cwd ?? preset.cwd, options?.cwd);
			const name = task.name?.trim() || (tasks.length > 1 ? `${preset.name} ${index + 1}` : preset.name);
			if (layout === 'split' && index > 0) {
				// 先頭はアクティブグループ、以降は右→下の交互にグループを分割して並べる
				group = this.editorGroupsService.addGroup(group, index % 2 === 1 ? GroupDirection.RIGHT : GroupDirection.DOWN);
			}
			const instance = await this.terminalService.createTerminal({
				// env は解決の過程で in-place に書き換えられ、そのままインスタンスに保持されるため、
				// タスクごとに複製して他のターミナルへ影響が伝播しないようにする
				config: { ...paradisPresetTitleConfig(name), env: options?.env ? { ...options.env } : undefined },
				cwd,
				location: { viewColumn: editorGroupToColumn(this.editorGroupsService, group) },
			});
			options?.onDidCreateTerminal?.(instance.instanceId);
			void this._rememberPresetTitle(instance, name);
			this._warnIfEnvDropped(instance, options?.env);
			if (options?.stateKey) {
				this.terminalScopeService.assignInstanceScope(instance.instanceId, options.stateKey);
			}
			options?.onDidStart?.();
			first ??= instance;
			await this._waitForTerminalProcess(instance);
			await instance.sendText(paradisJoinPresetCommands(task.commands, instance.shellType), true);
		}
		first?.focus(true);
	}

	/**
	 * プリセット名は `titleTemplate` で渡しているが、これはターミナルの復元情報に含まれない
	 * （`IPtyHostAttachTarget` に無い）。リロードすると名前だけ失われて `${process}`（zsh 等）に
	 * 戻ってしまうので、永続プロセスの ID をキーに自前で覚えておいて復元時に貼り直す。
	 */
	private async _rememberPresetTitle(instance: ITerminalInstance, name: string | undefined): Promise<void> {
		if (!name || !instance.shellLaunchConfig.titleTemplate) {
			return;
		}
		await instance.processReady;
		const persistentProcessId = instance.persistentProcessId;
		if (persistentProcessId === undefined || instance.isDisposed) {
			return;
		}
		const entries = this._readPresetTitles().filter(entry => entry.id !== persistentProcessId);
		entries.push({ id: persistentProcessId, name });
		// 消えた端末の分を確実に掃除する手がない（リロードでは onDisposed を当てにできない）ので、
		// 件数で頭打ちにして古いものから捨てる。
		this.storageService.store(
			PRESET_TITLE_STORAGE_KEY,
			JSON.stringify(entries.slice(-MAX_REMEMBERED_PRESET_TITLES)),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	/** 復元されたターミナルに、覚えておいたプリセット名を貼り直す。 */
	private _restorePresetTitle(instance: ITerminalInstance): void {
		const attachedId = instance.shellLaunchConfig.attachPersistentProcess?.id;
		// 復元された端末だけを対象にする。新規作成の端末は台帳の ID とたまたま一致しようがない。
		if (attachedId === undefined || instance.shellLaunchConfig.titleTemplate || instance.shellLaunchConfig.name) {
			return;
		}
		const name = this._readPresetTitles().find(entry => entry.id === attachedId)?.name;
		if (!name) {
			return;
		}
		instance.shellLaunchConfig.titleTemplate = name;
		// ラベルはもう計算済みなので、計算し直させる。`rename(undefined)` は固定タイトルを付けずに
		// reset 付きの再計算だけを起こす（_updateTitleProperties が title === undefined で早期 return する）。
		void instance.rename(undefined);
	}

	private _readPresetTitles(): { id: number; name: string }[] {
		try {
			const raw = this.storageService.get(PRESET_TITLE_STORAGE_KEY, StorageScope.WORKSPACE);
			const parsed: unknown = raw ? JSON.parse(raw) : undefined;
			return Array.isArray(parsed)
				? parsed.filter((entry): entry is { id: number; name: string } =>
					!!entry && typeof entry.id === 'number' && typeof entry.name === 'string')
				: [];
		} catch {
			// 壊れた台帳で名前が戻らないのは許容する（機能そのものは動く）。
			return [];
		}
	}

	private _resolveCwd(preset: IParadisResolvedPreset, cwdSpec: string | undefined, baseOverride?: URI): URI | undefined {
		const cwd = cwdSpec?.trim();
		if (cwd && isAbsolute(cwd)) {
			// 絶対指定でも、基準となるフォルダと同じ名前空間で解決する (リモートや UNC の
			// ワークスペースでローカルの file: を強制すると開けない cwd になる)
			const base = baseOverride ?? this.contextService.getWorkspace().folders[0]?.uri;
			return (base && paradisResolveExternalPath(base, cwd)) ?? URI.file(cwd);
		}
		// 明示された基準 (worktree 作成直後など、フォルダ反映を待てない場面) を最優先する
		if (baseOverride) {
			return cwd ? joinPath(baseOverride, this._normalizeRelativeCwd(cwd)) : baseOverride;
		}
		const folder = preset.source === 'workspace' && preset.sourceUri
			? this.contextService.getWorkspace().folders.find(candidate => candidate.uri.toString() === joinPath(preset.sourceUri!, '..').toString())
			?? this.contextService.getWorkspace().folders[0]
			: this.contextService.getWorkspace().folders[0];
		if (!cwd) {
			return folder?.uri;
		}
		if (!folder) {
			return undefined;
		}
		return folder.toResource(this._normalizeRelativeCwd(cwd));
	}

	private _normalizeRelativeCwd(cwd: string): string {
		return cwd.replace(/\\/g, '/').replace(/^\.\//, '');
	}

	private async _buildChangeDirectoryCommand(instance: ITerminalInstance, cwd: URI): Promise<string> {
		if (instance.shellType === GeneralShellType.PowerShell) {
			return `Set-Location -LiteralPath '${cwd.fsPath.replace(/'/g, '$&$&')}'`;
		}
		if (instance.shellType === WindowsShellType.CommandPrompt) {
			return `cd /d "${cwd.fsPath.replace(/"/g, '""')}"`;
		}
		return `cd ${await instance.preparePathForShell(cwd.fsPath)}`;
	}

	private async _createTerminalInActiveGroup(cwd: URI | undefined, name?: string, env?: ITerminalEnvironment): Promise<ITerminalInstance> {
		const instance = await this.terminalService.createTerminal({
			// config を渡すと terminalService 側の既定プロファイル先行解決が走らないため、
			// 渡すものが無いときは undefined のままにする（従来の経路を維持する）
			config: (name || env) ? { ...paradisPresetTitleConfig(name), env: env ? { ...env } : undefined } : undefined,
			cwd,
			location: { viewColumn: editorGroupToColumn(this.editorGroupsService, this.editorGroupsService.activeGroup) },
		});
		void this._rememberPresetTitle(instance, name);
		this._warnIfEnvDropped(instance, env);
		return instance;
	}

	/**
	 * 拡張が提供するプロファイルが既定になっている場合、ターミナル生成側が icon/cwd 等しか
	 * 引き継がず、指定した環境変数が無言で捨てられる。原因不明の失敗（プリセット内で
	 * 環境変数が空に展開される等）を追えるようにログだけ残す。
	 */
	private _warnIfEnvDropped(instance: ITerminalInstance, env: ITerminalEnvironment | undefined): void {
		if (env && !instance.shellLaunchConfig.env) {
			this.logService.warn('[ParadisPresets] Environment variables were dropped by the default terminal profile');
		}
	}

	private async _waitForTerminalProcess(instance: ITerminalInstance): Promise<void> {
		const startedAt = Date.now();
		try {
			await instance.processReady;
		} catch (error) {
			reportParadisDiagnosticError('owned', 'terminal-preset', 'process-ready', error, {
				duration_ms: Date.now() - startedAt,
				phase: 'startup',
				shell_kind: String(instance.shellType ?? 'unknown'),
			});
			throw error;
		}
		const duration = Date.now() - startedAt;
		if (duration >= 5_000) {
			reportParadisDiagnosticError('owned', 'terminal-preset', 'slow-process-ready', new Error('Terminal process startup was slow'), {
				duration_ms: duration,
				phase: 'startup',
				shell_kind: String(instance.shellType ?? 'unknown'),
			});
		}
	}
}
