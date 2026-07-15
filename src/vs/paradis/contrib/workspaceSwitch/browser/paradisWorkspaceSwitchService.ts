/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Sequencer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorGroupsService, IEditorWorkingSet } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { ITerminalEditorService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, isParadisManagedWorkspaceWindow, markParadisManagedWorkspaceWindow, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { paradisParkTerminalEditorInstance, paradisRetireParkedTerminalEditorInstances } from './paradisTerminalEditorPark.js';

interface ISerializedRepository {
	readonly id: string;
	readonly name: string;
	readonly uri: string;
	readonly color?: string;
}

interface ISerializedWorkingSetEntry {
	/** 状態キー (リポジトリID or worktree キー)。歴史的経緯でフィールド名は repositoryId */
	readonly repositoryId: string;
	readonly workingSet: IEditorWorkingSet;
}

interface ISerializedActiveEntry {
	readonly stateKey: string;
	readonly uri: string;
}

/**
 * Applies a same-folder state-key correction and emits a stable scope switch only when the
 * effective key changed. Extracted so the URI fast path cannot silently skip scope consumers.
 */
export function paradisApplySameUriScopeCorrection(
	previousStateKey: string | undefined,
	nextStateKey: string,
	setActiveEntry: () => void,
	onDidSwitchScope: (stateKey: string) => void,
	markManagedWorkspaceWindow: () => void,
): void {
	// The fast path returns before folder mutation, so it must establish the same durable
	// managed-window identity explicitly rather than relying on updateFolders side effects.
	markManagedWorkspaceWindow();
	setActiveEntry();
	if (previousStateKey !== nextStateKey) {
		onDidSwitchScope(nextStateKey);
	}
}

/**
 * IParadisWorkspaceSwitchService の実装。
 *
 * リポジトリ登録リストは WORKSPACE スコープの storage に永続化する。workspace id は
 * .code-workspace の configPath のみから決まり folders 非依存 (workspaces.ts の
 * "IDENTIFIERS HAVE TO REMAIN STABLE" 参照) なので、folders を何度入れ替えても
 * 同じリストが読める。切り替えは updateFolders による folders の全入れ替えで行い、
 * Explorer / Git / tasks / debug は upstream の onDidChangeWorkspaceFolders 追従に任せる。
 */
export class ParadisWorkspaceSwitchService extends Disposable implements IParadisWorkspaceSwitchService {

	declare readonly _serviceBrand: undefined;

	private static readonly REPOSITORIES_STORAGE_KEY = 'paradis.workspaceSwitch.repositories';
	private static readonly WORKING_SETS_STORAGE_KEY = 'paradis.workspaceSwitch.workingSets';
	private static readonly ACTIVE_ENTRY_STORAGE_KEY = 'paradis.workspaceSwitch.activeEntry';

	private readonly _onDidChangeRepositories = this._register(new Emitter<void>());
	readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

	private readonly _onDidRetireScope = this._register(new Emitter<string>());
	readonly onDidRetireScope = this._onDidRetireScope.event;

	private readonly _onWillSwitchScope = this._register(new Emitter<string | undefined>());
	readonly onWillSwitchScope = this._onWillSwitchScope.event;

	private readonly _onDidSwitchScope = this._register(new Emitter<string>());
	readonly onDidSwitchScope = this._onDidSwitchScope.event;

	private readonly _repositories: IParadisWorkspaceRepository[];

	/**
	 * リポジトリID → エディタ working set ハンドル。working set の実体 (グループレイアウト +
	 * シリアライズされたエディタ入力) は EditorParts が WORKSPACE スコープ storage に永続化する
	 * ('editor.workingSets')。ここではリポジトリとの対応だけを自前キーで永続化する。
	 */
	private readonly _workingSets = new Map<string, IEditorWorkingSet>();

	/** 切り替え処理の直列化 (連打時に退避と復元が交錯して状態が壊れるのを防ぐ) */
	private readonly _switchSequencer = new Sequencer();

	private _switching = false;
	get isSwitching(): boolean {
		return this._switching;
	}

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
	) {
		super();

		this._repositories = this.loadRepositories();
		this.loadWorkingSets();
		this._activeEntry = this.loadActiveEntry();

		// リロード後も relauncher 側の再起動抑止を効かせる。登録済みリポジトリが
		// 読めた時点でこのウィンドウは Para Code 管理下のワークスペースと判断できる
		// (登録は switchRepository と同様マルチルート状態でのみ許可しているため)。
		if (this._repositories.length > 0 && this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
			markParadisManagedWorkspaceWindow();
		}
	}

	get repositories(): readonly IParadisWorkspaceRepository[] {
		return this._repositories;
	}

	get isManagedWorkspaceWindow(): boolean {
		return isParadisManagedWorkspaceWindow();
	}

	/** 直近の切り替えで記録したアクティブエントリ (folders が一致する間だけ有効) */
	private _activeEntry: ISerializedActiveEntry | undefined;

	get activeStateKey(): string | undefined {
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length !== 1) {
			return undefined;
		}

		// 切り替えサービス経由で記録したエントリが現在の folders と一致していればそれを使う
		// (worktree は登録リストに居ないため folders からは導出できない)
		if (this._activeEntry && isEqual(URI.parse(this._activeEntry.uri), folders[0].uri)) {
			return this._activeEntry.stateKey;
		}

		return this._repositories.find(repository => isEqual(repository.uri, folders[0].uri))?.id;
	}

	get activeRepository(): IParadisWorkspaceRepository | undefined {
		const stateKey = this.activeStateKey;
		return stateKey !== undefined ? this._repositories.find(repository => repository.id === stateKey) : undefined;
	}

	async addRepository(uri: URI, name?: string): Promise<IParadisWorkspaceRepository> {
		this.ensureMultiRootWorkspace();

		const existing = this._repositories.find(repository => isEqual(repository.uri, uri));
		if (existing) {
			return existing;
		}

		// 切り替え先が未信頼だと Restricted Mode 化して拡張機能が制限されるため、
		// 登録時点で信頼済みにしておく (ユーザー自身が明示的に追加したリポジトリリストなので妥当)。
		await this.trustUris(uri);

		const repository: IParadisWorkspaceRepository = {
			id: generateUuid(),
			name: name ?? basename(uri),
			uri
		};
		this._repositories.push(repository);
		this.saveRepositories();
		this._onDidChangeRepositories.fire();

		return repository;
	}

	async removeRepository(id: string): Promise<void> {
		const index = this._repositories.findIndex(repository => repository.id === id);
		if (index === -1) {
			return;
		}

		this._repositories.splice(index, 1);
		this.saveRepositories();
		this.discardScopeState(id);
		this._onDidChangeRepositories.fire();
	}

	discardScopeState(stateKey: string): void {
		this.deleteWorkingSetFor(stateKey);
		this._panelVisibility.delete(stateKey);
		// この scope の working set に載っていたエディタターミナルは park 台帳に生き続けている。
		// working set を消すと二度と revive されず PTY/xterm が孤児化するため、ここで実体ごと破棄する。
		// パネルグループの retireScope (onDidRetireScope 購読) と対をなすエディタ側の掃除。
		paradisRetireParkedTerminalEditorInstances(stateKey);
		this._onDidRetireScope.fire(stateKey);
	}

	async renameRepository(id: string, name: string): Promise<void> {
		this.updateRepository(id, repository => ({ ...repository, name }));
	}

	async setRepositoryColor(id: string, color: string | undefined): Promise<void> {
		this.updateRepository(id, repository => ({ ...repository, color }));
	}

	private updateRepository(id: string, update: (repository: IParadisWorkspaceRepository) => IParadisWorkspaceRepository): void {
		const index = this._repositories.findIndex(repository => repository.id === id);
		if (index === -1) {
			return;
		}

		this._repositories[index] = update(this._repositories[index]);
		this.saveRepositories();
		this._onDidChangeRepositories.fire();
	}

	async switchRepository(id: string): Promise<void> {
		const repository = this._repositories.find(candidate => candidate.id === id);
		if (!repository) {
			throw new Error(`Unknown Para Code repository: ${id}`);
		}

		return this.switchToTarget(repository.id, repository.uri);
	}

	async switchToWorktree(worktree: IParadisWorktree): Promise<void> {
		if (worktree.missing) {
			throw new Error(`Para Code worktree is missing on disk: ${worktree.uri.fsPath}`);
		}

		return this.switchToTarget(paradisWorktreeStateKey(worktree.uri), worktree.uri);
	}

	private switchToTarget(stateKey: string, uri: URI): Promise<void> {
		this.ensureMultiRootWorkspace();

		return this._switchSequencer.queue(async () => {
			const previousKey = this.activeStateKey;
			const folders = this.contextService.getWorkspace().folders;
			if (folders.length === 1 && isEqual(folders[0].uri, uri)) {
				paradisApplySameUriScopeCorrection(
					previousKey,
					stateKey,
					() => this.setActiveEntry(stateKey, uri),
					correctedStateKey => this._onDidSwitchScope.fire(correctedStateKey),
					markParadisManagedWorkspaceWindow,
				);
				return;
			}

			// updateFolders で folders[0] が変わる前に必ずフラグを立てる。
			// relauncher の RunOnceScheduler はフォルダ変更の 10ms 後に発火するため、
			// ここで立てておけば発火時点で確実にスキップされる。
			markParadisManagedWorkspaceWindow();

			this._switching = true;
			let completed = false;
			try {
				this._onWillSwitchScope.fire(previousKey);

				// 切り替え元のエディタ状態 (レイアウト + タブ集合) とパネル表示状態を退避する
				if (previousKey !== undefined) {
					this.saveWorkingSetFor(previousKey);
					this.savePanelVisibilityFor(previousKey);

					// エディタターミナルは working set の保存後・適用前にインスタンスを input から
					// 切り離して生かしたままパークする。切り離さないと applyWorkingSet のエディタ close で
					// PTY ごと破棄され、戻ってきた際に死んだ pty への再接続で壊れたターミナルが復元される
					// (詳細は paradisTerminalEditorPark.ts のコメント参照)。working set を保存して
					// いない場合 (previousKey なし) は復元先が無くインスタンスが孤児化するためパークしない。
					for (const instance of [...this.terminalEditorService.instances]) {
						if (paradisParkTerminalEditorInstance(instance, previousKey)) {
							this.terminalEditorService.detachInstance(instance);
						}
					}
				}

				// エディタの入れ替えは updateFolders より先に行う。Git 拡張はフォルダ削除時、
				// 「可視エディタが使用中のリポジトリ」を close しない (extensions/git/src/model.ts の
				// onDidChangeWorkspaceFolders)。updateFolders を先にすると旧リポジトリのエディタが
				// まだ開いているため SCM にリポジトリが残留してスコープが漏れる。
				// dirty なエディタは upstream の applyWorkingSet 仕様により閉じられず
				// 切り替え先レイアウトへ持ち越される (excludeConfirming、確認ダイアログは出ない)。
				await this.applyWorkingSetFor(stateKey);

				await this.trustUris(uri);
				await this.workspaceEditingService.updateFolders(0, folders.length, [{ uri }]);

				this.setActiveEntry(stateKey, uri);
				this.restorePanelVisibilityFor(stateKey);
				completed = true;
			} finally {
				this._switching = false;

				// 完了時は切り替え先スコープへ、途中で例外が起きた場合は元スコープへ発火する。
				// onWillSwitchScope で退避済みの状態 (SCM入力の下書き・park済みターミナル) は
				// onDidSwitchScope を受け皿として復元されるため、失敗時に発火しないと迷子のまま残る
				const restoreKey = completed ? stateKey : previousKey;
				if (restoreKey !== undefined) {
					this._onDidSwitchScope.fire(restoreKey);
				}
			}
		});
	}

	private setActiveEntry(stateKey: string, uri: URI): void {
		this._activeEntry = { stateKey, uri: uri.toString() };
		this.storageService.store(ParadisWorkspaceSwitchService.ACTIVE_ENTRY_STORAGE_KEY, JSON.stringify(this._activeEntry), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private loadActiveEntry(): ISerializedActiveEntry | undefined {
		const raw = this.storageService.get(ParadisWorkspaceSwitchService.ACTIVE_ENTRY_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	private saveWorkingSetFor(stateKey: string): void {
		// 同一エントリの古い working set は捨てて常に最新の1つだけ持つ
		// (EditorParts 側の 'editor.workingSets' ストレージを無限に肥やさないため)
		this.deleteWorkingSetFor(stateKey);

		if (this.editorService.visibleEditors.length > 0) {
			const workingSet = this.editorGroupsService.saveWorkingSet(`paradis-workspace:${stateKey}`);
			this._workingSets.set(stateKey, workingSet);
		}
		this.saveWorkingSets();
	}

	private async applyWorkingSetFor(stateKey: string): Promise<void> {
		const workingSet = this._workingSets.get(stateKey);

		let applied = false;
		if (workingSet) {
			applied = await this.editorGroupsService.applyWorkingSet(workingSet, { preserveFocus: false });
		}
		if (!applied) {
			// working set が無い (初訪問) か、ハンドルが失効している場合は空状態から始める
			await this.editorGroupsService.applyWorkingSet('empty', { preserveFocus: false });
		}
	}

	/** 状態キー → パネル(ターミナル等)の表示状態。切り替えを跨いでパネル開閉を保つ */
	private readonly _panelVisibility = new Map<string, boolean>();

	private savePanelVisibilityFor(stateKey: string): void {
		this._panelVisibility.set(stateKey, this.layoutService.isVisible(Parts.PANEL_PART));
	}

	private restorePanelVisibilityFor(stateKey: string): void {
		const visible = this._panelVisibility.get(stateKey);
		if (visible !== undefined) {
			this.layoutService.setPartHidden(!visible, Parts.PANEL_PART);
		}
	}

	private deleteWorkingSetFor(repositoryId: string): void {
		const existing = this._workingSets.get(repositoryId);
		if (!existing) {
			return;
		}

		this.editorGroupsService.deleteWorkingSet(existing);
		this._workingSets.delete(repositoryId);
		this.saveWorkingSets();
	}

	/**
	 * 対象リポジトリと .code-workspace ファイルの場所を信頼済みにする。
	 * マルチルートワークスペースの信頼判定は「全フォルダ + ワークスペース設定ファイル自体」
	 * (workspaceTrust.ts の getWorkspaceUris) なので、リポジトリだけ信頼しても
	 * .code-workspace の場所が未信頼だと Restricted Mode のままになる。
	 */
	private async trustUris(repositoryUri: URI): Promise<void> {
		const urisToTrust = [repositoryUri];
		const configuration = this.contextService.getWorkspace().configuration;
		if (configuration) {
			urisToTrust.push(dirname(configuration));
		}
		await this.workspaceTrustManagementService.setUrisTrust(urisToTrust, true);
	}

	/**
	 * マルチルート (WORKSPACE) 状態であることを保証する。単一フォルダ / empty 状態から
	 * updateFolders を呼ぶと upstream の createAndEnterWorkspace が新規 untitled workspace
	 * (= 新しい workspace id = 別の WORKSPACE storage) を作ってしまい、状態共有の前提が壊れるため。
	 */
	private ensureMultiRootWorkspace(): void {
		if (this.contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			throw new Error('Para Code workspace switching requires a multi-root workspace');
		}
	}

	private loadRepositories(): IParadisWorkspaceRepository[] {
		const raw = this.storageService.get(ParadisWorkspaceSwitchService.REPOSITORIES_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return [];
		}

		try {
			const serialized: ISerializedRepository[] = JSON.parse(raw);
			return serialized.map(repository => ({
				id: repository.id,
				name: repository.name,
				uri: URI.parse(repository.uri),
				color: repository.color
			}));
		} catch {
			return [];
		}
	}

	private saveRepositories(): void {
		const serialized: ISerializedRepository[] = this._repositories.map(repository => ({
			id: repository.id,
			name: repository.name,
			uri: repository.uri.toString(),
			color: repository.color
		}));
		this.storageService.store(ParadisWorkspaceSwitchService.REPOSITORIES_STORAGE_KEY, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private loadWorkingSets(): void {
		const raw = this.storageService.get(ParadisWorkspaceSwitchService.WORKING_SETS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}

		try {
			const serialized: ISerializedWorkingSetEntry[] = JSON.parse(raw);
			for (const entry of serialized) {
				this._workingSets.set(entry.repositoryId, entry.workingSet);
			}
		} catch {
			// 壊れたデータは無視 (次の切り替えで作り直される)
		}
	}

	private saveWorkingSets(): void {
		const serialized: ISerializedWorkingSetEntry[] = [];
		for (const [repositoryId, workingSet] of this._workingSets) {
			serialized.push({ repositoryId, workingSet });
		}
		this.storageService.store(ParadisWorkspaceSwitchService.WORKING_SETS_STORAGE_KEY, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
