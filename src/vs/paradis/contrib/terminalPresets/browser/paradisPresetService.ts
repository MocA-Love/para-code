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
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { GeneralShellType, WindowsShellType } from '../../../../platform/terminal/common/terminal.js';
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
	) {
		super();

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
		if (this._workspacePresetsAllowed) {
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
				instance = await this._createTerminalInActiveGroup(cwd, preset.name);
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
				config: { name },
				cwd,
				location: { viewColumn: editorGroupToColumn(this.editorGroupsService, group) },
			});
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

	private _resolveCwd(preset: IParadisResolvedPreset, cwdSpec: string | undefined, baseOverride?: URI): URI | undefined {
		const cwd = cwdSpec?.trim();
		if (cwd && isAbsolute(cwd)) {
			return URI.file(cwd);
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

	private async _createTerminalInActiveGroup(cwd: URI | undefined, name?: string): Promise<ITerminalInstance> {
		return this.terminalService.createTerminal({
			config: name ? { name } : undefined,
			cwd,
			location: { viewColumn: editorGroupToColumn(this.editorGroupsService, this.editorGroupsService.activeGroup) },
		});
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
