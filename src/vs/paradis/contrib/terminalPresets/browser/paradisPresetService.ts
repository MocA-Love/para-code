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
import { isWindows, OperatingSystem } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { GeneralShellType, ITerminalEnvironment, WindowsShellType } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { editorGroupToColumn } from '../../../../workbench/services/editor/common/editorGroupColumn.js';
import { GroupDirection, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IParadisTerminalScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisPresetDefinition,
	IParadisPresetService,
	IParadisResolvedPreset,
	IParadisResolvedPresetFolder,
	IParadisRunPresetOptions,
	IParadisSavePresetOptions,
	isValidPresetDefinition,
	paradisAllFolderNames,
	paradisDistinctFolderNames,
	paradisGetPresetTasks,
	paradisPresetFingerprint,
	paradisPresetHostsMatch,
	paradisPresetKey,
	paradisResolvePresetIndex,
	paradisUsablePresetId,
	PARADIS_PRESET_FOLDERS_SETTING,
	PARADIS_PRESETS_SETTING,
	PARADIS_WORKSPACE_PRESET_FILE,
	ParadisPresetSource,
	paradisJoinPresetCommands,
} from '../common/paradisTerminalPresets.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';

// allow-any-unicode-next-line
const STR_PRESET_GONE = localize('paradis.presets.gone', "このプリセットは見つかりませんでした。設定が別の場所で変更された可能性があります。一覧を開き直してください。");

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

/**
 * workspace ソースのプリセットを「このマシンでだけ非表示にする」台帳のキー。値は
 * `${定義元ファイルのURI}::${指紋}` の配列（.paracode.json には一切書き込まない、
 * このマシンだけの表示設定）。StorageTarget.MACHINE なので Settings Sync でも同期されない。
 */
const LOCALLY_HIDDEN_WORKSPACE_PRESETS_STORAGE_KEY = 'paradis.terminal.presets.locallyHiddenWorkspace';

