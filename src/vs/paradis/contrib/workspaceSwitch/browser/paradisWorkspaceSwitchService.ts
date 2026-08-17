/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Sequencer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { basename, dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroupsService, IEditorWorkingSet } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { ITerminalEditorService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAuxiliaryWindowScopeService, IParadisSwitchOptions, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, isParadisManagedWorkspaceWindow, markParadisManagedWorkspaceWindow, PARADIS_WORKSPACE_ACTIVE_ENTRY_STORAGE_KEY, PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import { IParadisEditorScopeService } from '../common/paradisEditorScope.js';
import { ParadisScopeRetirementJournal, ParadisScopeRetirementJournalLoadState } from '../common/paradisScopeRetirementJournal.js';
import { paradisApplyDesiredOrder } from '../common/paradisWorkspaceTreeState.js';
import { paradisAreAllParkedForScope, paradisParkTerminalEditorInstance, paradisRetireParkedTerminalEditorInstances } from './paradisTerminalEditorPark.js';
import { paradisTerminalIdentityNonce } from '../../mobileRelay/common/paradisTerminalPersistence.js';
import { paradisClearTerminalReviveIndex, paradisRefreshTerminalReviveIndex } from './paradisTerminalEditorRevive.js';
import { runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisClearVerifiedWorkspaceFolders, paradisMarkVerifiedWorkspaceFolder, paradisTakeVerifiedWorkspaceFolderHits } from '../common/paradisWorkspaceFolderVerification.js';
import { IFileService } from '../../../../platform/files/common/files.js';

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
	/**
	 * この working set を保存した時点で開いていたターミナルエディタの数。
	 *
	 * 復元時に孤児 PTY の索引を引く必要があるかの判定にだけ使う。**古いデータには無い**ので、
	 * 欠けている場合は「いるかもしれない」として索引を引く側（従来どおり）に倒すこと。
	 */
	readonly terminalEditors?: number;
}

interface ISerializedActiveEntry {
	readonly stateKey: string;
	readonly uri: string;
}

/**
 * Applies a same-folder state-key correction and emits a stable scope switch only when the
 * effective key changed. Extracted so the URI fast path cannot silently skip scope consumers.
 */
export async function paradisApplySameUriScopeCorrection(
	previousStateKey: string | undefined,
	nextStateKey: string,
	setActiveEntry: () => void,
	onDidSwitchScope: (stateKey: string) => void,
	markManagedWorkspaceWindow: () => void,
	beforeEmit: () => Promise<void> = async () => { },
): Promise<void> {
	// The fast path returns before folder mutation, so it must establish the same durable
	// managed-window identity explicitly rather than relying on updateFolders side effects.
	markManagedWorkspaceWindow();
	setActiveEntry();
	await beforeEmit();
	if (previousStateKey !== nextStateKey) {
		onDidSwitchScope(nextStateKey);
	}
}

/** Runs every phase even when an earlier phase fails. */
export async function paradisRunBestEffortPhases(
	steps: readonly (() => void | Promise<void>)[],
	onError: (error: unknown) => void,
): Promise<void> {
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			onError(error);
		}
	}
}

/**
 * Commits data-bearing editor retirement before any irreversible window/UI cleanup.
 * Once editor retirement succeeds, cleanup is failureless from the caller's point of
 * view: every phase runs and a transient UI failure cannot turn a committed discard
 * into a misleading rollback.
 */
export async function paradisCommitPreparedScopeRetirement(
	retireEditors: () => Promise<boolean>,
	finalize: readonly (() => void | Promise<void>)[],
	onError: (error: unknown) => void,
): Promise<boolean> {
	if (!await retireEditors()) {
		return false;
	}
	await paradisRunBestEffortPhases(finalize, onError);
	return true;
}

/**
 * A prepared retirement can have detached editors from the main part. If the
 * repository removal switched to a fallback first, restore that source scope
 * before cancelling; otherwise those editors would leak into the fallback.
 * On rollback failure the prepared retention intentionally stays alive.
 */
