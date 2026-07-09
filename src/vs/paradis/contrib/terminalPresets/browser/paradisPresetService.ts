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
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { editorGroupToColumn } from '../../../../workbench/services/editor/common/editorGroupColumn.js';
import { GroupDirection, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import {
	IParadisPresetDefinition,
	IParadisPresetService,
	IParadisResolvedPreset,
	IParadisRunPresetOptions,
	isValidPresetDefinition,
	PARADIS_PRESETS_SETTING,
	PARADIS_WORKSPACE_PRESET_FILE,
	ParadisPresetSource,
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
		const commands = preset.commands.map(command => command.trim()).filter(command => command.length > 0);
		if (commands.length === 0) {
			return;
		}
		const cwd = this._resolveCwd(preset, options?.cwd);
		const joined = commands.join(' && ');
		const mode = preset.launchMode ?? 'new-terminal';

		switch (mode) {
			case 'current-terminal': {
				let instance = options?.forceNewTerminal ? undefined : this.terminalService.activeInstance;
				if (!instance) {
					instance = await this._createTerminalInActiveGroup(cwd);
					options?.onDidStart?.();
					await instance.sendText(joined, true);
				} else {
					if (preset.cwd && cwd) {
						// 既存ターミナルは作業ディレクトリが不明なので cd を前置する
						await instance.sendText(`cd ${await instance.preparePathForShell(cwd.fsPath)} && ${joined}`, true);
					} else {
						await instance.sendText(joined, true);
					}
					options?.onDidStart?.();
				}
				instance.focus(true);
				break;
			}
			case 'new-terminal': {
				const instance = await this._createTerminalInActiveGroup(cwd);
				options?.onDidStart?.();
				instance.focus(true);
				await instance.sendText(joined, true);
				break;
			}
			case 'new-terminal-each': {
				let first: ITerminalInstance | undefined;
				for (const command of commands) {
					const instance = await this._createTerminalInActiveGroup(cwd);
					options?.onDidStart?.();
					first ??= instance;
					await instance.sendText(command, true);
				}
				first?.focus(true);
				break;
			}
			case 'split': {
				// 先頭はアクティブグループ、以降は右→下の交互にグループを分割して並べる
				let group = this.editorGroupsService.activeGroup;
				for (let index = 0; index < commands.length; index++) {
					if (index > 0) {
						group = this.editorGroupsService.addGroup(group, index % 2 === 1 ? GroupDirection.RIGHT : GroupDirection.DOWN);
					}
					const instance = await this.terminalService.createTerminal({
						cwd,
						location: { viewColumn: editorGroupToColumn(this.editorGroupsService, group) },
					});
					options?.onDidStart?.();
					await instance.sendText(commands[index], true);
				}
				break;
			}
		}
	}

	private _resolveCwd(preset: IParadisResolvedPreset, baseOverride?: URI): URI | undefined {
		const cwd = preset.cwd?.trim();
		if (cwd && isAbsolute(cwd)) {
			return URI.file(cwd);
		}
		// 明示された基準 (worktree 作成直後など、フォルダ反映を待てない場面) を最優先する
		if (baseOverride) {
			return cwd ? joinPath(baseOverride, cwd.replace(/^\.\//, '')) : baseOverride;
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
		return folder.toResource(cwd.replace(/^\.\//, ''));
	}

	private async _createTerminalInActiveGroup(cwd: URI | undefined): Promise<ITerminalInstance> {
		return this.terminalService.createTerminal({
			cwd,
			location: { viewColumn: editorGroupToColumn(this.editorGroupsService, this.editorGroupsService.activeGroup) },
		});
	}
}