export class ParadisPresetService extends Disposable implements IParadisPresetService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePresets = this._register(new Emitter<void>());
	readonly onDidChangePresets: Event<void> = this._onDidChangePresets.event;

	private readonly _folderStores = this._register(new DisposableStore());
	/** フォルダURI(string) → .paracode.json 由来のプリセット */
	private readonly _workspacePresets = new Map<string, IParadisResolvedPreset[]>();
	/**
	 * フォルダURI(string) → .paracode.json の presetFolders 由来の空フォルダ台帳。
	 * _watchFolder の update() が presets と同じ1回のファイル読み込み・パースから両方を取り出す
	 * （同じファイルを2回読まないため）。
	 */
	private readonly _workspacePresetFolders = new Map<string, IParadisResolvedPresetFolder[]>();
	/** `${定義元ファイルのURI}::${指紋}` の集合。LOCALLY_HIDDEN_WORKSPACE_PRESETS_STORAGE_KEY 参照。 */
	private readonly _locallyHiddenWorkspacePresets = new Set<string>();

	/**
	 * 現在のウィンドウの remote authority。未接続（ローカル）は undefined に正規化する。
	 * authority は起動時に確定して以後変わらないため、hosts 条件（{@link paradisPresetHostsMatch}）
	 * の再評価は設定・ファイル変更時だけで足りる。
	 */
	private get _currentRemoteAuthority(): string | undefined {
		return this.environmentService.remoteAuthority || undefined;
	}

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
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		for (const key of this._readLocallyHiddenWorkspacePresets()) {
			this._locallyHiddenWorkspacePresets.add(key);
		}
		// 同じワークスペースを2ウィンドウで開いていると、この台帳（WORKSPACE スコープ）は両方から
		// 見える。片方だけがメモリ上の Set を持ち続けると、後から書き込んだ方が先勝ちで上書きし、
		// 相手側が非表示にした分を消してしまう。ストレージ側の変更を都度取り込んで自分の Set を
		// 追従させておけば、次に自分が書き込むときには既に相手の分を含んだ状態から始められる。
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, LOCALLY_HIDDEN_WORKSPACE_PRESETS_STORAGE_KEY, this._store)(() => {
			this._locallyHiddenWorkspacePresets.clear();
			for (const key of this._readLocallyHiddenWorkspacePresets()) {
				this._locallyHiddenWorkspacePresets.add(key);
			}
			this._reapplyLocallyHidden();
			this._onDidChangePresets.fire();
		}));

		// リロードで復元されたターミナルにプリセット名を戻す。すでに復元済みのものと、これから
		// 復元されるものの両方を見る（このサービスの生成と復元の順序は保証されていない）。
		for (const instance of this.terminalService.instances) {
			this._restorePresetTitle(instance);
		}
		this._register(this.terminalService.onDidCreateInstance(instance => this._restorePresetTitle(instance)));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_PRESETS_SETTING) || e.affectsConfiguration(PARADIS_PRESET_FOLDERS_SETTING)) {
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

	get folders(): readonly IParadisResolvedPresetFolder[] {
		return this._foldersFor(this.presets);
	}

	/**
	 * {@link folders} の実体。既に presets を計算済みの呼び出し元（createFolder 等）は、
	 * `this.folders`（内部で presets を再計算する）ではなくこちらを直接呼ぶことで、同じ内容の
	 * 二重パースを避けられる。
	 */
	private _foldersFor(presets: readonly IParadisResolvedPreset[]): readonly IParadisResolvedPresetFolder[] {
		const result: IParadisResolvedPresetFolder[] = [];
		if (this._workspacePresetsAllowed) {
			for (const folder of this.contextService.getWorkspace().folders) {
				result.push(...(this._workspacePresetFolders.get(folder.uri.toString()) ?? []));
			}
		}
		result.push(...this._readUserPresetFolders());
		// 実プリセットが既にその名前の folder を1件以上持っているものは除外する——台帳は
		// 「まだ中身が無い」フォルダ専用の記録であって、実プリセット側と二重に一覧へ出すものではない。
		const namesWithPresets = new Set(paradisDistinctFolderNames(presets));
		return result.filter(folder => !namesWithPresets.has(folder.name));
	}

	private _readUserPresets(): IParadisResolvedPreset[] {
		const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
		if (!Array.isArray(raw)) {
			return [];
		}
		// 位置は「不正エントリを取り除く前」の配列で数える。保存・削除はこの位置で書き戻すため、
		// 読み飛ばした1件のぶんだけずれると無関係なプリセットを書き換えてしまう。
		const takenIds = new Set<string>();
		return raw
			.map((definition, index) => ({ definition, index }))
			.filter((entry): entry is { definition: IParadisPresetDefinition; index: number } => isValidPresetDefinition(entry.definition))
			.map(({ definition, index }) => {
				// 設定は手で編集できる。エントリごとコピーされて id が重複していたら、その id は
				// 識別子として使えない（2件目を触ったつもりで1件目が書き換わる）ので位置に落とす。
				const entry: IParadisPresetDefinition = { ...definition, id: paradisUsablePresetId(definition, takenIds) };
				return {
					...entry,
					source: 'user' as const,
					sourceIndex: index,
					key: paradisPresetKey('user', undefined, entry, index),
					envInactive: !paradisPresetHostsMatch(entry.hosts, this._currentRemoteAuthority),
				};
			});
	}

	/** ユーザー設定側の空フォルダ台帳（{@link PARADIS_PRESET_FOLDERS_SETTING}）を解決済みの形へ変換する。 */
	private _readUserPresetFolders(): IParadisResolvedPresetFolder[] {
		const raw = this.configurationService.getValue<unknown>(PARADIS_PRESET_FOLDERS_SETTING);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw
			.map((name, index) => ({ name, index }))
			.filter((entry): entry is { name: string; index: number } => typeof entry.name === 'string' && entry.name.trim().length > 0)
			.map(({ name, index }) => ({ name: name.trim(), source: 'user' as const, sourceIndex: index }));
	}

	/**
	 * .paracode.json の presetFolders（空フォルダ台帳）を解決済みの形へ変換する。
	 * {@link _parseWorkspacePresets} と同じく、位置は「不正エントリを取り除く前」の配列で数える。
	 */
	private _parseWorkspacePresetFolders(raw: unknown, presetFile: URI): IParadisResolvedPresetFolder[] {
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw
			.map((name, index) => ({ name, index }))
			.filter((entry): entry is { name: string; index: number } => typeof entry.name === 'string' && entry.name.trim().length > 0)
			.map(({ name, index }) => ({ name: name.trim(), source: 'workspace' as const, sourceUri: presetFile, sourceIndex: index }));
	}

	/**
	 * `appliesTo` の 1 エントリがこのフォルダを指しているか。
	 *
	 * 絶対パス指定は `uri.path`（POSIX 表記）でも受ける。SSH で繋いだフォルダは
	 * `vscode-remote://ssh-remote+host/home/u/repo` なので、`fsPath` だけで比べると
	 * Windows クライアントでは `\home\u\repo` になり、ユーザーが書いた `/home/u/repo` と
	 * 一致しない。ローカルの Windows パス指定も引き続き通るよう、両方を許容する。
	 */
	private _appliesToFolder(entry: string, folderUri: URI): boolean {
		return entry === basename(folderUri) || entry === folderUri.fsPath || entry === folderUri.path;
	}

	private _matchesCurrentWorkspace(preset: IParadisPresetDefinition): boolean {
		if (!Array.isArray(preset.appliesTo) || preset.appliesTo.length === 0) {
			return true;
		}
		const folders = this.contextService.getWorkspace().folders;
		return preset.appliesTo.some(entry => folders.some(folder => this._appliesToFolder(entry, folder.uri)));
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
			return preset.appliesTo.some(entry => this._appliesToFolder(entry, folderUri));
		}));
		return result;
	}

	private _refreshFolders(): void {
		this._folderStores.clear();
		this._workspacePresets.clear();
		this._workspacePresetFolders.clear();
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
			const { presets, folders } = await this._loadWorkspacePresetFileFull(presetFile);
			if (store.isDisposed) {
				return;
			}
			this._workspacePresets.set(folder.uri.toString(), presets);
			this._workspacePresetFolders.set(folder.uri.toString(), folders);
			this._onDidChangePresets.fire();
		};

		const throttler = store.add(new RunOnceScheduler(update, 300));
		const watcher = store.add(this.fileService.createWatcher(presetFile, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(() => throttler.schedule()));
		void update();
	}

	private async _loadWorkspacePresetFile(presetFile: URI): Promise<IParadisResolvedPreset[]> {
		return (await this._loadWorkspacePresetFileFull(presetFile)).presets;
	}

	/**
	 * .paracode.json を1回だけ読み込み・パースして、presets と presetFolders（空フォルダ台帳）の
	 * 両方を取り出す。{@link _watchFolder} の update() はここを1回呼ぶだけで両方のキャッシュを
	 * 更新できる——presets 用と presetFolders 用で別々に読むと同じファイルを2回読むことになる。
	 */
	private async _loadWorkspacePresetFileFull(presetFile: URI): Promise<{ presets: IParadisResolvedPreset[]; folders: IParadisResolvedPresetFolder[] }> {
		try {
			const content = await this.fileService.readFile(presetFile);
			const parsed = parseJsonc<{ presets?: unknown[]; presetFolders?: unknown[] }>(content.value.toString());
			if (!parsed) {
				return { presets: [], folders: [] };
			}
			return {
				presets: this._parseWorkspacePresets(parsed.presets, presetFile),
				folders: this._parseWorkspacePresetFolders(parsed.presetFolders, presetFile),
			};
		} catch (error) {
			// ファイルが無いのは正常。壊れた JSON は警告だけ出して無視する
			if ((error as { fileOperationResult?: unknown })?.fileOperationResult === undefined) {
				this.logService.warn(`[ParadisPresets] Failed to parse ${presetFile.toString()}`, error);
			}
			return { presets: [], folders: [] };
		}
	}

	private _parseWorkspacePresets(rawPresets: unknown, presetFile: URI): IParadisResolvedPreset[] {
		if (!Array.isArray(rawPresets)) {
			return [];
		}
		const takenIds = new Set<string>();
		return rawPresets
			.map((definition, index) => ({ definition, index }))
			.filter((entry): entry is { definition: IParadisPresetDefinition; index: number } => isValidPresetDefinition(entry.definition))
			.map(({ definition, index }) => {
				const entry: IParadisPresetDefinition = { ...definition, id: paradisUsablePresetId(definition, takenIds) };
				return {
					...entry,
					appliesTo: undefined,
					source: 'workspace' as const,
					sourceUri: presetFile,
					sourceIndex: index,
					key: paradisPresetKey('workspace', presetFile, entry, index),
					locallyHidden: this._locallyHiddenWorkspacePresets.has(this._locallyHiddenKey(presetFile, entry)),
					envInactive: !paradisPresetHostsMatch(entry.hosts, this._currentRemoteAuthority),
				};
			});
	}

	// --- 保存 ------------------------------------------------------------------------------------

	/**
	 * 対象の位置を解決する。見失っていたら**黙って別の解釈に倒さず**例外にする。
	 * 追加に倒すと「編集したつもりが複製になる」、無視すると「削除を押したのに何も起きない」
	 * ——どちらもユーザーからは操作が効かなかったようにしか見えない。
	 */
	private _requirePresetIndex(list: readonly unknown[], preset: IParadisResolvedPreset): number {
		const index = paradisResolvePresetIndex(list, preset);
		if (index < 0) {
			throw new Error(STR_PRESET_GONE);
		}
		return index;
	}

	/** ユーザー設定に書き込む id を決める。既存の id を引き継ぎ、無ければ他と衝突しない値を採番する。 */
	private _assignUserPresetId(definition: IParadisPresetDefinition, list: readonly unknown[], replaceIndex: number): string {
		const existing = replaceIndex >= 0 ? list[replaceIndex] : undefined;
		const inherited = definition.id ?? (isValidPresetDefinition(existing) ? existing.id : undefined);
		const taken = new Set(list
			.filter((entry, index) => index !== replaceIndex)
			.filter(isValidPresetDefinition)
			.map(entry => entry.id));
		// 引き継げるのは、他のエントリが使っていない id だけ。設定を手でコピーして重複した id は
		// 読み込み側が毎回捨てているので、書き込む機会に採番し直して直す。
		if (inherited && !taken.has(inherited)) {
			return inherited;
		}
		let id = generateUuid().slice(0, 8);
		while (taken.has(id)) {
			id = generateUuid().slice(0, 8);
		}
		return id;
	}

	async savePreset(definition: IParadisPresetDefinition, target: ParadisPresetSource, options?: IParadisSavePresetOptions): Promise<void> {
		const replace = options?.replace?.source === target ? options.replace : undefined;
		if (target === 'user') {
			const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
			const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
			const index = replace ? this._requirePresetIndex(list, replace) : -1;
			// ユーザー設定は自分だけのファイルなので id を書き込む。名前を変えても同じ
			// プリセットとして追跡でき、同名が並んでも取り違えない。
			const entry: IParadisPresetDefinition = { ...definition, id: this._assignUserPresetId(definition, list, index) };
			if (index >= 0) {
				list[index] = entry;
			} else {
				list.push(entry);
			}
			await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
		} else {
			// 編集なら定義元のファイルへ書き戻す（複数フォルダを開いていても取り違えない）
			const presetFile = replace?.sourceUri ?? this._defaultWorkspacePresetFile();
			// リポジトリレベルには appliesTo は不要（そのリポジトリ自体が対象）。
			// id も書かない——git で共有されるファイルに識別子を足すと、実装都合の差分が
			// チーム全員のレビューに出てしまう。位置で識別する。
			const { appliesTo: _appliesTo, id: _id, ...cleaned } = definition;
			let parsed: { presets?: unknown[];[key: string]: unknown } = {};
			try {
				const content = await this.fileService.readFile(presetFile);
				parsed = parseJsonc<typeof parsed>(content.value.toString()) ?? {};
			} catch {
				// ファイルが無ければ新規作成
			}
			const list: unknown[] = Array.isArray(parsed.presets) ? [...parsed.presets] : [];
			const index = replace ? this._requirePresetIndex(list, replace) : -1;
			if (index >= 0) {
				list[index] = cleaned;
			} else {
				list.push(cleaned);
			}
			parsed.presets = list;
			await this.fileService.writeFile(presetFile, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
		}
	}

	private _defaultWorkspacePresetFile(): URI {
		const folder = this.contextService.getWorkspace().folders[0];
		if (!folder) {
			throw new Error('No workspace folder is open.');
		}
		return joinPath(folder.uri, PARADIS_WORKSPACE_PRESET_FILE);
	}

	/**
	 * .paracode.json のURIから、それを持つワークスペースフォルダを引く。`joinPath(uri, '..')` の
	 * ような相対 URI 演算はパスの正規化差（末尾スラッシュの有無等）に依存して壊れやすいため、
	 * 各ワークスペースフォルダの定義元ファイルURIを実際に組み立てて文字列比較する。
	 */
	private _workspaceFolderForPresetFile(presetFile: URI): IWorkspaceFolder | undefined {
		return this.contextService.getWorkspace().folders.find(folder =>
			joinPath(folder.uri, PARADIS_WORKSPACE_PRESET_FILE).toString() === presetFile.toString());
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
		await this.swapPresets(preset, ordered[targetIndex]);
	}

	async swapPresets(presetA: IParadisResolvedPreset, presetB: IParadisResolvedPreset): Promise<void> {
		// スコープをまたぐ入れ替えは不可（workspace 群は常に user 群より前）
		if (presetA.source !== presetB.source) {
			return;
		}
		if (presetA.source === 'user') {
			await this._swapUserPresets(presetA, presetB);
			return;
		}
		// 同一 .paracode.json 内でのみ入れ替える
		if (!presetA.sourceUri || !presetB.sourceUri || presetA.sourceUri.toString() !== presetB.sourceUri.toString()) {
			return;
		}
		await this._swapWorkspacePresets(presetA.sourceUri, presetA, presetB);
	}

	/**
	 * 並び替えだけは対象を見失っても黙って何もしない（保存・削除と違って例外にしない）。
	 * ↑↓ は連打される操作で、ダイアログを出すと押した回数だけ積み上がる。次の再読み込みで
	 * 一覧が正しい順序に更新されるので、取り返しの付かない結果にもならない。
	 */
	private async _swapUserPresets(presetA: IParadisResolvedPreset, presetB: IParadisResolvedPreset): Promise<void> {
		const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
		const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
		const indexA = paradisResolvePresetIndex(list, presetA);
		const indexB = paradisResolvePresetIndex(list, presetB);
		if (indexA < 0 || indexB < 0) {
			return;
		}
		[list[indexA], list[indexB]] = [list[indexB], list[indexA]];
		await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
	}

	private async _swapWorkspacePresets(presetFile: URI, presetA: IParadisResolvedPreset, presetB: IParadisResolvedPreset): Promise<void> {
		const content = await this.fileService.readFile(presetFile);
		const parsed = parseJsonc<{ presets?: unknown[];[key: string]: unknown }>(content.value.toString()) ?? {};
		const list: unknown[] = Array.isArray(parsed.presets) ? [...parsed.presets] : [];
		const indexA = paradisResolvePresetIndex(list, presetA);
		const indexB = paradisResolvePresetIndex(list, presetB);
		if (indexA < 0 || indexB < 0) {
			return;
		}
		[list[indexA], list[indexB]] = [list[indexB], list[indexA]];
		parsed.presets = list;
		await this.fileService.writeFile(presetFile, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
	}

	/**
	 * プリセットを1件だけ削除する。**名前で消さない**——同じ名前のプリセットが並んでいると
	 * 巻き添えで全部消える（この機能が名前を識別子として扱っていた頃の実害）。
	 */
	async deletePreset(preset: IParadisResolvedPreset): Promise<void> {
		if (preset.source === 'user') {
			const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
			const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
			list.splice(this._requirePresetIndex(list, preset), 1);
			await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
		} else if (preset.sourceUri) {
			const content = await this.fileService.readFile(preset.sourceUri);
			const parsed = parseJsonc<{ presets?: unknown[];[key: string]: unknown }>(content.value.toString()) ?? {};
			const list: unknown[] = Array.isArray(parsed.presets) ? [...parsed.presets] : [];
			list.splice(this._requirePresetIndex(list, preset), 1);
			parsed.presets = list;
			await this.fileService.writeFile(preset.sourceUri, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
		}
	}

	/**
	 * ピン留めだけを切り替える。渡された `preset`（解決済み）を丸ごと書き込まない——
	 * `source`/`sourceUri`/`sourceIndex`/`key` は own property として乗っているため、
	 * スプレッドすると定義元ファイルへそのまま書き込まれてしまう（user 設定・.paracode.json
	 * いずれも実装都合の値を書く経路を作らない、という {@link _requireDefinitionAt} と同じ理由）。
	 * 対象の位置から現在の定義を読み直し、`pinned` だけを上書きして書き戻す。
	 */
	async setPresetPinned(preset: IParadisResolvedPreset, pinned: boolean): Promise<void> {
		if (preset.source === 'user') {
			const raw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
			const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
			const index = this._requirePresetIndex(list, preset);
			list[index] = { ...this._requireDefinitionAt(list, index), pinned };
			await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
			return;
		}
		if (!preset.sourceUri) {
			return;
		}
		const { parsed, list } = await this._readWorkspacePresetsFile(preset.sourceUri);
		const index = this._requirePresetIndex(list, preset);
		list[index] = { ...this._requireDefinitionAt(list, index), pinned };
		parsed.presets = list;
		await this.fileService.writeFile(preset.sourceUri, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
	}

	/**
	 * {@link _locallyHiddenWorkspacePresets} のキー。指紋は appliesTo を持たない workspace 定義向け。
	 * 位置（sourceIndex）を含まない——並び替えで別のプリセットを誤って隠す事故を避けるため、
	 * `paradisResolvePresetIndex` と同じく中身で同一性を判定する。裏返しに、同じファイル内に
	 * **中身まで完全一致する定義が複数ある**場合（コピペ運用等）は、1件を隠すと同じ指紋を持つ
	 * 全件が一緒に隠れる。
	 */
	private _locallyHiddenKey(sourceUri: URI, definition: IParadisPresetDefinition): string {
		return `${sourceUri.toString()}::${paradisPresetFingerprint(definition, { ignoreAppliesTo: true })}`;
	}

	private _readLocallyHiddenWorkspacePresets(): string[] {
		try {
			const raw = this.storageService.get(LOCALLY_HIDDEN_WORKSPACE_PRESETS_STORAGE_KEY, StorageScope.WORKSPACE);
			const parsed: unknown = raw ? JSON.parse(raw) : undefined;
			return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
		} catch {
			// 壊れた台帳は空扱いにする（何も非表示にならないだけで、機能そのものは動く）。
			return [];
		}
	}

	private _writeLocallyHiddenWorkspacePresets(): void {
		this.storageService.store(
			LOCALLY_HIDDEN_WORKSPACE_PRESETS_STORAGE_KEY,
			JSON.stringify([...this._locallyHiddenWorkspacePresets]),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	/**
	 * .paracode.json から読み込み済みのキャッシュ（{@link _workspacePresets}）に、
	 * {@link _locallyHiddenWorkspacePresets} の現在の中身を `locallyHidden` として焼き直す。
	 * 台帳を変えたのにここを呼ばないと、`onDidChangePresets` を発火しても `presets` getter が
	 * 返す配列（キャッシュそのもの）は古い `locallyHidden` のままで、表示が一切変わらない。
	 * ファイルの再読み込み（fileService 経由）は不要——計算値を1フィールド差し替えるだけ。
	 */
	private _reapplyLocallyHidden(): void {
		for (const [folderKey, presets] of this._workspacePresets) {
			this._workspacePresets.set(folderKey, presets.map(preset => {
				const hidden = preset.sourceUri ? this._locallyHiddenWorkspacePresets.has(this._locallyHiddenKey(preset.sourceUri, preset)) : false;
				return preset.locallyHidden === hidden ? preset : { ...preset, locallyHidden: hidden };
			}));
		}
	}

	/**
	 * workspace ソースのプリセットをこのマシンだけで隠す／戻す。定義元の .paracode.json には
	 * 一切書き込まない——git で共有されるファイルを、個人の表示都合で書き換えないため
	 * （{@link setPresetPinned} との使い分けは interface 側のコメント参照）。
	 *
	 * 同じワークスペースを複数ウィンドウで開いている場合に備え、書き込む直前にストレージから
	 * 読み直して自分の Set へ合流させる（他ウィンドウが自分より後に読み込んで先に書いていた分を
	 * 上書きで消さないため）。
	 */
	setWorkspacePresetLocallyHidden(preset: IParadisResolvedPreset, hidden: boolean): void {
		if (preset.source !== 'workspace' || !preset.sourceUri) {
			return;
		}
		for (const key of this._readLocallyHiddenWorkspacePresets()) {
			this._locallyHiddenWorkspacePresets.add(key);
		}
		const key = this._locallyHiddenKey(preset.sourceUri, preset);
		const wasHidden = this._locallyHiddenWorkspacePresets.has(key);
		if (hidden === wasHidden) {
			return;
		}
		if (hidden) {
			this._locallyHiddenWorkspacePresets.add(key);
		} else {
			this._locallyHiddenWorkspacePresets.delete(key);
		}
		this._writeLocallyHiddenWorkspacePresets();
		this._reapplyLocallyHidden();
		this._onDidChangePresets.fire();
	}

	// --- フォルダ・一括操作 ------------------------------------------------------------------------

	/** 対象プリセットを、保存先（user / 各 .paracode.json）ごとに束ねる。ワークスペース由来のみ。 */
	private _groupByWorkspaceFile(presets: readonly IParadisResolvedPreset[]): readonly { uri: URI; targets: IParadisResolvedPreset[] }[] {
		const byFile = new Map<string, { uri: URI; targets: IParadisResolvedPreset[] }>();
		for (const preset of presets) {
			if (preset.source !== 'workspace' || !preset.sourceUri) {
				continue;
			}
			const key = preset.sourceUri.toString();
			const bucket = byFile.get(key);
			if (bucket) {
				bucket.targets.push(preset);
			} else {
				byFile.set(key, { uri: preset.sourceUri, targets: [preset] });
			}
		}
		return [...byFile.values()];
	}

	private async _readWorkspacePresetsFile(presetFile: URI): Promise<{ parsed: { presets?: unknown[];[key: string]: unknown }; list: unknown[] }> {
		let parsed: { presets?: unknown[];[key: string]: unknown } = {};
		try {
			const content = await this.fileService.readFile(presetFile);
			parsed = parseJsonc<typeof parsed>(content.value.toString()) ?? {};
		} catch {
			// ファイルが無ければ対象も見つからないので、呼び出し側の _requirePresetIndex が例外にする
		}
		return { parsed, list: Array.isArray(parsed.presets) ? [...parsed.presets] : [] };
	}

	/**
	 * 指定位置の定義を返す。無効な内容（手編集で壊れた等）なら対象を見失ったのと同様に扱う。
	 * `_requirePresetIndex` が返す位置は常にここを通す——「見失ったら別の何かにフォールバックする」
	 * 経路を作らない（.paracode.json へ実装都合の値を書き込んでしまう事故を避けるため）。
	 */
	private _requireDefinitionAt(list: readonly unknown[], index: number): IParadisPresetDefinition {
		const current = list[index];
		if (!isValidPresetDefinition(current)) {
			throw new Error(STR_PRESET_GONE);
		}
		return current;
	}

	/**
	 * 複数プリセットへ folder ラベルをまとめて設定する。フォルダへの移動・フォルダから出す・
	 * フォルダ名の変更（既存メンバー全員へ新しい名前を書き戻す）のいずれもこれ1つで表せる。
	 *
	 * 対象が複数の定義元ファイル（ユーザー設定・複数リポジトリの .paracode.json）にまたがるとき、
	 * 先に全ファイル・全対象の位置を解決しきってから書き込みに入る。1つでも対象を見失っていたら
	 * どのファイルにも一切書き込まない——「対象を見失っている」ことが理由で一部だけ書き換わった
	 * 状態になるのを防ぐ。ただし書き込みフェーズ自体（ディスクI/O）が2ファイル目以降で失敗する
	 * （権限が無い等）ケースまでは防げない——その場合は先に書けたファイルまでは適用済みになる。
	 */
	async setPresetsFolder(presets: readonly IParadisResolvedPreset[], folder: string | undefined): Promise<void> {
		const normalized = folder?.trim() || undefined;
		const apply = (definition: IParadisPresetDefinition): IParadisPresetDefinition => ({ ...definition, folder: normalized });

		const userTargets = presets.filter(preset => preset.source === 'user');
		const userRaw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
		const userList: unknown[] = Array.isArray(userRaw) ? [...userRaw] : [];
		const userIndices = userTargets.map(target => this._requirePresetIndex(userList, target));

		const workspacePlans: { readonly uri: URI; readonly parsed: { presets?: unknown[];[key: string]: unknown }; readonly list: unknown[]; readonly indices: readonly number[] }[] = [];
		for (const { uri, targets } of this._groupByWorkspaceFile(presets)) {
			const { parsed, list } = await this._readWorkspacePresetsFile(uri);
			workspacePlans.push({ uri, parsed, list, indices: targets.map(target => this._requirePresetIndex(list, target)) });
		}

		// ここまで到達すれば、どのファイルも対象を見失っていない。実際の書き込みへ進む。
		if (userTargets.length > 0) {
			for (const index of userIndices) {
				userList[index] = apply(this._requireDefinitionAt(userList, index));
			}
			await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, userList, {}, ConfigurationTarget.USER, { donotNotifyError: false });
		}
		for (const plan of workspacePlans) {
			for (const index of plan.indices) {
				plan.list[index] = apply(this._requireDefinitionAt(plan.list, index));
			}
			plan.parsed.presets = plan.list;
			await this.fileService.writeFile(plan.uri, VSBuffer.fromString(JSON.stringify(plan.parsed, null, '\t') + '\n'));
			// _watchFolder の RunOnceScheduler（最大300ms）による再読込を待たず、この場でキャッシュを
			// 書き込んだ内容に更新する——待つと、直後に this.presets / this.folders を読む呼び出し元
			// （ゴースト空フォルダの掃除など）が古い内容のまま判定してしまう。
			const workspaceFolder = this._workspaceFolderForPresetFile(plan.uri);
			if (workspaceFolder) {
				this._workspacePresets.set(workspaceFolder.uri.toString(), this._parseWorkspacePresets(plan.list, plan.uri));
			}
		}
		if (workspacePlans.length > 0) {
			this._onDidChangePresets.fire();
		}
	}

	/**
	 * 複数プリセットをまとめて削除する。{@link setPresetsFolder} と同じく、先に全ファイル・
	 * 全対象の位置を解決しきってから削除に入る（部分適用を避けるため）。同じ対象が重複して
	 * 渡されても、位置の重複を取り除いてから消すので巻き添えは起きない。
	 */
	async deletePresets(presets: readonly IParadisResolvedPreset[]): Promise<void> {
		const userTargets = presets.filter(preset => preset.source === 'user');
		const userRaw = this.configurationService.getValue<unknown>(PARADIS_PRESETS_SETTING);
		const userList: unknown[] = Array.isArray(userRaw) ? [...userRaw] : [];
		// 位置の重複を取り除いたうえで、大きい位置から順に取り除く。小さい位置から消すと、
		// 後続対象の位置がずれて別のプリセットを巻き込む。
		const userIndices = [...new Set(userTargets.map(target => this._requirePresetIndex(userList, target)))].sort((a, b) => b - a);

		const workspacePlans: { readonly uri: URI; readonly parsed: { presets?: unknown[];[key: string]: unknown }; readonly list: unknown[]; readonly indices: readonly number[] }[] = [];
		for (const { uri, targets } of this._groupByWorkspaceFile(presets)) {
			const { parsed, list } = await this._readWorkspacePresetsFile(uri);
			const indices = [...new Set(targets.map(target => this._requirePresetIndex(list, target)))].sort((a, b) => b - a);
			workspacePlans.push({ uri, parsed, list, indices });
		}

		if (userTargets.length > 0) {
			for (const index of userIndices) {
				userList.splice(index, 1);
			}
			await this.configurationService.updateValue(PARADIS_PRESETS_SETTING, userList, {}, ConfigurationTarget.USER, { donotNotifyError: false });
		}
		for (const plan of workspacePlans) {
			for (const index of plan.indices) {
				plan.list.splice(index, 1);
			}
			plan.parsed.presets = plan.list;
			await this.fileService.writeFile(plan.uri, VSBuffer.fromString(JSON.stringify(plan.parsed, null, '\t') + '\n'));
			// setPresetsFolder と同じ理由で、watcher の再読込（最大300ms）を待たずキャッシュを
			// 直接更新する。呼び出し側（フォルダ削除の「中身ごと削除」等）がこの直後に
			// this.presets / this.folders を読んで判定するため、待つと古い内容のまま見えてしまう。
			const workspaceFolder = this._workspaceFolderForPresetFile(plan.uri);
			if (workspaceFolder) {
				this._workspacePresets.set(workspaceFolder.uri.toString(), this._parseWorkspacePresets(plan.list, plan.uri));
			}
		}
		if (workspacePlans.length > 0) {
			this._onDidChangePresets.fire();
		}
	}

	/**
	 * 空フォルダを台帳へ追加する。既に同名のフォルダ（台帳・実プリセットのいずれか）があれば
	 * 何もしない——重複したフォルダ名が一覧に並ぶと、どちらへプリセットを移すべきか分からなくなる。
	 * 戻り値は実際に作成したかどうか（呼び出し側は false のとき「無言の成功」に見えないよう、
	 * 名前が重複している旨をユーザーへ伝えること）。
	 */
	async createFolder(name: string, target: ParadisPresetSource): Promise<boolean> {
		const normalized = name.trim();
		if (!normalized) {
			return false;
		}
		const presets = this.presets;
		if (paradisAllFolderNames(presets, this._foldersFor(presets)).includes(normalized)) {
			return false;
		}
		if (target === 'user') {
			const raw = this.configurationService.getValue<unknown>(PARADIS_PRESET_FOLDERS_SETTING);
			const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
			list.push(normalized);
			await this.configurationService.updateValue(PARADIS_PRESET_FOLDERS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
			// user 側は configurationService.onDidChangeConfiguration 経由で別途 fire() される
			// （下の明示 fire() と合わせると二重発火になるが、_onDidChangePresets の購読側は
			// 再描画するだけの冪等な処理なので実害は軽微）。
		} else {
			const workspaceFolder = this.contextService.getWorkspace().folders[0];
			if (!workspaceFolder) {
				throw new Error('No workspace folder is open.');
			}
			const presetFile = joinPath(workspaceFolder.uri, PARADIS_WORKSPACE_PRESET_FILE);
			let parsed: { presets?: unknown[]; presetFolders?: unknown[];[key: string]: unknown } = {};
			try {
				const content = await this.fileService.readFile(presetFile);
				parsed = parseJsonc<typeof parsed>(content.value.toString()) ?? {};
			} catch {
				// ファイルが無ければ新規作成
			}
			const list: unknown[] = Array.isArray(parsed.presetFolders) ? [...parsed.presetFolders] : [];
			list.push(normalized);
			parsed.presetFolders = list;
			await this.fileService.writeFile(presetFile, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
			// _watchFolder の RunOnceScheduler（最大300ms）による再読込を待たず、この場でキャッシュを
			// 書き込んだ内容に更新する——待つと「作ったのに一覧に出ない」ように見える。watcher 側の
			// 再読込は従来どおり走ってよい（結果的に同じ内容を読み直すだけで無害）。
			this._workspacePresetFolders.set(workspaceFolder.uri.toString(), this._parseWorkspacePresetFolders(list, presetFile));
		}
		// ファイル watcher / 設定変更イベント経由の再読込（最大 300ms）を待たず、ダイアログの
		// 操作結果をその場で反映する。
		this._onDidChangePresets.fire();
		return true;
	}

	/**
	 * 台帳から空フォルダを1件削除する。定義元ファイル内の位置を使う点は他の削除操作と同じだが、
	 * 見失っていても（並び替え・手編集等で位置がずれていても）例外にせず黙って何もしない——
	 * 空フォルダの削除はやり直しが効く軽い操作で、{@link movePreset} と同様に安全側へ倒す。
	 */
	async deleteFolder(folder: IParadisResolvedPresetFolder): Promise<void> {
		if (folder.source === 'user') {
			const raw = this.configurationService.getValue<unknown>(PARADIS_PRESET_FOLDERS_SETTING);
			const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
			const current = list[folder.sourceIndex];
			if (typeof current !== 'string' || current.trim() !== folder.name) {
				return;
			}
			list.splice(folder.sourceIndex, 1);
			await this.configurationService.updateValue(PARADIS_PRESET_FOLDERS_SETTING, list, {}, ConfigurationTarget.USER, { donotNotifyError: false });
			// user 側は configurationService.onDidChangeConfiguration 経由で別途 fire() される
			// （下の明示 fire() と合わせると二重発火になるが、_onDidChangePresets の購読側は
			// 再描画するだけの冪等な処理なので実害は軽微）。
		} else {
			if (!folder.sourceUri) {
				return;
			}
			let parsed: { presets?: unknown[]; presetFolders?: unknown[];[key: string]: unknown };
			try {
				const content = await this.fileService.readFile(folder.sourceUri);
				parsed = parseJsonc<typeof parsed>(content.value.toString()) ?? {};
			} catch {
				return;
			}
			const list: unknown[] = Array.isArray(parsed.presetFolders) ? [...parsed.presetFolders] : [];
			const current = list[folder.sourceIndex];
			if (typeof current !== 'string' || current.trim() !== folder.name) {
				return;
			}
			list.splice(folder.sourceIndex, 1);
			parsed.presetFolders = list;
			await this.fileService.writeFile(folder.sourceUri, VSBuffer.fromString(JSON.stringify(parsed, null, '\t') + '\n'));
			// createFolder と同じ理由で、watcher の再読込（最大300ms）を待たずキャッシュを直接更新する。
			const workspaceFolder = this._workspaceFolderForPresetFile(folder.sourceUri);
			if (workspaceFolder) {
				this._workspacePresetFolders.set(workspaceFolder.uri.toString(), this._parseWorkspacePresetFolders(list, folder.sourceUri));
			}
		}
		this._onDidChangePresets.fire();
	}

	// --- 実行 ------------------------------------------------------------------------------------

	/**
	 * ターミナルが今コマンドを実行中（busy）か。CommandDetection capability（shell integration）が
	 * 生えていれば executingCommand を信頼する——OS のプロセスツリーだけを見る hasChildProcesses は、
	 * powerlevel10k の gitstatusd のような常駐子プロセスを持つだけで true になり、shell integration
	 * が効いている環境でも常時 busy 判定になってしまう（smart レイアウトが実質「常に新規作成」に
	 * 堕落する）。capability 自体が存在しない（shell integration 非対応）場合にのみ
	 * hasChildProcesses へフォールバックする。
	 *
	 * 制限: shell integration が部分的にしか効かない環境（capability は生えるが executingCommand が
	 * 更新されない構成）では busy を見逃す可能性がある。
	 */
	private _isTerminalBusy(instance: ITerminalInstance): boolean {
		const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection) {
			return commandDetection.executingCommand !== undefined;
		}
		return instance.hasChildProcesses;
	}

	async runPreset(preset: IParadisResolvedPreset, options?: IParadisRunPresetOptions): Promise<void> {
		const { tasks, layout } = paradisGetPresetTasks(preset);
		if (tasks.length === 0) {
			return;
		}

		if (layout === 'current' || layout === 'smart') {
			// 全タスクのコマンドを連結してアクティブなターミナルへ送る（旧 current-terminal 相当）。
			const commands = tasks.flatMap(task => task.commands);
			const cwd = this._resolveCwd(preset, preset.cwd, options?.cwd);
			const active = options?.forceNewTerminal ? undefined : this.terminalService.activeInstance;
			// smart はアクティブなターミナルが busy なら新規作成に倒す。current は従来どおり busy でも再利用する。
			const busy = active !== undefined && layout === 'smart' && this._isTerminalBusy(active);
			let instance = busy ? undefined : active;
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

	/**
	 * cd に載せるパス。`URI.fsPath` は「手元の OS」の区切りで組み立てるので、SSH で繋いでいる
	 * ときのように pty が別 OS 上にあると、そのままでは通らない（Windows から Linux へ繋ぐと
	 * `\home\u\repo` になる）。upstream の `preparePathForShell` は URI を渡したときだけ同じ
	 * 補正をするが、こちらは文字列を渡す都合上ここで先に直しておく。
	 */
	private _pathForShell(instance: ITerminalInstance, uri: URI): string {
		const path = uri.fsPath;
		if (isWindows && instance.os !== OperatingSystem.Windows) {
			return path.replace(/\\/g, '/');
		}
		if (!isWindows && instance.os === OperatingSystem.Windows) {
			return path.replace(/\//g, '\\');
		}
		return path;
	}

	private async _buildChangeDirectoryCommand(instance: ITerminalInstance, cwd: URI): Promise<string> {
		const path = this._pathForShell(instance, cwd);
		if (instance.shellType === GeneralShellType.PowerShell) {
			return `Set-Location -LiteralPath '${path.replace(/'/g, '$&$&')}'`;
		}
		if (instance.shellType === WindowsShellType.CommandPrompt) {
			return `cd /d "${path.replace(/"/g, '""')}"`;
		}
		return `cd ${await instance.preparePathForShell(path)}`;
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