export async function paradisCancelRetirementAfterScopeRollback(
	retirementSourceStateKey: string | undefined,
	currentStateKey: string | undefined,
	switchBack: (stateKey: string) => Promise<void>,
	cancelRetirement: () => Promise<void>,
	onError: (error: unknown) => void,
): Promise<boolean> {
	if (retirementSourceStateKey !== undefined && currentStateKey !== retirementSourceStateKey) {
		try {
			await switchBack(retirementSourceStateKey);
		} catch (error) {
			onError(error);
			return false;
		}
	}
	try {
		await cancelRetirement();
		return true;
	} catch (error) {
		onError(error);
		return false;
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

	private static readonly WORKING_SETS_STORAGE_KEY = 'paradis.workspaceSwitch.workingSets';
	private static readonly RETIREMENT_JOURNAL_STORAGE_KEY = 'paradis.workspaceSwitch.scopeRetirementJournal';

	private readonly _onDidChangeRepositories = this._register(new Emitter<void>());
	readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

	private readonly _onDidRetireScope = this._register(new Emitter<string>());
	readonly onDidRetireScope = this._onDidRetireScope.event;

	private readonly _onWillSwitchScope = this._register(new Emitter<string | undefined>());
	readonly onWillSwitchScope = this._onWillSwitchScope.event;

	private readonly _onDidSwitchScope = this._register(new Emitter<string>());
	readonly onDidSwitchScope = this._onDidSwitchScope.event;
	private readonly _switchCompletionParticipants = new Set<(stateKey: string) => void | Promise<void>>();

	private readonly _repositories: IParadisWorkspaceRepository[];
	private readonly retirementJournal: ParadisScopeRetirementJournal;
	private recoveredRepositoriesChanged = false;

	/**
	 * リポジトリID → エディタ working set ハンドル。working set の実体 (グループレイアウト +
	 * シリアライズされたエディタ入力) は EditorParts が WORKSPACE スコープ storage に永続化する
	 * ('editor.workingSets')。ここではリポジトリとの対応だけを自前キーで永続化する。
	 */
	private readonly _workingSets = new Map<string, IEditorWorkingSet>();
	/**
	 * working set を保存した時点のターミナルエディタ数。キーが無い＝不明で、索引を引く側に倒す。
	 * `_workingSets` と生死を揃えるため、保存・削除は必ず同じ場所で行うこと。
	 */
	private readonly _workingSetTerminals = new Map<string, number>();
	/**
	 * 直前にこの手でパークした端末の nonce（スコープごと）。**永続化しない**。
	 * 復元時に「その顔ぶれがそのまま台帳に残っているか」を名指しで確かめるために使う。
	 * 再起動後は空＝孤児索引を必ず引く側へ倒れる（世代跨ぎの復元は索引が唯一の防波堤）。
	 */
	private readonly _workingSetTerminalNonces = new Map<string, ReadonlySet<string>>();

	/** 切り替え処理の直列化 (連打時に退避と復元が交錯して状態が壊れるのを防ぐ) */
	private readonly _switchSequencer = new Sequencer();

	/**
	 * `coalesce` 付きの切り替え要求の世代。要求ごとに進み、実行開始時に自分の世代が最新でなければ
	 * その回を飛ばす（連打された中間スペースを経由しないため）。詳細は `switchToTarget`。
	 */
	private _coalesceGeneration = 0;

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
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IFileService private readonly fileService: IFileService,
		@IParadisEditorScopeService private readonly editorScopeService: IParadisEditorScopeService,
		@IParadisAuxiliaryWindowScopeService private readonly auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		@ILogService private readonly logService: ILogService,
		// スペース一覧を「今つながっている先のもの」だけに絞るために使う
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		this._repositories = this.loadRepositories();
		this.loadWorkingSets();
		this._activeEntry = this.loadActiveEntry();
		const loadedRetirementJournal = ParadisScopeRetirementJournal.load(
			this.storageService.get(ParadisWorkspaceSwitchService.RETIREMENT_JOURNAL_STORAGE_KEY, StorageScope.WORKSPACE)
		);
		this.retirementJournal = loadedRetirementJournal.journal;
		if (loadedRetirementJournal.state === ParadisScopeRetirementJournalLoadState.Corrupt) {
			this.logService.error('[ParadisWorkspaceSwitch] Scope retirement journal is corrupt; leaving registered scope state untouched');
		} else {
			try {
				this.recoverCommittedScopeRetirementCore();
			} catch (error) {
				this.logService.error('[ParadisWorkspaceSwitch] Failed to finalize committed scope retirement during startup', error);
			}
		}

		// リロード後も relauncher 側の再起動抑止を効かせる。登録済みリポジトリが
		// 読めた時点でこのウィンドウは Para Code 管理下のワークスペースと判断できる
		// (登録は switchRepository と同様マルチルート状態でのみ許可しているため)。
		if (this._repositories.length > 0 && this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
			markParadisManagedWorkspaceWindow();
		}
		this.auxiliaryWindowScopeService.setMainScope(this.activeStateKey, this.isManagedWorkspaceWindow, false);

		// 自分の枠を共有領域へ出しておく。保存はスペースを足し引きしたときにしか走らないので、
		// 開いただけで何も触らなかったウィンドウは相手側から「存在しない」ままになり、
		// 行き来しようとしても一覧に出てこない。
		if (this.isManagedWorkspaceWindow) {
			this.saveRepositories();
		}
	}

	get repositories(): readonly IParadisWorkspaceRepository[] {
		return this._repositories;
	}

	get isManagedWorkspaceWindow(): boolean {
		return isParadisManagedWorkspaceWindow();
	}

	get pendingCommittedRetirementStateKeys(): readonly string[] {
		return this.retirementJournal.pendingStateKeys;
	}

	registerSwitchCompletionParticipant(participant: (stateKey: string) => void | Promise<void>): IDisposable {
		this._switchCompletionParticipants.add(participant);
		return toDisposable(() => this._switchCompletionParticipants.delete(participant));
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

	async removeRepository(id: string, descendantStateKeys: readonly string[] = []): Promise<void> {
		const index = this._repositories.findIndex(repository => repository.id === id);
		if (index === -1) {
			return;
		}
		const retirementSourceStateKey = this.activeStateKey;
		const retirementStateKeys = [...new Set([id, ...descendantStateKeys])];
		const preparedStateKeys: string[] = [];
		const cancelPrepared = () => paradisRunBestEffortPhases(
			preparedStateKeys.map(stateKey => () => this.cancelScopeRetirement(stateKey)),
			error => this.logService.error('[ParadisWorkspaceSwitch] Failed to cancel prepared scope retirement', error)
		);
		const cancelPreparedAfterScopeRollback = () => paradisCancelRetirementAfterScopeRollback(
			retirementSourceStateKey,
			this.activeStateKey,
			stateKey => this.switchToStateKey(stateKey),
			cancelPrepared,
			error => this.logService.error('[ParadisWorkspaceSwitch] Failed to restore source scope before cancelling retirement', error)
		);
		try {
			for (const stateKey of retirementStateKeys) {
				if (!await this.prepareScopeRetirement(stateKey)) {
					await cancelPrepared();
					return;
				}
				preparedStateKeys.push(stateKey);
			}
		} catch (error) {
			await cancelPrepared();
			this.logService.error('[ParadisWorkspaceSwitch] Failed to prepare scope retirement transaction', error);
			return;
		}

		const removesActiveScope = this.activeStateKey !== undefined && retirementStateKeys.includes(this.activeStateKey);
		const fallbackRepository = removesActiveScope ? this._repositories.find(repository => repository.id !== id) : undefined;
		if (fallbackRepository) {
			try {
				await this.switchRepository(fallbackRepository.id);
			} catch (error) {
				await cancelPreparedAfterScopeRollback();
				throw error;
			}
		}

		if (!await this.discardScopeStates(preparedStateKeys, false, id)) {
			await cancelPreparedAfterScopeRollback();
			return;
		}
		const currentIndex = this._repositories.findIndex(repository => repository.id === id);
		if (currentIndex !== -1) {
			this._repositories.splice(currentIndex, 1);
			this.saveRepositories();
		}
		if (removesActiveScope && !fallbackRepository) {
			this.clearActiveEntry();
			await this.editorScopeService.leaveManagedWorkspace();
			this.auxiliaryWindowScopeService.setMainScope(undefined, false, false);
		}
		this._onDidChangeRepositories.fire();
		this.completeRepositoryRetirement(id);
	}

	hasScopeRetirementData(stateKey: string): Promise<boolean> {
		return this.editorScopeService.hasRetirementData(stateKey);
	}

	prepareScopeRetirement(stateKey: string): Promise<boolean> {
		return this.editorScopeService.prepareScopeRetirement(stateKey);
	}

	cancelScopeRetirement(stateKey: string): Promise<void> {
		return this.editorScopeService.cancelScopeRetirement(stateKey);
	}

	async discardScopeState(stateKey: string): Promise<boolean> {
		return this.discardScopeStates([stateKey]);
	}

	private async discardScopeStates(stateKeys: readonly string[], cancelOnFailure = true, repositoryId?: string): Promise<boolean> {
		const uniqueStateKeys = [...new Set(stateKeys)];
		let retirementTransactionId: string | undefined;
		const cancelPrepared = async () => {
			if (!cancelOnFailure) {
				return;
			}
			await paradisRunBestEffortPhases(
				uniqueStateKeys.map(stateKey => () => this.editorScopeService.cancelScopeRetirement(stateKey)),
				error => this.logService.error('[ParadisWorkspaceSwitch] Failed to cancel scope retirement', error)
			);
		};
		try {
			for (const stateKey of uniqueStateKeys) {
				if (!await this.editorScopeService.prepareScopeRetirement(stateKey)) {
					await cancelPrepared();
					return false;
				}
			}
			const finalize = uniqueStateKeys.flatMap(stateKey => [
				async () => {
					const closed = await this.auxiliaryWindowScopeService.closeScopeWindowsForRetirement(stateKey);
					// Even if a native window refuses to close, its deleted scope must no longer
					// own future editors, terminals, or backups.
					this.auxiliaryWindowScopeService.commitScopeRetirement(stateKey);
					if (!closed) {
						throw new Error(`Failed to close auxiliary editor window for retired scope: ${stateKey}`);
					}
				},
				() => this.deleteWorkingSetFor(stateKey),
				() => { this._panelVisibility.delete(stateKey); },
				// この scope の working set に載っていたエディタターミナルは park 台帳に生き続けている。
				// working set を消すと二度と revive されず PTY/xterm が孤児化するため、ここで実体ごと破棄する。
				// パネルグループの retireScope (onDidRetireScope 購読) と対をなすエディタ側の掃除。
				() => paradisRetireParkedTerminalEditorInstances(stateKey),
				() => { this._onDidRetireScope.fire(stateKey); },
			]);
			finalize.push(
				() => {
					if (retirementTransactionId !== undefined) {
						this.retirementJournal.completeEvents(retirementTransactionId);
						this.saveRetirementJournal();
					}
				},
				...uniqueStateKeys.map(stateKey => () => { this.editorScopeService.completeScopeRetirement(stateKey); })
			);
			if (!await paradisCommitPreparedScopeRetirement(
				async () => {
					const retired = await this.editorScopeService.retireScopes(uniqueStateKeys, () => {
						retirementTransactionId = this.stageScopeRetirement(uniqueStateKeys, repositoryId);
					});
					if (!retired && retirementTransactionId !== undefined) {
						this.abortScopeRetirement(retirementTransactionId);
						retirementTransactionId = undefined;
					}
					return retired;
				},
				finalize,
				error => this.logService.error('[ParadisWorkspaceSwitch] Failed to finalize retired scope phase', error)
			)) {
				await cancelPrepared();
				return false;
			}
		} catch (error) {
			await cancelPrepared();
			this.logService.error('[ParadisWorkspaceSwitch] Failed to retire scope transaction', error);
			return false;
		}
		return true;
	}

	acknowledgeScopeRetirement(stateKey: string): void {
		this.retirementJournal.acknowledgeStateKey(stateKey);
		try {
			this.saveRetirementJournal();
		} catch (error) {
			// The persisted entry remains a safe, idempotent retry point. Do not make a
			// successfully removed worktree appear to have failed after its own save.
			this.logService.error('[ParadisWorkspaceSwitch] Failed to persist a scope-retirement acknowledgement', error);
		}
	}

	async replayCommittedScopeRetirements(): Promise<void> {
		this.recoverCommittedScopeRetirementCore();
		await this.auxiliaryWindowScopeService.initializationBarrier;
		for (const transaction of this.retirementJournal.entries.filter(entry => entry.eventsPending)) {
			for (const stateKey of transaction.stateKeys) {
				try {
					await this.auxiliaryWindowScopeService.closeScopeWindowsForRetirement(stateKey);
				} catch (error) {
					this.logService.error('[ParadisWorkspaceSwitch] Failed to close a recovered retired auxiliary window', error);
				}
				this.auxiliaryWindowScopeService.commitScopeRetirement(stateKey);
				paradisRetireParkedTerminalEditorInstances(stateKey);
				this._onDidRetireScope.fire(stateKey);
				this.editorScopeService.completeScopeRetirement(stateKey);
			}
			this.retirementJournal.completeEvents(transaction.id);
			this.saveRetirementJournal();
		}
		if (this.recoveredRepositoriesChanged) {
			this.recoveredRepositoriesChanged = false;
			this._onDidChangeRepositories.fire();
		}
	}

	private stageScopeRetirement(stateKeys: readonly string[], repositoryId?: string): string {
		const transactionId = generateUuid();
		this.retirementJournal.stage(transactionId, stateKeys, repositoryId);
		try {
			this.saveRetirementJournal();
		} catch (error) {
			this.retirementJournal.abort(transactionId);
			try {
				this.saveRetirementJournal();
			} catch (rollbackError) {
				this.logService.error('[ParadisWorkspaceSwitch] Failed to roll back a partially persisted scope retirement journal', rollbackError);
			}
			throw error;
		}
		return transactionId;
	}

	private abortScopeRetirement(transactionId: string): void {
		this.retirementJournal.abort(transactionId);
		this.saveRetirementJournal();
	}

	private completeRepositoryRetirement(repositoryId: string): void {
		this.retirementJournal.completeRepository(repositoryId);
		// Worktree ownership is persisted by ParadisWorktreeService. It acknowledges
		// each state key only after its own known-worktree registry is durable.
		try {
			this.saveRetirementJournal();
		} catch (error) {
			// Repository storage is already committed. The old durable journal safely
			// repeats this idempotent completion after the next renderer start.
			this.logService.error('[ParadisWorkspaceSwitch] Failed to persist repository-retirement completion', error);
		}
	}

	private recoverCommittedScopeRetirementCore(): void {
		for (const transaction of this.retirementJournal.entries) {
			for (const stateKey of transaction.stateKeys) {
				try {
					this.deleteWorkingSetFor(stateKey);
				} catch (error) {
					this.logService.error('[ParadisWorkspaceSwitch] Failed to delete a recovered retired Working Set', error);
				}
				this._panelVisibility.delete(stateKey);
				paradisRetireParkedTerminalEditorInstances(stateKey);
			}

			if (transaction.repositoryPending && transaction.repositoryId !== undefined) {
				try {
					const previousLength = this._repositories.length;
					for (let index = this._repositories.length - 1; index >= 0; index--) {
						if (this._repositories[index].id === transaction.repositoryId) {
							this._repositories.splice(index, 1);
						}
					}
					this.saveRepositories();
					this.recoveredRepositoriesChanged ||= this._repositories.length !== previousLength;
					this.retirementJournal.completeRepository(transaction.repositoryId);
				} catch (error) {
					this.logService.error('[ParadisWorkspaceSwitch] Failed to finalize a recovered repository retirement', error);
				}
			}

			if (this._activeEntry && transaction.stateKeys.includes(this._activeEntry.stateKey)) {
				this.clearActiveEntry();
				if (this._repositories.length === 0) {
					void this.editorScopeService.leaveManagedWorkspace();
					this.auxiliaryWindowScopeService.setMainScope(undefined, false, false);
				}
			}
		}
		this.saveRetirementJournal();
	}

	private saveRetirementJournal(): void {
		if (this.retirementJournal.entries.length === 0) {
			this.storageService.remove(ParadisWorkspaceSwitchService.RETIREMENT_JOURNAL_STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}
		this.storageService.store(
			ParadisWorkspaceSwitchService.RETIREMENT_JOURNAL_STORAGE_KEY,
			this.retirementJournal.serialize(),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}

	async renameRepository(id: string, name: string): Promise<void> {
		this.updateRepository(id, repository => ({ ...repository, name }));
	}

	async setRepositoryColor(id: string, color: string | undefined): Promise<void> {
		this.updateRepository(id, repository => ({ ...repository, color }));
	}

	reorderRepositories(orderedIds: readonly string[]): void {
		const reordered = paradisApplyDesiredOrder(this._repositories, repository => repository.id, orderedIds);
		if (!reordered) {
			return;
		}
		this._repositories.splice(0, this._repositories.length, ...reordered);
		this.saveRepositories();
		this._onDidChangeRepositories.fire();
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

	async switchRepository(id: string, options?: IParadisSwitchOptions): Promise<void> {
		const repository = this._repositories.find(candidate => candidate.id === id);
		if (!repository) {
			throw new Error(`Unknown Para Code repository: ${id}`);
		}

		return this.switchToTarget(repository.id, repository.uri, options);
	}

	async switchToWorktree(worktree: IParadisWorktree, options?: IParadisSwitchOptions): Promise<void> {
		if (worktree.missing) {
			throw new Error(`Para Code worktree is missing on disk: ${worktree.uri.fsPath}`);
		}

		return this.switchToTarget(paradisWorktreeStateKey(worktree.uri), worktree.uri, options);
	}

	async switchToStateKey(stateKey: string, options?: IParadisSwitchOptions): Promise<void> {
		const repository = this._repositories.find(candidate => candidate.id === stateKey);
		if (repository) {
			return this.switchToTarget(repository.id, repository.uri, options);
		}
		if (stateKey.startsWith('worktree:')) {
			return this.switchToTarget(stateKey, URI.parse(stateKey.slice('worktree:'.length)), options);
		}
		throw new Error(`Unknown Para Code space: ${stateKey}`);
	}

	private switchToTarget(stateKey: string, uri: URI, options?: IParadisSwitchOptions): Promise<void> {
		this.ensureMultiRootWorkspace();

		// 連打の畳み込み。`coalesce` 付きの要求だけが世代を進め、実行開始時点で自分より新しい
		// `coalesce` 付きの要求が来ていたらこの回を丸ごと飛ばす。中間スペースの退避/復元を
		// 省けるので、待ち時間だけでなくエディタ・ターミナルの出し入れ回数も減る。
		//
		// **`coalesce` の無い要求 (内部呼び出し) は世代を進めず、飛ばされることもない。** 退役の
		// ロールバックや worktree 作成直後の切り替えは、成立を前提に後続処理が走るため。
		const coalesceGeneration = options?.coalesce ? ++this._coalesceGeneration : undefined;

		// 計測は sequencer の待ちを含めない位置から始める。キュー待ちは「切り替えが遅い」ではなく
		// 「連打された」なので、混ぜると分布が読めなくなる。件数は sample rate で絞られる。
		// 負荷の指標は**フェーズ内訳と同じイベントに載せる**（`recordSwitchPhases`）。別々の
		// トランザクションに分けると共通のIDが無く、「端末が多いときにどのフェーズが伸びるか」
		// という肝心の相関が取れない。
		const terminalEditors = this.terminalEditorService.instances.length;
		const editors = this.editorGroupsService.groups.reduce((total, group) => total + group.count, 0);
		return this._switchSequencer.queue(() => {
			// 実行が始まる前に追い越されていたら、この回は何もしない。**span を張る前に判定する**：
			// 飛ばした回まで計測に載せると、フェーズ内訳の分布に 0ms 付近の山ができて読めなくなる。
			if (coalesceGeneration !== undefined && coalesceGeneration !== this._coalesceGeneration) {
				this.logService.trace(`[ParadisWorkspaceSwitch] Skipping superseded switch to ${stateKey}`);
				return Promise.resolve();
			}

			return runInParadisSpan('workspaceSwitch', 'switch', {
				safe_terminal_editors: terminalEditors,
				safe_editors: editors,
			}, async () => {
				// フェーズの所要時間は**子spanではなく自前の計測**で取る。renderer の Sentry SDK には
				// AsyncContextStrategy が無く、`await` を跨ぐと active span を見失うため、await の後に
				// 作った子spanは親に繋がらず独立したトランザクションになり、それぞれが別々に
				// サンプリング抽選を受ける（本番で1件も届いていなかった一因）。数値を自分で持てば
				// 実行文脈にも await の位置にも一切依存しない。
				const switchStartedAt = Date.now();
				const phaseMs: Record<string, number> = {};
				const timePhase = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
					const startedAt = Date.now();
					try {
						return await run();
					} finally {
						phaseMs[name] = Date.now() - startedAt;
					}
				};
				// 同期の重い区間（park ループ、退避、パネル復元）にも使う。切り替えの体感は
				// await の有無で決まらないので、非同期の区間だけ測っても遅さの説明にならない。
				const timeSyncPhase = <T>(name: string, run: () => T): T => {
					const startedAt = Date.now();
					try {
						return run();
					} finally {
						phaseMs[name] = Date.now() - startedAt;
					}
				};
				const previousKey = this.activeStateKey;
				const folders = this.contextService.getWorkspace().folders;
				const previousUri = folders.length === 1 ? folders[0].uri : undefined;
				if (folders.length === 1 && isEqual(folders[0].uri, uri)) {
					await paradisApplySameUriScopeCorrection(
						previousKey,
						stateKey,
						() => this.setActiveEntry(stateKey, uri),
						correctedStateKey => this._onDidSwitchScope.fire(correctedStateKey),
						markParadisManagedWorkspaceWindow,
						async () => {
							await this.editorScopeService.correctActiveScope(previousKey, stateKey, uri);
							this.auxiliaryWindowScopeService.setMainScope(stateKey, true, false);
							if (previousKey !== stateKey) {
								await this.runSwitchCompletionParticipants(stateKey);
							}
						},
					);
					return;
				}

				// updateFolders で folders[0] が変わる前に必ずフラグを立てる。
				// relauncher の RunOnceScheduler はフォルダ変更の 10ms 後に発火するため、
				// ここで立てておけば発火時点で確実にスキップされる。
				markParadisManagedWorkspaceWindow();

				this._switching = true;
				this.editorScopeService.beginSwitch();
				this.auxiliaryWindowScopeService.setMainScope(previousKey, true, true);
				let completed = false;
				let sourceCaptured = false;
				let switchError: unknown;
				// 所要時間は**この切り替えのローカル**へ受ける（インスタンスに置くと、先行 stat が
				// 解決する前に失敗した回で前回の値を今回の値として送ってしまう）。計測は finally から
				// 読むので、宣言は try の外に置くこと。
				let folderStatMs: number | undefined;
				try {
					this._onWillSwitchScope.fire(previousKey);

					// 切り替え先フォルダの stat を先に投げておく。updateFolders はこの確認を内部で
					// 待つが、切り替えは park や PTY 問い合わせで数百ms使うので、その裏で済ませれば
					// 本流の待ち時間から消える (詳細は paradisWorkspaceFolderVerification.ts)。
					// await しないのが要点なので、ここで例外を外に出さないこと。
					const folderVerified = this.verifyTargetFolder(uri).then(ms => { folderStatMs = ms; });

					// 切り替え元のエディタ状態 (レイアウト + タブ集合) とパネル表示状態を退避する
					if (previousKey !== undefined) {
						timeSyncPhase('capture_scope', () => {
							this.editorScopeService.captureScope(previousKey, excludedEditors => this.saveWorkingSetFor(previousKey, excludedEditors));
							// **`sourceCaptured` はここで立てる。** 退避が済んだ時点でロールバックの
							// 対象になる。パネル表示の保存まで含めた後ろへ動かすと、そちらが投げたときに
							// 退避済みのエディタ状態を復元しないまま戻ってしまう。
							sourceCaptured = true;
							this.savePanelVisibilityFor(previousKey);
						});

						// エディタターミナルは working set の保存後・適用前にインスタンスを input から
						// 切り離して生かしたままパークする。切り離さないと applyWorkingSet のエディタ close で
						// PTY ごと破棄され、戻ってきた際に死んだ pty への再接続で壊れたターミナルが復元される
						// (詳細は paradisTerminalEditorPark.ts のコメント参照)。working set を保存して
						// いない場合 (previousKey なし) は復元先が無くインスタンスが孤児化するためパークしない。
						//
						// captureScope が retain 済みの入力 (子プロセス実行中の端末 = closeHandler が確認を
						// 要求する入力) は対象外とする。retain された入力は close 時も terminalEditorService の
						// 一覧に残り続け (terminalEditorService.ts の PARA-PATCH)、restoreScope の再アタッチで
						// そのまま復帰する。ここで detachInstance すると retain 中の入力を dispose してしまい
						// 復元経路が壊れる上、park 台帳と一覧の二重管理になる。
						// **端末数に比例する区間**。`safe_terminal_editors` を一緒に送っているのは、
						// ここの伸びと突き合わせるため。
						const parkedNonces = new Set<string>();
						timeSyncPhase('park_terminals', () => {
							for (const instance of [...this.terminalEditorService.instances]) {
								const input = this.terminalEditorService.getInputFromResource(instance.resource);
								if (this.editorGroupsService.isEditorInputRetained?.(input)) {
									continue;
								}
								// input.group はキャッシュで detach 後に古い値が残り得るため、実際に入力を
								// 含むグループを検索して補助ウィンドウ所属を判定する
								const containingGroup = this.editorGroupsService.groups.find(group => group.contains(input));
								if (containingGroup && this.editorGroupsService.getPart(containingGroup) !== this.editorGroupsService.mainPart) {
									continue;
								}
								if (paradisParkTerminalEditorInstance(instance, previousKey)) {
									// 実際に park できた nonce だけを控える。復元時に「この顔ぶれが
									// そのまま台帳に残っているか」を名指しで確かめるための唯一の材料。
									// park に失敗した入力（PTY ID 未確定・nonce 不正）は載らないので、
									// 集合が working set の端末数に届かず、判定は「引く側」へ倒れる。
									const parkedNonce = paradisTerminalIdentityNonce(instance.shellIntegrationNonce);
									if (parkedNonce !== undefined) {
										parkedNonces.add(parkedNonce);
									}
									this.terminalEditorService.detachInstance(instance);
								}
							}
						});
						// **永続化しない。** 再起動を跨ぐと台帳の中身は起動時の孤児復活で作られた別物に
						// なるので、「前回パークした顔ぶれ」として使ってはいけない。世代を跨いだ復元は
						// 索引が唯一の防波堤なので、集合が無い＝必ず引く、で正しい。
						this._workingSetTerminalNonces.set(previousKey, parkedNonces);
					}

					// エディタの入れ替えは updateFolders より先に行う。Git 拡張はフォルダ削除時、
					// 「可視エディタが使用中のリポジトリ」を close しない (extensions/git/src/model.ts の
					// onDidChangeWorkspaceFolders)。updateFolders を先にすると旧リポジトリのエディタが
					// まだ開いているため SCM にリポジトリが残留してスコープが漏れる。
					// 未保存入力はcaptureScopeでretain/detach済みなので、ここでは保存済み入力だけが
					// upstream Working Setの通常挙動に従って切り替わる。
					// working set の deserialize から呼ばれる reviveInput は同期なので、その中から pty host へ
					// 問い合わせられない。park ループの直後・適用の直前という「park が確定していて、まだ
					// 誰も revive していない」唯一の窓で孤児 PTY のスナップショットを取り直しておく。
					// スナップショットはこの適用専用なので、終わったら必ず捨てる。残すとロールバックでの
					// 再適用や後続の revive が古い情報で attach 先を決めてしまう
					// (paradisTerminalEditorRevive.ts)。
					// 復元先の端末が**すべてこのウィンドウの park 台帳に載っている**なら、索引は誰も
					// 読まない。`reviveInput` は台帳を先に引き、当たれば
					// `paradisResolveRevivedTerminalEditorInput` まで到達しないため
					// （`terminalEditorService.ts` の PARA-PATCH）。
					//
					// 本番データがこの形をはっきり示していた: 締め切り(500ms)に到達した33件は**全件が
					// 孤児0件**で、待った末に得るものが何も無かった。一方で孤児が取れた12件のうち11件は
					// 応答が300ms超で、**締め切りを縮めると「索引が役に立つ回」だけを落とす**。
					// だから待ち時間は縮めず、「そもそも要らない回」を外す。
					//
					// **件数の比較で代用しないこと。** 台帳の母集団はそのスコープの working set に
					// 閉じていない（`assignInstanceScope` の付け替え park、起動時の孤児復活 park、
					// 切り替え失敗時の再 park で、working set に無い端末が同じスコープへ載る）。
					// 一方 park 中に PTY が死ねばエントリだけ消えるので、「1つ死んで1つ余計に載っている」
					// だけで件数は釣り合い、死んだ側は索引なしで危険な経路へ落ちる。
					//
					// **アプリ再起動後は台帳が空になる、とも思わないこと。** 起動時の
					// `reviveOrphanedScopedEditorTerminals` が孤児 PTY を台帳へ入れるうえ、
					// 端末数は working set と一緒に永続化されているので、件数比較だと
					// **索引が唯一の防波堤である世代跨ぎの復元でこそ skip が成立してしまう**。
					//
					// だから「前回この手で park した nonce の顔ぶれ」を控えておき、それが
					// そのまま台帳に残っているかを名指しで確かめる。この集合は永続化していないので、
					// 再起動後は必ず undefined ＝ 引く側へ倒れる。
					// 復元先にターミナルエディタが載っていないと分かっているなら、pty host への
					// 問い合わせ自体を飛ばす。判定は2段階で、混ぜないこと:
					//
					// - working set が無い（初訪問・破棄済み）→ `applyWorkingSetFor` は
					//   `applyWorkingSet('empty')` に落ちて `reviveInput` を一度も呼ばない。
					//   復元される端末入力が存在しないので 0 でよい。
					// - working set はあるが数が `undefined`（この計装より前に保存されたデータ、
					//   または保存時に数えられなかった回）→ **「無い」ではなく「不明」**。
					//   ここを 0 と扱うと、端末を含む working set を索引なしで復元してしまう。
					const restoreTerminals = this._workingSets.has(stateKey)
						? this._workingSetTerminals.get(stateKey)
						: 0;
					await timePhase('revive_index', () => {
						// 判定は**使う直前で**取る。カウントを先に取って await を挟むと、その間に
						// pty exit が届いて台帳が縮んでも「引かない」が確定済みになってしまう。
						const expectedNonces = this._workingSetTerminalNonces.get(stateKey);
						const coveredByPark = restoreTerminals !== undefined
							&& expectedNonces !== undefined
							// park に失敗した入力があると集合が端末数に届かない＝賄えていない。
							&& expectedNonces.size >= restoreTerminals
							&& paradisAreAllParkedForScope(expectedNonces, stateKey);
						// 0件回は `no-terminals` を優先する。0 は `coveredByPark` も自明に満たすので、
						// 先に判定しないと新条件の効果が「もともと端末が無い回」に薄められて読めなくなる。
						const skipReason = restoreTerminals === 0 ? 'no-terminals'
							: coveredByPark ? 'covered-by-park' : undefined;
						return paradisRefreshTerminalReviveIndex(stateKey, {
							skipLookup: skipReason !== undefined,
							skipReason,
							// 判定の裏取り用。`parked > expected` が常態なら、working set に無い端末が
							// 同じスコープへ載っている＝件数比較が危険だった実態が本番で確認できる。
							parkedCount: expectedNonces?.size,
							expectedCount: restoreTerminals,
						});
					});
					try {
						await timePhase('apply_working_set', () => this.applyWorkingSetFor(stateKey));
					} finally {
						paradisClearTerminalReviveIndex();
					}

					await timePhase('trust_uris', () => this.trustUris(uri));
					// 先行実行が終わっていなければここで待つ。切り替えの体感に効くのは
					// stat 自体の時間ではなく「本流が待たされた時間」なので、そちらを測る。
					await timePhase('verify_folder_wait', () => folderVerified);
					// `update_folders` は本番の p95 で 1086ms、最遅群では 1〜2秒を占める最大の区間だが、
					// 中身は upstream の `workspaceEditingService` なので、そのままでは「何に使われた
					// 時間か」が分からない。upstream に手を入れずに切り分けるため、**upstream が公開して
					// いる2つのイベントの発火時刻**で3つに割る（`IWorkspaceContextService` の
					// `onWillChangeWorkspaceFolders` / `onDidChangeWorkspaceFolders`）。
					//
					//   呼び出し → willChange   … 設定ファイルの書き換えに加えて、**`toValidWorkspaceFolders`
					//                             の全フォルダ直列 stat** と各フォルダの設定読み込み
					//   willChange → didChange  … willChange 参加者に加えて、`onDidChangeConfiguration` の
					//                             ワークベンチ全体への同期配信
					//   didChange → 解決        … 残り
					//
					// 本番の実測では前半（呼び出し→didChange）が全体の 99% を占めていた。
					// **前半が重い＝「書き込みが遅い」と読まないこと。** `doUpdateFolders` 側の stat は
					// 既に PARA-PATCH で飛ばしているが、`toValidWorkspaceFolders` の stat は素通しで
					// 残っており（単発の実測中央値 322ms）、そちらが第一候補になる。
					const updateFoldersStartedAt = Date.now();
					let foldersWillChangeAt: number | undefined;
					let foldersChangedAt: number | undefined;
					const foldersEventListeners = new DisposableStore();
					foldersEventListeners.add(this.contextService.onWillChangeWorkspaceFolders(() => {
						foldersWillChangeAt ??= Date.now();
					}));
					foldersEventListeners.add(this.contextService.onDidChangeWorkspaceFolders(() => {
						foldersChangedAt ??= Date.now();
					}));
					try {
						await timePhase('update_folders',
							() => this.workspaceEditingService.updateFolders(0, folders.length, [{ uri }]));
					} finally {
						foldersEventListeners.dispose();
						// 観測できなかった区間はキーごと落とす。0 を入れると「速かった」と
						// 区別がつかなくなり、集計が黙って歪む。
						// **すべて「区間の長さ」で揃える。** 累積と差分を混ぜると、Discover で
						// 積み上げたときに前半が二重に数えられる。既存の `update_folders_to_event` だけは
						// 開始からの累積のまま残す（前リリースのデータと比較できなくなるため）。
						if (foldersWillChangeAt !== undefined) {
							phaseMs['update_folders_write'] = foldersWillChangeAt - updateFoldersStartedAt;
						}
						if (foldersChangedAt !== undefined) {
							phaseMs['update_folders_to_event'] = foldersChangedAt - updateFoldersStartedAt;
							if (foldersWillChangeAt !== undefined) {
								phaseMs['update_folders_participants'] = foldersChangedAt - foldersWillChangeAt;
							}
						}
						// ロールバックの updateFolders は別のフォルダへ戻すので、確認結果を残さない。
						paradisClearVerifiedWorkspaceFolders();
					}

					this.setActiveEntry(stateKey, uri);
					await timePhase('commit_switch', () => this.editorScopeService.commitSwitch(stateKey, uri));
					this.auxiliaryWindowScopeService.setMainScope(stateKey, true, false);
					await timePhase('restore_scope', () => this.editorScopeService.restoreScope(stateKey));
					await timePhase('restore_backups', () => this.editorScopeService.restoreBackups());
					timeSyncPhase('restore_panels', () => this.restorePanelVisibilityFor(stateKey));
					completed = true;
				} catch (error) {
					switchError = error;
					await paradisRunBestEffortPhases([
						async () => {
							const currentFolders = this.contextService.getWorkspace().folders;
							if (previousUri && (currentFolders.length !== 1 || !isEqual(currentFolders[0].uri, previousUri))) {
								await this.workspaceEditingService.updateFolders(0, currentFolders.length, [{ uri: previousUri }]);
							}
						},
						async () => {
							if (previousKey !== undefined && sourceCaptured) {
								await this.applyWorkingSetFor(previousKey);
							}
						},
						async () => {
							if (previousKey !== undefined && sourceCaptured) {
								await this.editorScopeService.restoreScope(previousKey);
							}
						},
						() => {
							if (previousKey !== undefined && sourceCaptured && previousUri) {
								this.setActiveEntry(previousKey, previousUri);
							} else if (previousKey === undefined) {
								this.clearActiveEntry();
							}
						},
						() => {
							if (previousKey !== undefined && sourceCaptured) {
								this.restorePanelVisibilityFor(previousKey);
							}
						},
						() => this.editorScopeService.rollbackSwitch(previousKey, previousUri),
						() => this.auxiliaryWindowScopeService.setMainScope(previousKey, this.isManagedWorkspaceWindow, false),
						() => this.editorScopeService.restoreBackups(),
					], rollbackError => this.logService.error('[ParadisWorkspaceSwitch] Failed to roll back workspace switch phase', rollbackError));
					throw error;
				} finally {
					this._switching = false;

					// 完了時は切り替え先スコープへ、途中で例外が起きた場合は元スコープへ発火する。
					// onWillSwitchScope で退避済みの状態 (SCM入力の下書き・park済みターミナル) は
					// onDidSwitchScope を受け皿として復元されるため、失敗時に発火しないと迷子のまま残る
					const restoreKey = completed ? stateKey : switchError !== undefined ? previousKey : undefined;
					if (restoreKey !== undefined) {
						// 制御フローを担う非同期 participant を先に完走させてから、完了通知を配る。
						// この await 中も Sequencer のスロットは保持されるので、次の切り替えは始まらない。
						await timePhase('notify_scope_switched', async () => {
							await this.runSwitchCompletionParticipants(restoreKey);
							this._onDidSwitchScope.fire(restoreKey);
						});
					}

					// 台帳の保険。破棄は `update_folders` の finally にあるが、そこへ到達する前に
					// 例外が出ると**セッション中ずっと残り**、切り替えと無関係な後続の判定が古い
					// 確認結果で stat を飛ばす。消費者が「フォルダを除外する側」にも増えた以上、
					// 残す危険のほうが大きい。`Set.clear()` なので二重呼び出しは無害。
					paradisClearVerifiedWorkspaceFolders();

					// 計測は**復元まで済ませた後**。completion participant と完了通知の処理も
					// ユーザーが感じる切り替え時間に含める。
					this.recordSwitchPhases({
						startedAt: switchStartedAt,
						phaseMs,
						completed,
						failed: switchError !== undefined,
						terminalEditors,
						editors,
						folderStatMs,
						folderStatSkipped: paradisTakeVerifiedWorkspaceFolderHits(),
					});
				}
			});
		});
	}

	private async runSwitchCompletionParticipants(stateKey: string): Promise<void> {
		for (const participant of [...this._switchCompletionParticipants]) {
			try {
				await participant(stateKey);
			} catch (error) {
				this.logService.error('[ParadisWorkspaceSwitch] Switch completion participant failed', error);
			}
		}
	}

	/**
	 * 切り替え1回ぶんのフェーズ内訳を Sentry へ1本で送る。
	 *
	 * 子spanに分けないのは、renderer の Sentry SDK に AsyncContextStrategy が無く、`await` を
	 * 跨ぐと active span を見失うため。親に繋がらない子spanは独立したトランザクションになり、
	 * それぞれ別々にサンプリング抽選を受ける（本番で1件も届かなかった一因）。数値を自分で
	 * 持ち回れば実行文脈にも await の位置にも依存しない。
	 *
	 * 到達しなかったフェーズはキーごと落とす。`-1` のようなセンチネルを送ると `avg()` が黙って歪む。
	 *
	 * **ここで投げないこと。** 呼び出し元は切り替えの `finally` で、park 済みターミナルや
	 * SCM 下書きの復元と同じ経路にいる。計測の失敗で復元を巻き込むのは割に合わない。
	 */
	private recordSwitchPhases(sample: {
		readonly startedAt: number;
		readonly phaseMs: Record<string, number>;
		readonly completed: boolean;
		readonly failed: boolean;
		readonly terminalEditors: number;
		readonly editors: number;
		readonly folderStatMs: number | undefined;
		readonly folderStatSkipped: number;
	}): void {
		try {
			const durations: Record<string, number> = {};
			for (const [phase, ms] of Object.entries(sample.phaseMs)) {
				durations[`safe_${phase}_ms`] = ms;
			}
			runInParadisSpan('workspaceSwitch', 'phases', {
				safe_total_ms: Date.now() - sample.startedAt,
				...durations,
				safe_completed: sample.completed,
				// 失敗した切り替えは分布を歪めるので、集計時に分けられるようにしておく。
				safe_failed: sample.failed,
				// 負荷の指標。フェーズの伸びと突き合わせるために同じイベントへ載せる。
				safe_terminal_editors: sample.terminalEditors,
				safe_editors: sample.editors,
				// フォルダ1つの stat の実測。upstream の重複 stat を飛ばしたぶん、
				// `update_folders_write` からこの値と同じだけ消えているはず。
				// **センチネルを送らない**（この関数の doc のとおり、`-1` は avg() を黙って歪める）。
				...(sample.folderStatMs !== undefined ? { safe_folder_stat_ms: sample.folderStatMs } : {}),
				// **これが 0 なら最適化は空振りしている。** 台帳のキーは URI の生文字列で、
				// upstream 側が見る URI は再構成された別インスタンスなので、一致しなければ
				// 安全側に無言で倒れる。時間の差だけ見ていても空振りに気付けない。
				safe_folder_stat_skipped: sample.folderStatSkipped,
			}, () => { });
		} catch (error) {
			this.logService.error('[ParadisWorkspaceSwitch] Failed to record switch phases', error);
		}
	}

	/**
	 * 切り替え先がディレクトリであることを先に確かめ、確認できた場合だけ台帳へ登録する。
	 *
	 * 確認できなかった場合 (ファイルを指している / stat が失敗した) は**登録しない**。upstream 側が
	 * 従来どおり自分で stat し、それぞれの分岐へ進む。つまりこの先行実行は判定を置き換えるのでは
	 * なく、判定のタイミングを本流の外へ動かすだけ。
	 */
	private async verifyTargetFolder(uri: URI): Promise<number> {
		const startedAt = Date.now();
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.isDirectory) {
				paradisMarkVerifiedWorkspaceFolder(uri.toString());
			}
		} catch (error) {
			// 確認できなければ upstream の stat に委ねる。ここで投げると切り替えごと失敗する。
		}
		// **これは切り替えを遅くしない**（本流の外で先行実行しており、待ち時間は
		// `verify_folder_wait` として別に測っている。実測 p50 は 0ms）。
		// ここで測るのは「フォルダ1つの stat が今この環境で何ms かかるか」そのもの。
		// **切り替えごとのローカルへ持たせること。** インスタンスに置くと、先行 stat の解決前に
		// 失敗した切り替えで前回の値（＝別スペース・別ボリュームの数字）を今回の値として送る。
		return Date.now() - startedAt;
	}

	private setActiveEntry(stateKey: string, uri: URI): void {
		this._activeEntry = { stateKey, uri: uri.toString() };
		this.storageService.store(PARADIS_WORKSPACE_ACTIVE_ENTRY_STORAGE_KEY, JSON.stringify(this._activeEntry), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private clearActiveEntry(): void {
		this._activeEntry = undefined;
		this.storageService.remove(PARADIS_WORKSPACE_ACTIVE_ENTRY_STORAGE_KEY, StorageScope.WORKSPACE);
	}

	private loadActiveEntry(): ISerializedActiveEntry | undefined {
		const raw = this.storageService.get(PARADIS_WORKSPACE_ACTIVE_ENTRY_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	private saveWorkingSetFor(stateKey: string, excludedEditors: readonly EditorInput[] = []): void {
		const previousWorkingSet = this._workingSets.get(stateKey);
		if (this.editorGroupsService.mainPart.groups.some(group => !group.isEmpty)) {
			// 数えるのは working set を保存する**前**。`getInputFromResource` は未登録の resource で
			// 投げる API なので、保存の後に数えると「新しいハンドルと古い数」が組になって残る。
			// その組で復元すると、端末を含む working set を索引なしで復元する経路が開く。
			// 数えられなかった場合は台帳から消して「不明」にし、索引を引く側へ倒す。
			//
			// 除外された入力 (retain 中＝子プロセス実行中の端末) は working set に載らないので、
			// 復元時に索引を引く相手にもならない。数えるのは実際に載るものだけ。
			let terminalCount: number | undefined;
			try {
				terminalCount = this.terminalEditorService.instances
					.filter(instance => !excludedEditors.includes(this.terminalEditorService.getInputFromResource(instance.resource)))
					.length;
			} catch (error) {
				this.logService.warn('[ParadisWorkspaceSwitch] Failed to count terminal editors for the working set', error);
			}
			const workingSet = this.editorGroupsService.saveWorkingSet(`paradis-workspace:${stateKey}`, {
				excludeEditors: excludedEditors,
				includeAuxiliaryWindows: false
			});
			this._workingSets.set(stateKey, workingSet);
			if (terminalCount === undefined) {
				this._workingSetTerminals.delete(stateKey);
			} else {
				this._workingSetTerminals.set(stateKey, terminalCount);
			}
			if (previousWorkingSet) {
				// 新しいスナップショットが確定してから古いものを捨てる。保存失敗時も、
				// 直前に成功した Working Set を失わないため。
				this.editorGroupsService.deleteWorkingSet(previousWorkingSet);
			}
		} else if (previousWorkingSet) {
			this.editorGroupsService.deleteWorkingSet(previousWorkingSet);
			this._workingSets.delete(stateKey);
			this._workingSetTerminals.delete(stateKey);
			this._workingSetTerminalNonces.delete(stateKey);
		}
		this.saveWorkingSets();
	}

	private async applyWorkingSetFor(stateKey: string): Promise<void> {
		const workingSet = this._workingSets.get(stateKey);

		let applied = false;
		if (workingSet) {
			applied = await this.editorGroupsService.applyWorkingSet(workingSet, { preserveFocus: false, preserveAuxiliaryWindows: true });
		}
		if (!applied) {
			// working set が無い (初訪問) か、ハンドルが失効している場合は空状態から始める
			await this.editorGroupsService.applyWorkingSet('empty', { preserveFocus: false, preserveAuxiliaryWindows: true });
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
		this._workingSetTerminals.delete(repositoryId);
		this._workingSetTerminalNonces.delete(repositoryId);
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

	/**
	 * このウィンドウが繋がっている先を表す鍵。手元は空文字。
	 *
	 * スペースの一覧は接続先ごとに分けて共有領域へ置く。丸ごと1つの配列にすると、
	 * 手元で消したスペースが接続先のウィンドウの保存で復活してしまう。
	 */
	private get hostKey(): string {
		return this.environmentService.remoteAuthority ?? '';
	}

	private parseRepositories(raw: string | undefined): IParadisWorkspaceRepository[] {
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

	/**
	 * このウィンドウのスペース一覧。
	 *
	 * 1ウィンドウは1つの接続先しか見られない（リモートのファイルは、その接続を持つウィンドウに
	 * しか現れない）。手元のスペースと接続先のスペースを同じ一覧に並べると、開けないものが
	 * 混ざるうえ、ウィンドウを開き直すたびに見え方が変わる。**繋がっている先のものだけ**を出す。
	 */
	private loadRepositories(): IParadisWorkspaceRepository[] {
		return this.parseRepositories(this.storageService.get(PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY, StorageScope.WORKSPACE))
			.filter(repository => this.belongsToThisHost(repository.uri));
	}

	private saveRepositories(): void {
		const serialized: ISerializedRepository[] = this._repositories
			.filter(repository => this.belongsToThisHost(repository.uri))
			.map(repository => ({
				id: repository.id,
				name: repository.name,
				uri: repository.uri.toString(),
				color: repository.color
			}));
		this.storageService.store(PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** その場所が、このウィンドウの繋がっている先のものか。 */
	private belongsToThisHost(uri: URI): boolean {
		const host = uri.scheme === Schemas.vscodeRemote ? uri.authority : '';
		return host === this.hostKey;
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
				if (entry.terminalEditors !== undefined) {
					this._workingSetTerminals.set(entry.repositoryId, entry.terminalEditors);
				}
			}
		} catch {
			// 壊れたデータは無視 (次の切り替えで作り直される)
		}
	}

	private saveWorkingSets(): void {
		const serialized: ISerializedWorkingSetEntry[] = [];
		for (const [repositoryId, workingSet] of this._workingSets) {
			serialized.push({ repositoryId, workingSet, terminalEditors: this._workingSetTerminals.get(repositoryId) });
		}
		this.storageService.store(ParadisWorkspaceSwitchService.WORKING_SETS_STORAGE_KEY, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
