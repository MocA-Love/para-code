/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { timeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore, dispose, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { EditorInputCapabilities, EditorsOrder, GroupIdentifier, SaveReason } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../workbench/common/editor/sideBySideEditorInput.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { paradisRegisterEditorOpenFenceHandler } from '../../../../workbench/services/editor/common/paradisEditorRetirementFence.js';
import { IWorkingCopy, IWorkingCopyIdentifier } from '../../../../workbench/services/workingCopy/common/workingCopy.js';
import { IWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/common/workingCopyBackup.js';
import { WorkingCopyBackupRestoreDecision, IWorkingCopyBackupRestoreRouter } from '../../../../workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.js';
import { IWorkingCopyEditorService } from '../../../../workbench/services/workingCopy/common/workingCopyEditorService.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { IParadisEditorScopeService, ParadisWorkingCopyOwnerLedger, ParadisWorkingCopyOwnerLedgerLoadState } from '../common/paradisEditorScope.js';
import { IParadisAuxiliaryWindowScopeService, PARADIS_WORKSPACE_ACTIVE_ENTRY_STORAGE_KEY, PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY } from '../common/paradisWorkspaceSwitch.js';
import { paradisHasParkedTerminals } from './paradisTerminalEditorPark.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

interface IParadisLiveEditorPlacement {
	readonly editor: EditorInput;
	readonly groupId: GroupIdentifier;
	readonly windowId: number;
	readonly index: number;
	readonly active: boolean;
	readonly selected: boolean;
	readonly pinned: boolean;
	readonly sticky: boolean;
	readonly transient: boolean;
	readonly viewState: object | undefined;
}

interface IParadisLiveWorkingSet {
	readonly placements: readonly IParadisLiveEditorPlacement[];
	readonly workingCopiesByEditor: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>;
	readonly retentions: DisposableStore;
}

/**
 * 預け先へ入れた経路。二重に握られていたのを見つけたときの記録 (ログ・Sentry) に載せる。
 * `capture` = 切り替え元を預けるとき、`carry-over` = 預けた後に開かれて行き先へ持ち越された入力を回したとき、
 * `restore` / `restore-early` = 開き直す前に持ち主違いを回したとき、
 * `aux-close` = 補助ウィンドウを閉じたとき、`retirement-cancel` = 削除の取り消しで預け直したとき、
 * `correct` = 今のスペースのキーを付け直したとき。
 */
type ParadisLiveDepositPhase = 'capture' | 'carry-over' | 'restore' | 'restore-early' | 'aux-close' | 'retirement-cancel' | 'correct';

interface IParadisPreparedEditorRevert {
	readonly editor: EditorInput;
	readonly groupId: GroupIdentifier;
	readonly workingCopies: readonly IWorkingCopy[];
}

interface IParadisPreparedWorkingCopyState {
	readonly workingCopy: IWorkingCopy;
	readonly revision: number;
	readonly modified: boolean;
}

interface IParadisPreparedEditorState {
	readonly editor: EditorInput;
	readonly modified: boolean;
}

interface IParadisPreparedRetirement {
	readonly backups: readonly IWorkingCopyIdentifier[];
	readonly editorsToRevert: readonly IParadisPreparedEditorRevert[];
	readonly editorStates: IParadisPreparedEditorState[];
	readonly workingCopyStates: IParadisPreparedWorkingCopyState[];
	readonly handledWorkingCopyKeys: Set<string>;
	readonly frozenPlacements: IParadisLiveEditorPlacement[];
	frozenWorkingCopiesByEditor: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>;
	readonly frozenRetentions: DisposableStore;
}

interface ISerializedWorkspaceRepository {
	readonly id: string;
	readonly uri: string;
}

interface ISerializedActiveEntry {
	readonly stateKey: string;
	readonly uri: string;
}

interface ISerializedPendingBackupDiscard {
	readonly resource: string;
	readonly typeId: string;
	readonly stateKey: string;
}

const PARADIS_WORKING_COPY_OWNERS_STORAGE_KEY = 'paradis.workspaceSwitch.workingCopyOwners';
const PARADIS_PENDING_BACKUP_DISCARDS_STORAGE_KEY = 'paradis.workspaceSwitch.pendingBackupDiscards';

/** Returns whether an input must stay alive across a Para Code space switch. */
export function paradisEditorRequiresScopedLiveState(editor: EditorInput, modifiedEditors: ReadonlySet<EditorInput>): boolean {
	if (modifiedEditors.has(editor)
		|| editor.isModified()
		|| editor.hasCapability(EditorInputCapabilities.Untitled)
		|| editor.hasCapability(EditorInputCapabilities.Scratchpad)) {
		return true;
	}

	if (editor.closeHandler) {
		try {
			if (editor.closeHandler.showConfirm()) {
				return true;
			}
		} catch {
			return true;
		}
	}

	return editor instanceof SideBySideEditorInput
		&& (paradisEditorRequiresScopedLiveState(editor.primary, modifiedEditors)
			|| paradisEditorRequiresScopedLiveState(editor.secondary, modifiedEditors));
}

/** Returns the delay before the next clean Working Copy backup inspection. */
export function paradisOwnerReleaseRetryDelay(attempt: number): number {
	if (attempt <= 0) {
		return 0;
	}
	return Math.min(50 * (2 ** (attempt - 1)), 30_000);
}

/**
 * Owns both runtime live EditorInputs and persistent Working Copy backup
 * ownership. It deliberately does not depend on the workspace switch service,
 * allowing the restore router to start during BlockRestore without a cycle.
 */
export class ParadisEditorScopeService extends Disposable implements IParadisEditorScopeService {

	declare readonly _serviceBrand: undefined;

	private readonly liveWorkingSets = new Map<string, IParadisLiveWorkingSet>();
	/**
	 * `restoreScopeEarly` で先に開いた配置と、開いたグループ。配置のオブジェクトは
	 * `liveWorkingSets` のエントリを作り直しても同じものが引き継がれるので、配置をキーにする。
	 * 預け先 (`liveWorkingSets`) から消えた配置は参照されなくなり、そのまま回収される。
	 */
	private readonly earlyRestoredPlacements = new WeakSet<IParadisLiveEditorPlacement>();
	private readonly preparedRetirements = new Map<string, IParadisPreparedRetirement>();
	/**
	 * 入力ごとの retain の握りと、その握りを今持っている入れ物 (預け先の `retentions` など)。
	 * 入力を別の預け先へ移すとき、元の預け先が持つ握りだけを放すために引く。入れ物ごと捨てた
	 * 握りは `store.isDisposed` で見分けて読み飛ばす。
	 */
	private readonly retentionHandles = new WeakMap<EditorInput, { readonly handle: IDisposable; store: DisposableStore }[]>();
	/** 生きた入力の持ち主を引く口 (`registerLiveEditorOwnerResolver`)。 */
	private liveEditorOwnerResolver: ((editor: EditorInput) => string | undefined) | undefined;
	private readonly pendingBackupDiscards = this._register(new DisposableMap<string, DisposableStore>());
	private readonly pendingBackupDiscardJournal = new Map<string, { readonly identifier: IWorkingCopyIdentifier; readonly stateKey: string }>();
	private readonly pendingOwnerReleases = this._register(new DisposableMap<string, DisposableStore>());
	private readonly retirementFences = new Set<string>();
	private readonly workingCopyRevisions = new WeakMap<IWorkingCopy, number>();
	private readonly ownerLedger: ParadisWorkingCopyOwnerLedger;
	private readonly ownershipStorageWasCorrupt: boolean;
	private legacyMigrationMode: boolean;
	private managedWorkspace: boolean;
	private activeUri: URI | undefined;
	private _activeStateKey: string | undefined;
	private _isSwitching = false;

	get activeStateKey(): string | undefined { return this._activeStateKey; }
	get isSwitching(): boolean { return this._isSwitching; }

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IWorkingCopyEditorService private readonly workingCopyEditorService: IWorkingCopyEditorService,
		@IWorkingCopyBackupRestoreRouter private readonly backupRestoreRouter: IWorkingCopyBackupRestoreRouter,
		@IWorkingCopyBackupService private readonly workingCopyBackupService: IWorkingCopyBackupService,
		@IParadisAuxiliaryWindowScopeService private readonly auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const loadedLedger = ParadisWorkingCopyOwnerLedger.load(this.storageService.get(PARADIS_WORKING_COPY_OWNERS_STORAGE_KEY, StorageScope.WORKSPACE));
		this.ownerLedger = loadedLedger.ledger;
		this.ownershipStorageWasCorrupt = loadedLedger.state === ParadisWorkingCopyOwnerLedgerLoadState.Corrupt;
		this.legacyMigrationMode = loadedLedger.state === ParadisWorkingCopyOwnerLedgerLoadState.Missing;
		this.loadPendingBackupDiscards();

		const initialIdentity = this.resolveInitialIdentity();
		this.managedWorkspace = initialIdentity.managed;
		this._activeStateKey = initialIdentity.stateKey;
		this.activeUri = initialIdentity.uri;

		this._register(this.backupRestoreRouter.registerProvider({ route: identifier => this.routeBackup(identifier) }));
		this._register(paradisRegisterEditorOpenFenceHandler(groupId => this.isEditorGroupFenced(groupId)));
		this._register(this.workingCopyService.onDidRegister(workingCopy => {
			this.ensureWorkingCopyRevision(workingCopy);
			if (workingCopy.isModified()) {
				this.observeModifiedWorkingCopy(workingCopy);
			} else {
				this.releaseWorkingCopyOwnerWhenSafe(workingCopy);
			}
		}));
		this._register(this.workingCopyService.onDidChangeDirty(workingCopy => this.onDidChangeWorkingCopyModifiedState(workingCopy)));
		this._register(this.workingCopyService.onDidChangeContent(workingCopy => {
			this.workingCopyRevisions.set(workingCopy, this.workingCopyRevision(workingCopy) + 1);
			this.onDidChangeWorkingCopyModifiedState(workingCopy);
		}));
		this._register(this.workingCopyService.onDidSave(({ workingCopy }) => this.releaseWorkingCopyOwnerWhenSafe(workingCopy)));
		this._register(this.workingCopyService.onDidUnregister(workingCopy => this.releaseWorkingCopyOwnerWhenSafe(workingCopy)));
		this._register(toDisposable(() => {
			const retentions = [
				...Array.from(this.liveWorkingSets.values(), liveWorkingSet => liveWorkingSet.retentions),
				...Array.from(this.preparedRetirements.values(), retirement => retirement.frozenRetentions),
			];
			this.liveWorkingSets.clear();
			this.preparedRetirements.clear();
			this.retirementFences.clear();
			dispose(retentions);
		}));

		for (const workingCopy of this.workingCopyService.workingCopies) {
			this.ensureWorkingCopyRevision(workingCopy);
			if (!workingCopy.isModified()) {
				this.releaseWorkingCopyOwnerWhenSafe(workingCopy);
			}
		}
		for (const workingCopy of this.workingCopyService.modifiedWorkingCopies) {
			this.observeModifiedWorkingCopy(workingCopy);
		}
		void this.auxiliaryWindowScopeService.initializationBarrier.then(() => {
			for (const workingCopy of this.workingCopyService.modifiedWorkingCopies) {
				this.observeModifiedWorkingCopy(workingCopy);
			}
		});
		for (const pending of this.pendingBackupDiscardJournal.values()) {
			this.schedulePendingBackupDiscard(pending.identifier, pending.stateKey);
		}
	}

	captureScope(stateKey: string, saveSerializedState: (excludedEditors: readonly EditorInput[]) => void): void {
		if (this.liveWorkingSets.has(stateKey)) {
			throw new Error(`Para Code live editor state already exists for scope: ${stateKey}`);
		}
		if (!this.editorGroupsService.retainEditor) {
			throw new Error('Editor input retention is not available');
		}

		// メインのエディタ領域の生きた入力を全部拾う。どのスペースのものかは下で入力ごとに決める。
		const { modifiedEditorOwners, placements } = this.collectVisibleLiveEditorState(true, stateKey, true);
		const excludedEditors = new Set(placements.map(placement => placement.editor));
		// 入力ごとの預け先。持ち主が別のスペースだと分かっている入力 (ほかのスペースのエディタの
		// ターミナルが今の画面に紛れ込んでいたもの) は、切り替え元ではなく持ち主の預け先へ回す。
		// 切り替え元へ入れると、切り替え元へ戻るたびに開き直されて二度と持ち主へ帰らない。
		const destinations = new Map<EditorInput, string>();
		for (const editor of excludedEditors) {
			destinations.set(editor, this.depositKeyFor(editor, stateKey));
		}
		// 子プロセスの無い (確認の要らない) 端末でも、持ち主が別のスペースなら切り替え元の working set に
		// 載せない。その端末は切り替えサービスの park が持ち主のスペースへ入れる (`ownerParkScope`) ので、
		// 載せると切り替え元へ戻ったときに同じ端末をもう一度繋ぎに行く。生きている端末と行き先を揃える。
		const foreignCleanEditors = new Set<EditorInput>();
		for (const { editor } of this.collectVisibleLiveEditorState(false, stateKey, true, undefined, true).placements) {
			if (!excludedEditors.has(editor) && this.liveEditorOwner(editor) !== undefined && this.liveEditorOwner(editor) !== stateKey) {
				foreignCleanEditors.add(editor);
			}
		}

		for (const editor of excludedEditors) {
			for (const workingCopy of modifiedEditorOwners.get(editor) ?? []) {
				this.claimWorkingCopy(workingCopy, destinations.get(editor) ?? stateKey);
			}
		}

		// 預け先が自分の握りを持つまでの仮の握り。保存の途中で投げても、入力はグループに残っているので失われない。
		const pending = new DisposableStore();
		try {
			for (const editor of excludedEditors) {
				pending.add(this.editorGroupsService.retainEditor(editor));
			}

			saveSerializedState([...excludedEditors, ...foreignCleanEditors]);
			if (placements.length === 0) {
				return;
			}

			const byDestination = new Map<string, IParadisLiveEditorPlacement[]>();
			for (const placement of placements) {
				const destination = destinations.get(placement.editor) ?? stateKey;
				const entries = byDestination.get(destination) ?? [];
				entries.push(placement);
				byDestination.set(destination, entries);
			}
			for (const [destination, destinationPlacements] of byDestination) {
				if (destination !== stateKey) {
					this.logService.info(`[ParadisEditorScope] Deposited ${destinationPlacements.length} live editor(s) owned by another space with that space instead of the one being left`);
				}
				const editors = new Set(destinationPlacements.map(placement => placement.editor));
				this.addToDeposit(destination, destinationPlacements, this.selectWorkingCopyOwners(modifiedEditorOwners, editors), 'capture');
			}
			for (const placement of placements) {
				this.editorGroupsService.getGroup(placement.groupId)?.detachEditor?.(placement.editor);
			}
		} finally {
			pending.dispose();
		}
	}

	captureAuxiliaryPartOnClose(stateKey: string, part: IEditorPart): void {
		if (!this.editorGroupsService.retainEditor) {
			throw new Error('Editor input retention is not available');
		}

		const { modifiedEditorOwners, placements } = this.collectVisibleLiveEditorState(true, undefined, false, part);
		if (placements.length === 0) {
			return;
		}
		const editors = new Set(placements.map(placement => placement.editor));
		for (const editor of editors) {
			for (const workingCopy of modifiedEditorOwners.get(editor) ?? []) {
				this.claimWorkingCopy(workingCopy, stateKey);
			}
		}

		this.addToDeposit(stateKey, placements, this.selectWorkingCopyOwners(modifiedEditorOwners, editors), 'aux-close');
		for (const placement of placements) {
			this.editorGroupsService.getGroup(placement.groupId)?.detachEditor?.(placement.editor);
		}
	}

	async restoreScope(stateKey: string): Promise<void> {
		const liveWorkingSet = this.liveWorkingSets.get(stateKey);
		if (!liveWorkingSet) {
			return;
		}

		// Always clear the live working set, even on failure. Otherwise a scope
		// that fails to restore once (e.g. an unexpected error outside of
		// restoreEditorPlacements' own per-placement recovery) would keep the
		// same dead entry around forever and repeat the same failure on every
		// subsequent switch into this scope.
		// ここで開く (または開くのを諦める) 配置。後片付けはこの配置の分だけにする。
		let restoring: ReadonlySet<IParadisLiveEditorPlacement> = new Set(liveWorkingSet.placements);
		let leftover = false;
		try {
			// 持ち主が別のスペースの入力は開かずに持ち主の預け先へ回す。前倒しで開いた配置は既に
			// 画面にあるので触らない (次に預けるときに持ち主へ回る)。
			const diverted = this.divertForeignPlacements(stateKey, liveWorkingSet.placements.filter(placement => !this.earlyRestoredPlacements.has(placement)), liveWorkingSet.workingCopiesByEditor, 'restore');
			restoring = new Set(liveWorkingSet.placements.filter(placement => !diverted.has(placement)));
			// 先に開いた配置は開き直さない。選択の復元にだけ含める。
			const earlyRestored: { readonly group: IEditorGroup; readonly placement: IParadisLiveEditorPlacement }[] = [];
			const remaining: IParadisLiveEditorPlacement[] = [];
			for (const placement of liveWorkingSet.placements) {
				if (diverted.has(placement)) {
					continue;
				}
				if (this.earlyRestoredPlacements.has(placement)) {
					this.earlyRestoredPlacements.delete(placement);
					// 開いた後に利用者が別のグループ (補助ウィンドウを含む) へ動かしていることがある。
					// どこかで開いていれば開き直さない。閉じられていれば、それも利用者の意思として開かない。
					const [group] = this.groupsContaining(placement.editor);
					if (group !== undefined) {
						earlyRestored.push({ group, placement });
					}
				} else {
					remaining.push(placement);
				}
			}
			await this.restoreEditorPlacements(remaining, earlyRestored);
		} finally {
			leftover = this.settleRestoredDeposit(stateKey, liveWorkingSet.retentions, restoring);
		}
		// 開くのを待つ間に、このスペース宛ての入力が新しく預けられていた。今見せているスペースに
		// 預け先が残ると、次に離れるときの `captureScope` が投げてスペースから離れられなくなるので開く。
		if (leftover) {
			await this.restoreScope(stateKey);
		}
	}

	/**
	 * `restoreScope` の後片付け。開き始めた時点で控えた配置 (`restoring`) の分の握りだけを放し、預け先から外す。
	 *
	 * 預け先ごと捨ててはいけない。開くのを待っている間に、補助ウィンドウを閉じた・持ち主違いが回って
	 * きた等で同じ預け先へ別の入力が入ることがあり、入れ物ごと捨てるとその入力の握りが 0 になって
	 * (グループにも無いので) 破棄される。端末なら PTY ごと止まる。
	 */
	private settleRestoredDeposit(stateKey: string, retentions: DisposableStore, restoring: ReadonlySet<IParadisLiveEditorPlacement>): boolean {
		const current = this.liveWorkingSets.get(stateKey);
		if (current === undefined || current.retentions !== retentions) {
			// 持ち主違いを全部回して預け先が空になり、既に消えている (その後に作り直された預け先は
			// 別の入れ物を持つ)。元の入れ物に残っているのはここで開いた入力の握りだけなので、まとめて放してよい。
			retentions.dispose();
			return current !== undefined;
		}
		const kept = current.placements.filter(placement => !restoring.has(placement));
		const keptEditors = new Set(kept.map(placement => placement.editor));
		const released = new Set<EditorInput>();
		for (const placement of restoring) {
			if (!keptEditors.has(placement.editor)) {
				released.add(placement.editor);
			}
		}
		if (kept.length === 0) {
			this.liveWorkingSets.delete(stateKey);
			retentions.dispose();
			return false;
		}
		for (const editor of released) {
			this.releaseRetention(retentions, editor);
		}
		this.liveWorkingSets.set(stateKey, {
			placements: kept,
			workingCopiesByEditor: this.withoutEditors(current.workingCopiesByEditor, released),
			retentions
		});
		return true;
	}

	async restoreScopeEarly(stateKey: string, filter: (editor: EditorInput) => boolean): Promise<void> {
		const deposited = this.liveWorkingSets.get(stateKey);
		if (!deposited) {
			return;
		}
		// 持ち主が別のスペースの入力は開かない。持ち主の預け先へ回してから残りを見る。
		this.divertForeignPlacements(stateKey, deposited.placements.filter(placement => !this.earlyRestoredPlacements.has(placement)), deposited.workingCopiesByEditor, 'restore-early');
		const liveWorkingSet = this.liveWorkingSets.get(stateKey);
		if (!liveWorkingSet) {
			return;
		}
		const pending = liveWorkingSet.placements.filter(placement => !this.earlyRestoredPlacements.has(placement));
		const eligible = new Set(pending.filter(placement => this.canRestoreEarly(placement, liveWorkingSet, filter)));
		if (eligible.size === 0) {
			return;
		}
		const deferred = pending.filter(placement => !eligible.has(placement));
		// 位置の小さい順に開く。後から `restoreScope` が残りを元の位置へ差し込むので、ここでは
		// 「同じグループで自分より前にある、まだ開かない配置」の数だけ位置を詰める。こうすると
		// 両方が開き終わったときに元の並び順になる。
		const ordered = [...eligible].sort((left, right) => left.index - right.index);
		const restored: { readonly group: IEditorGroup; readonly placement: IParadisLiveEditorPlacement }[] = [];
		for (const placement of ordered) {
			const group = this.resolveRestoreGroup(placement);
			if (this.groupsContaining(placement.editor).length > 0) {
				// 既にどこかで開いている入力は触らない。印を付けると、巻き戻しで元々開いていたタブまで切り離す。
				continue;
			}
			const index = Math.max(0, placement.index - deferred.filter(other => other.groupId === placement.groupId
				&& other.windowId === placement.windowId
				&& other.index < placement.index).length);
			try {
				await group.openEditor(placement.editor, {
					index,
					pinned: placement.pinned,
					sticky: placement.sticky,
					transient: placement.transient,
					inactive: !placement.active,
					preserveFocus: true,
					viewState: placement.viewState
				});
			} catch (error) {
				this.logService.error('[ParadisEditorScope] Failed to restore a live editor early; leaving it for the regular restore', error);
			}
			if (group.contains(placement.editor, { strictEquals: true })) {
				// 開けた時点で印を付ける。途中で投げても、巻き戻しは開けた分だけを確実に切り離せる。
				this.earlyRestoredPlacements.add(placement);
				restored.push({ group, placement });
			}
		}
		for (const group of new Set(restored.map(entry => entry.group))) {
			const groupPlacements = restored.filter(entry => entry.group === group).map(entry => entry.placement);
			const active = groupPlacements.find(placement => placement.active)?.editor;
			if (active) {
				await group.setSelection(active, groupPlacements.filter(placement => placement.selected && placement.editor !== active).map(placement => placement.editor));
			}
		}
	}

	depositForeignLiveEditors(stateKey: string): void {
		if (!this.editorGroupsService.retainEditor) {
			return;
		}
		const { placements } = this.collectVisibleLiveEditorState(false, undefined, true);
		const byOwner = new Map<string, IParadisLiveEditorPlacement[]>();
		for (const placement of placements) {
			const owner = this.liveEditorOwner(placement.editor);
			if (owner === undefined || owner === stateKey || !this.editorGroupsService.getGroup(placement.groupId)?.detachEditor) {
				continue;
			}
			const entries = byOwner.get(owner) ?? [];
			entries.push(placement);
			byOwner.set(owner, entries);
		}
		for (const [owner, ownerPlacements] of byOwner) {
			try {
				// 作業コピーを持つ入力 (未保存のファイル) には持ち主の引き口が答えないので、ここに来るのは端末だけ。
				this.addToDeposit(owner, ownerPlacements, new Map(), 'carry-over');
				for (const placement of ownerPlacements) {
					this.editorGroupsService.getGroup(placement.groupId)?.detachEditor?.(placement.editor);
				}
				this.logService.warn(`[ParadisEditorScope] ${ownerPlacements.length} live editor(s) of another space were carried over into this space by the switch; moved them back to their own space`);
			} catch (error) {
				this.logService.error('[ParadisEditorScope] Failed to move carried-over live editors to the space that owns them; leaving them open here', error);
			}
		}
	}

	revertEarlyRestore(stateKey: string): void {
		const liveWorkingSet = this.liveWorkingSets.get(stateKey);
		if (!liveWorkingSet) {
			return;
		}
		for (const placement of liveWorkingSet.placements) {
			if (!this.earlyRestoredPlacements.has(placement)) {
				continue;
			}
			// 印は必ず外す。次にこのスペースへ戻ったとき、`restoreScope` が改めて開く。
			this.earlyRestoredPlacements.delete(placement);
			// 開いたグループだけでなく全グループ (補助ウィンドウを含む) から探す。前倒しから巻き戻しまでの
			// 間に利用者が別のグループへ動かしていると、元のグループだけ見ても見つからず、切り替え元の
			// スペースのタブとして残ってしまう。
			for (const group of this.groupsContaining(placement.editor)) {
				// `captureScope` と同じ切り離し方。入力は retain されたままなので、ターミナルは生きている。
				group.detachEditor?.(placement.editor);
			}
		}
	}

	/** その入力を開いている全グループ (補助ウィンドウを含む)。 */
	private groupsContaining(editor: EditorInput): IEditorGroup[] {
		return this.editorGroupsService.parts
			.flatMap(part => part.groups)
			.filter(group => group.contains(editor, { strictEquals: true }));
	}

	/** 先に開いてよい配置か。作業コピー (未保存の変更・無題) を持つ入力は必ず外す。 */
	private canRestoreEarly(placement: IParadisLiveEditorPlacement, liveWorkingSet: IParadisLiveWorkingSet, filter: (editor: EditorInput) => boolean): boolean {
		const editor = placement.editor;
		if (editor.isDisposed()
			|| editor instanceof SideBySideEditorInput
			|| editor.isModified()
			|| editor.hasCapability(EditorInputCapabilities.Untitled)
			|| editor.hasCapability(EditorInputCapabilities.Scratchpad)
			|| (liveWorkingSet.workingCopiesByEditor.get(editor)?.length ?? 0) > 0) {
			return false;
		}
		try {
			return filter(editor);
		} catch {
			return false;
		}
	}

	private async restoreEditorPlacements(placementsToRestore: readonly IParadisLiveEditorPlacement[], alreadyRestored: readonly { readonly group: IEditorGroup; readonly placement: IParadisLiveEditorPlacement }[] = []): Promise<void> {
		const opened: { readonly group: IEditorGroup; readonly editor: EditorInput }[] = [];
		const restoredPlacements: { readonly group: IEditorGroup; readonly placement: IParadisLiveEditorPlacement }[] = [];
		try {
			const placements = [...placementsToRestore].sort((left, right) => Number(left.active) - Number(right.active));
			for (const placement of placements) {
				const group = this.resolveRestoreGroup(placement);
				const wasOpen = group.contains(placement.editor, { strictEquals: true });
				try {
					await group.openEditor(placement.editor, {
						index: placement.index,
						pinned: placement.pinned,
						sticky: placement.sticky,
						transient: placement.transient,
						inactive: !placement.active,
						preserveFocus: true,
						viewState: placement.viewState
					});
					if (!group.contains(placement.editor, { strictEquals: true })) {
						throw new Error(`Failed to restore scoped editor ${placement.editor.getName()}`);
					}
				} catch (error) {
					// A single lost editor (e.g. disposed while parked) must not fail
					// the whole scope restore and roll back the entire space switch.
					// Leave it closed and continue restoring the rest of the scope.
					this.logService.error('[ParadisEditorScope] Failed to restore a scoped editor; leaving it closed', error);
					continue;
				}
				if (!wasOpen) {
					opened.push({ group, editor: placement.editor });
				}
				restoredPlacements.push({ group, placement });
			}

			// 先に開いた配置も選択の復元に含める (アクティブなタブや複数選択が両方にまたがりうる)。
			// ただし対象は、ここで何かを開いたグループだけ。先に開いた配置しか無いグループは
			// `restoreScopeEarly` が選択まで済ませており、その後に利用者が選び直したタブを奪わない。
			const selectionPlacements = [...alreadyRestored, ...restoredPlacements];
			for (const group of new Set(restoredPlacements.map(entry => entry.group))) {
				const groupPlacements = selectionPlacements.filter(entry => entry.group === group).map(entry => entry.placement);
				const active = groupPlacements.find(placement => placement.active)?.editor;
				if (active) {
					await group.setSelection(active, groupPlacements.filter(placement => placement.selected && placement.editor !== active).map(placement => placement.editor));
				}
			}
		} catch (error) {
			for (const { group, editor } of opened.reverse()) {
				group.detachEditor?.(editor);
			}
			throw error;
		}
	}

	beginSwitch(): void {
		this._isSwitching = true;
		this.legacyMigrationMode = false;
	}

	async commitSwitch(stateKey: string, uri: URI): Promise<void> {
		this.managedWorkspace = true;
		this._activeStateKey = stateKey;
		this.activeUri = uri;
		this._isSwitching = false;
	}

	async rollbackSwitch(stateKey: string | undefined, uri: URI | undefined): Promise<void> {
		this._activeStateKey = stateKey;
		this.activeUri = uri;
		this._isSwitching = false;
	}

	async leaveManagedWorkspace(): Promise<void> {
		this.managedWorkspace = false;
		this._activeStateKey = undefined;
		this._isSwitching = false;
		this.legacyMigrationMode = false;
		await this.restoreBackups();
	}

	async correctActiveScope(previousStateKey: string | undefined, stateKey: string, uri: URI): Promise<void> {
		if (previousStateKey !== undefined) {
			this.ownerLedger.rekey(previousStateKey, stateKey);
			const previousLiveState = this.liveWorkingSets.get(previousStateKey);
			if (previousLiveState && previousStateKey !== stateKey) {
				this.liveWorkingSets.delete(previousStateKey);
				if (this.liveWorkingSets.has(stateKey)) {
					// 新しいキーにも預け先がある (持ち主の預け先へ回ってきた入力)。上書きすると片方の握りを
					// 失うので、1 つにまとめてから元の入れ物を捨てる (先にまとめた側が握るので破棄されない)。
					this.addToDeposit(stateKey, previousLiveState.placements, previousLiveState.workingCopiesByEditor, 'correct');
					previousLiveState.retentions.dispose();
				} else {
					this.liveWorkingSets.set(stateKey, previousLiveState);
				}
			}
			this.saveOwnerLedger();
		}

		await this.commitSwitch(stateKey, uri);
		// このスペースは一度も離れていなくても、持ち主の預け先へ回ってきた入力の預け先を持ちうる
		// (別のスペースを離れるときに、このスペースの端末が見つかった)。今見せているスペースに預け先が
		// 残ると、端末が見えないうえ、次に離れるときの `captureScope` が投げてスペースから離れられない。
		// 開けなくてもバックアップの復元は必ず続ける。
		if (this.liveWorkingSets.has(stateKey)) {
			try {
				await this.restoreScope(stateKey);
			} catch (error) {
				this.logService.error('[ParadisEditorScope] Failed to open the live editors deposited with the corrected space', error);
			}
		}
		await this.restoreBackups();
	}

	restoreBackups(): Promise<void> {
		return this.backupRestoreRouter.requestRestore();
	}

	hasLiveState(stateKey: string): boolean {
		return this.liveWorkingSets.has(stateKey);
	}

	async hasRetirementData(stateKey: string): Promise<boolean> {
		if (this.liveWorkingSets.has(stateKey)) {
			return true;
		}
		// パーク中のターミナルは working set にも可視配置にも現れない。ここで拾わないと、
		// 「端末だけ置いてあるスペース」が退避データ無しと判定され、退役処理で PTY ごと破棄される
		if (paradisHasParkedTerminals(stateKey)) {
			return true;
		}
		if (this.collectVisibleLiveEditorState(false, stateKey).placements.length > 0) {
			return true;
		}

		const ownedKeys = new Set(this.ownerLedger.entries.filter(entry => entry.stateKey === stateKey).map(entry => this.identifierKey(entry.identifier)));
		return (await this.workingCopyBackupService.getBackups()).some(identifier => ownedKeys.has(this.identifierKey(identifier)));
	}

	async prepareScopeRetirement(stateKey: string): Promise<boolean> {
		if (this.preparedRetirements.has(stateKey)) {
			return true;
		}

		const liveWorkingSet = this.liveWorkingSets.get(stateKey);
		const visibleState = this.collectVisibleLiveEditorState(false, stateKey);
		const visiblePlacements = visibleState.placements;
		const retirementPlacements = liveWorkingSet
			? [...liveWorkingSet.placements, ...visiblePlacements]
			: visiblePlacements;
		const visibleEditors = new Set(visiblePlacements.map(placement => placement.editor));
		const workingCopiesByEditor = this.mergeWorkingCopyOwners(
			liveWorkingSet?.workingCopiesByEditor ?? new Map(),
			this.selectWorkingCopyOwners(visibleState.modifiedEditorOwners, visibleEditors)
		);
		const editorsToRevert: IParadisPreparedEditorRevert[] = [];
		const frozenRetentions = new DisposableStore();
		const frozenPlacements: IParadisLiveEditorPlacement[] = [];
		const frozenEditors = new Set<EditorInput>();
		try {
			if (retirementPlacements.length > 0) {
				const editors = [...new Set(retirementPlacements.map(placement => placement.editor))];
				for (const editor of editors) {
					const result = await this.prepareLiveEditorRetirement(editor, retirementPlacements, workingCopiesByEditor.get(editor) ?? []);
					if (!result.confirmed) {
						await this.restoreFrozenRetirement(stateKey, frozenPlacements, workingCopiesByEditor, frozenRetentions);
						return false;
					}
					if (result.editorToRevert) {
						editorsToRevert.push(result.editorToRevert);
					}
					this.freezeVisibleEditor(editor, visiblePlacements, frozenEditors, frozenPlacements, frozenRetentions);
				}
			}

			const ownedKeys = new Set(this.ownerLedger.entries.filter(entry => entry.stateKey === stateKey).map(entry => this.identifierKey(entry.identifier)));
			const backups = (await this.workingCopyBackupService.getBackups()).filter(identifier => ownedKeys.has(this.identifierKey(identifier)));
			const handledWorkingCopyKeys = new Set(
				[...workingCopiesByEditor.values()].flat().map(workingCopy => this.identifierKey(workingCopy))
			);
			const unrestoredBackups = backups.filter(identifier => !handledWorkingCopyKeys.has(this.identifierKey(identifier)));
			if (unrestoredBackups.length > 0) {
				const { confirmed } = await this.dialogService.confirm({
					type: 'warning',
					message: localize('paradis.editorScope.backupRetirementMessage', "このスペースには未保存のバックアップデータがあります。"),
					detail: localize('paradis.editorScope.backupRetirementDetail', "このスペースを削除すると、復元されていないエディタのバックアップは完全に失われます。"),
					primaryButton: localize('paradis.editorScope.backupRetirementConfirm', "バックアップを破棄して削除")
				});
				if (!confirmed) {
					await this.restoreFrozenRetirement(stateKey, frozenPlacements, workingCopiesByEditor, frozenRetentions);
					return false;
				}
			}

			const editors = [...new Set(retirementPlacements.map(placement => placement.editor))];
			const workingCopies = [...new Set(editors.flatMap(editor => [...(workingCopiesByEditor.get(editor) ?? [])]))];
			this.preparedRetirements.set(stateKey, {
				backups,
				editorsToRevert,
				editorStates: editors.map(editor => ({ editor, modified: editor.isModified() })),
				workingCopyStates: workingCopies.map(workingCopy => ({
					workingCopy,
					revision: this.workingCopyRevision(workingCopy),
					modified: workingCopy.isModified()
				})),
				handledWorkingCopyKeys,
				frozenPlacements,
				frozenWorkingCopiesByEditor: this.selectWorkingCopyOwners(workingCopiesByEditor, frozenEditors),
				frozenRetentions
			});
			return true;
		} catch (error) {
			await this.restoreFrozenRetirement(stateKey, frozenPlacements, workingCopiesByEditor, frozenRetentions);
			throw error;
		}
	}

	async cancelScopeRetirement(stateKey: string): Promise<void> {
		const retirement = this.preparedRetirements.get(stateKey);
		if (!retirement) {
			this.retirementFences.delete(stateKey);
			return;
		}
		this.preparedRetirements.delete(stateKey);
		this.retirementFences.delete(stateKey);
		await this.restoreFrozenRetirement(
			stateKey,
			retirement.frozenPlacements,
			retirement.frozenWorkingCopiesByEditor,
			retirement.frozenRetentions
		);
	}

	async retireScope(stateKey: string): Promise<boolean> {
		return this.retireScopes([stateKey]);
	}

	async retireScopes(stateKeys: readonly string[], onWillCommit?: () => void): Promise<boolean> {
		const uniqueStateKeys = [...new Set(stateKeys)];
		for (const stateKey of uniqueStateKeys) {
			if (!this.preparedRetirements.has(stateKey) && !await this.prepareScopeRetirement(stateKey)) {
				return false;
			}
		}

		const prepared = uniqueStateKeys.map(stateKey => ({ stateKey, retirement: this.preparedRetirements.get(stateKey) }));
		if (prepared.some(entry => entry.retirement === undefined)) {
			return false;
		}
		const validateAll = async (): Promise<readonly IWorkingCopyIdentifier[] | undefined> => {
			for (const entry of prepared) {
				if (!this.validatePreparedRetirementState(entry.stateKey, entry.retirement!)) {
					return undefined;
				}
			}
			const allBackups = await this.workingCopyBackupService.getBackups();
			for (const entry of prepared) {
				if (!this.validatePreparedRetirementState(entry.stateKey, entry.retirement!)
					|| !this.validatePreparedRetirementBackups(entry.stateKey, entry.retirement!, allBackups)) {
					return undefined;
				}
			}
			return allBackups;
		};

		const currentBackups = await validateAll();
		if (!currentBackups) {
			return false;
		}
		try {
			for (const entry of prepared) {
				this.freezeRetiringScope(entry.stateKey, entry.retirement!);
			}
			onWillCommit?.();
		} catch (error) {
			this.logService.error('[ParadisEditorScope] Failed to fence or journal a retiring editor scope', error);
			for (const stateKey of uniqueStateKeys) {
				try {
					await this.cancelScopeRetirement(stateKey);
				} catch (cancellationError) {
					this.logService.error('[ParadisEditorScope] Failed to restore a scope after retirement fencing failed', cancellationError);
				}
			}
			return false;
		}
		const retiredOwners = this.ownerLedger.entries.filter(entry => uniqueStateKeys.includes(entry.stateKey));
		try {
			this.stagePendingBackupDiscards(retiredOwners);
		} catch (error) {
			this.logService.error('[ParadisEditorScope] Failed to persist committed scope-retirement cleanup', error);
			return false;
		}
		for (const { retirement } of prepared) {
			for (const { editor, groupId, workingCopies } of retirement!.editorsToRevert) {
				try {
					await editor.revert(groupId);
				} catch (error) {
					this.logService.error('[ParadisEditorScope] Editor revert failed during scope retirement', error);
					try {
						await editor.revert(groupId, { soft: true });
					} catch (softRevertError) {
						this.logService.error('[ParadisEditorScope] Editor soft revert failed during scope retirement', softRevertError);
					}
				}
				if (editor.isModified() || workingCopies.some(workingCopy => workingCopy.isModified())) {
					this.logService.warn('[ParadisEditorScope] Confirmed editor remained modified during committed scope retirement');
				}
			}
		}

		const failedBackupDiscards = new Map<string, { readonly identifier: IWorkingCopyIdentifier; readonly stateKey: string }>();
		for (const { stateKey, retirement } of prepared) {
			const ownedKeys = new Set(this.ownerLedger.entries.filter(entry => entry.stateKey === stateKey).map(entry => this.identifierKey(entry.identifier)));
			const scopedCurrentBackups = currentBackups.filter(identifier => ownedKeys.has(this.identifierKey(identifier)));
			const backupsToDiscard = new Map([...retirement!.backups, ...scopedCurrentBackups].map(identifier => [this.identifierKey(identifier), identifier]));
			for (const identifier of backupsToDiscard.values()) {
				try {
					await this.workingCopyBackupService.discardBackup(identifier);
					if (await this.workingCopyBackupService.resolve(identifier) !== undefined) {
						throw new Error('Backup is still present after discard');
					}
				} catch (error) {
					this.logService.error('[ParadisEditorScope] Backup discard failed during committed scope retirement; retrying in the background', error);
					failedBackupDiscards.set(this.identifierKey(identifier), { identifier, stateKey });
				}
			}
		}

		const retentionsToDispose: DisposableStore[] = [];
		for (const stateKey of uniqueStateKeys) {
			this.preparedRetirements.delete(stateKey);
			const liveWorkingSet = this.liveWorkingSets.get(stateKey);
			if (liveWorkingSet) {
				this.liveWorkingSets.delete(stateKey);
				retentionsToDispose.push(liveWorkingSet.retentions);
			}
			retentionsToDispose.push(prepared.find(entry => entry.stateKey === stateKey)!.retirement!.frozenRetentions);
			for (const entry of retiredOwners.filter(entry => entry.stateKey === stateKey)) {
				if (!failedBackupDiscards.has(this.identifierKey(entry.identifier))) {
					this.ownerLedger.release(entry.identifier, stateKey);
				}
			}
		}
		let ownerLedgerSaved = false;
		try {
			this.saveOwnerLedger();
			ownerLedgerSaved = true;
		} catch (error) {
			// Destructive work is already committed. Continue finalizing all scopes;
			// retaining an old owner entry is safer than leaving half the batch live.
			for (const entry of retiredOwners) {
				this.ownerLedger.assign(entry.identifier, entry.stateKey);
			}
			this.logService.error('[ParadisEditorScope] Failed to persist retired Working Copy ownership', error);
		}
		for (const retentions of retentionsToDispose) {
			try {
				retentions.dispose();
			} catch (error) {
				this.logService.error('[ParadisEditorScope] Failed to dispose retired editor retentions', error);
			}
		}
		if (ownerLedgerSaved) {
			for (const entry of retiredOwners) {
				if (!failedBackupDiscards.has(this.identifierKey(entry.identifier))) {
					try {
						this.completePendingBackupDiscard(entry.identifier, entry.stateKey);
					} catch (error) {
						this.logService.error('[ParadisEditorScope] Failed to persist completed backup cleanup; retrying in the background', error);
						failedBackupDiscards.set(this.identifierKey(entry.identifier), entry);
					}
				}
			}
		} else {
			for (const entry of retiredOwners) {
				failedBackupDiscards.set(this.identifierKey(entry.identifier), entry);
			}
		}
		for (const pending of failedBackupDiscards.values()) {
			this.schedulePendingBackupDiscard(pending.identifier, pending.stateKey);
		}
		return true;
	}

	completeScopeRetirement(stateKey: string): void {
		this.retirementFences.delete(stateKey);
	}

	registerLiveEditorOwnerResolver(resolver: (editor: EditorInput) => string | undefined): IDisposable {
		this.liveEditorOwnerResolver = resolver;
		return toDisposable(() => {
			if (this.liveEditorOwnerResolver === resolver) {
				this.liveEditorOwnerResolver = undefined;
			}
		});
	}

	isRetiringScope(stateKey: string): boolean {
		return this.retirementFences.has(stateKey);
	}

	/**
	 * 入力の明示的な持ち主のスペース。分からない・持ち主のスペースが既に無い・削除の途中なら undefined
	 * (判定は引く口が持つ。切り替えサービスの `availableOwnerScope` で、park 先と同じ判定)。undefined の
	 * 入力は今までどおり呼び出し元のスペースの持ち物として扱う (二度と開かれない預け先へ入れて、生きたまま
	 * 見えなくなるのを防ぐ)。
	 */
	private liveEditorOwner(editor: EditorInput): string | undefined {
		try {
			return this.liveEditorOwnerResolver?.(editor);
		} catch (error) {
			this.logService.error('[ParadisEditorScope] Failed to resolve the owner space of a live editor; keeping it where it is', error);
			return undefined;
		}
	}

	/** スペース `stateKey` を預けるときの、この入力の預け先。持ち主が別のスペースならそちら。 */
	private depositKeyFor(editor: EditorInput, stateKey: string): string {
		return this.liveEditorOwner(editor) ?? stateKey;
	}

	/**
	 * 預け先 `stateKey` の配置のうち、持ち主が別のスペースのものを持ち主の預け先へ移す。
	 * 移した配置を返す (呼び出し元はそれを開かない)。
	 */
	private divertForeignPlacements(stateKey: string, placements: readonly IParadisLiveEditorPlacement[], workingCopiesByEditor: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>, phase: ParadisLiveDepositPhase): ReadonlySet<IParadisLiveEditorPlacement> {
		const byOwner = new Map<string, IParadisLiveEditorPlacement[]>();
		for (const placement of placements) {
			if (placement.editor.isDisposed()) {
				continue;
			}
			const owner = this.liveEditorOwner(placement.editor);
			if (owner === undefined || owner === stateKey) {
				continue;
			}
			const entries = byOwner.get(owner) ?? [];
			entries.push(placement);
			byOwner.set(owner, entries);
		}
		const diverted = new Set<IParadisLiveEditorPlacement>();
		for (const [owner, ownerPlacements] of byOwner) {
			try {
				const editors = new Set(ownerPlacements.map(placement => placement.editor));
				this.addToDeposit(owner, ownerPlacements, this.selectWorkingCopyOwners(workingCopiesByEditor, editors), phase, stateKey);
				for (const placement of ownerPlacements) {
					diverted.add(placement);
				}
				this.logService.warn(`[ParadisEditorScope] ${ownerPlacements.length} live editor(s) deposited with one space belong to another; moved them to their own space instead of opening them here`);
			} catch (error) {
				// 回せなければ今までどおり開く。見えなくなるより、違うスペースに出る方がまし。
				this.logService.error('[ParadisEditorScope] Failed to move live editors to the space that owns them; restoring them here', error);
			}
		}
		return diverted;
	}

	/**
	 * 生きた入力を預け先 `stateKey` へ入れる。**1 つの入力は 1 つの預け先にしか置かない。**
	 * 他の預け先が同じ入力を握っていれば、そちらからは外す。二重に握ると、どちらのスペースへ
	 * 戻っても同じタブが開き直され、往復のたびに再生産されて自然には直らない。
	 *
	 * 先にこの預け先で握ってから、他の預け先の握りを放す。逆にすると、どこにも握られていない
	 * 一瞬に入力が破棄される (`retainEditor` の握りが 0 になり、グループにも無い入力は dispose される)。
	 *
	 * @param movingFrom 持ち主違いを回すときの元の預け先。そこから外すのは想定どおりなので、二重に
	 * 握っていた記録には数えない。
	 */
	private addToDeposit(stateKey: string, placements: readonly IParadisLiveEditorPlacement[], workingCopiesByEditor: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>, phase: ParadisLiveDepositPhase, movingFrom?: string): void {
		if (!this.editorGroupsService.retainEditor) {
			throw new Error('Editor input retention is not available');
		}
		const editors = new Set(placements.map(placement => placement.editor));
		const existing = this.liveWorkingSets.get(stateKey);
		const retentions = existing?.retentions ?? new DisposableStore();
		try {
			for (const editor of editors) {
				if (!this.holdsRetention(retentions, editor)) {
					this.retainInto(retentions, editor);
				}
			}
		} catch (error) {
			if (!existing) {
				retentions.dispose();
			}
			throw error;
		}
		// 同じ預け先の中でも入力は 1 か所。古い配置は新しい配置で置き換える。
		const kept = existing?.placements.filter(placement => !editors.has(placement.editor)) ?? [];
		this.liveWorkingSets.set(stateKey, {
			placements: [...kept, ...placements],
			workingCopiesByEditor: this.mergeWorkingCopyOwners(
				existing ? this.withoutEditors(existing.workingCopiesByEditor, editors) : new Map(),
				workingCopiesByEditor
			),
			retentions
		});

		const holders = this.removeFromOtherDeposits(editors, stateKey);
		const doubleHolders = holders.filter(holder => holder !== movingFrom);
		if (doubleHolders.length > 0) {
			this.reportDoubleDeposit(phase, doubleHolders.length);
		}
	}

	/**
	 * `editors` を `exceptStateKey` 以外の預け先から外し、その預け先が持っていた握りを放す。
	 * 外した入力を握っていた預け先のキーを返す (入力 1 つにつき 1 件)。
	 */
	private removeFromOtherDeposits(editors: ReadonlySet<EditorInput>, exceptStateKey: string): string[] {
		const holders: string[] = [];
		for (const [stateKey, liveWorkingSet] of [...this.liveWorkingSets]) {
			if (stateKey === exceptStateKey) {
				continue;
			}
			const removed = new Set(liveWorkingSet.placements.filter(placement => editors.has(placement.editor)).map(placement => placement.editor));
			if (removed.size === 0) {
				continue;
			}
			for (const editor of removed) {
				holders.push(stateKey);
				this.releaseRetention(liveWorkingSet.retentions, editor);
			}
			const placements = liveWorkingSet.placements.filter(placement => !removed.has(placement.editor));
			if (placements.length === 0) {
				this.liveWorkingSets.delete(stateKey);
				liveWorkingSet.retentions.dispose();
				continue;
			}
			this.liveWorkingSets.set(stateKey, {
				placements,
				workingCopiesByEditor: this.withoutEditors(liveWorkingSet.workingCopiesByEditor, removed),
				retentions: liveWorkingSet.retentions
			});
		}
		return holders;
	}

	/**
	 * 同じ入力を 2 つの預け先が握っていたのを見つけた。ここで 1 つに直したが、どこかの経路が
	 * 二重に入れたことを意味するので、ログと Sentry に残す (中身は載せない。件数と経路だけ)。
	 */
	private reportDoubleDeposit(phase: ParadisLiveDepositPhase, count: number): void {
		this.logService.warn(`[ParadisEditorScope] ${count} live editor(s) were held by more than one space at once (${phase}); kept them only in the space they belong to`);
		reportParadisDiagnosticError('owned', 'workspace-switch', 'live-editor-double-deposit', new Error('A live editor was deposited with more than one space'), {
			safe_phase: phase,
			safe_count: count,
		}, 'warning');
	}

	private retainInto(store: DisposableStore, editor: EditorInput): void {
		const handle = store.add(this.editorGroupsService.retainEditor!(editor));
		const entries = (this.retentionHandles.get(editor) ?? []).filter(entry => !entry.store.isDisposed);
		entries.push({ handle, store });
		this.retentionHandles.set(editor, entries);
	}

	private holdsRetention(store: DisposableStore, editor: EditorInput): boolean {
		return !store.isDisposed && (this.retentionHandles.get(editor) ?? []).some(entry => entry.store === store);
	}

	/** `store` が持つ `editor` の握りだけを放す。他の入れ物の握りには触らない。 */
	private releaseRetention(store: DisposableStore, editor: EditorInput): void {
		const entries = this.retentionHandles.get(editor);
		if (!entries) {
			return;
		}
		const remaining: { readonly handle: IDisposable; store: DisposableStore }[] = [];
		for (const entry of entries) {
			if (entry.store.isDisposed) {
				continue;
			}
			if (entry.store === store) {
				store.delete(entry.handle);
			} else {
				remaining.push(entry);
			}
		}
		this.retentionHandles.set(editor, remaining);
	}

	private withoutEditors(owners: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>, editors: ReadonlySet<EditorInput>): ReadonlyMap<EditorInput, readonly IWorkingCopy[]> {
		const result = new Map<EditorInput, readonly IWorkingCopy[]>();
		for (const [editor, workingCopies] of owners) {
			if (!editors.has(editor)) {
				result.set(editor, workingCopies);
			}
		}
		return result;
	}

	private freezeRetiringScope(stateKey: string, retirement: IParadisPreparedRetirement): void {
		if (this.retirementFences.has(stateKey)) {
			return;
		}

		// Install the synchronous fence before enumerating or detaching editors. No
		// user input or extension callback can open another editor into the scope
		// between the final validation and the complete-scope snapshot.
		this.retirementFences.add(stateKey);
		const visibleState = this.collectVisibleLiveEditorState(true, stateKey, false, undefined, true);
		const frozenEditors = new Set(retirement.frozenPlacements.map(placement => placement.editor));
		const visibleEditors = new Set(visibleState.placements.map(placement => placement.editor));
		for (const editor of visibleEditors) {
			this.freezeVisibleEditor(editor, visibleState.placements, frozenEditors, retirement.frozenPlacements, retirement.frozenRetentions);
		}

		const existingEditors = new Set(retirement.editorStates.map(state => state.editor));
		for (const editor of visibleEditors) {
			if (!existingEditors.has(editor)) {
				retirement.editorStates.push({ editor, modified: editor.isModified() });
			}
		}

		const additionalWorkingCopies = this.selectWorkingCopyOwners(visibleState.modifiedEditorOwners, visibleEditors);
		retirement.frozenWorkingCopiesByEditor = this.mergeWorkingCopyOwners(retirement.frozenWorkingCopiesByEditor, additionalWorkingCopies);
		const existingWorkingCopies = new Set(retirement.workingCopyStates.map(state => state.workingCopy));
		for (const workingCopy of [...additionalWorkingCopies.values()].flat()) {
			retirement.handledWorkingCopyKeys.add(this.identifierKey(workingCopy));
			if (!existingWorkingCopies.has(workingCopy)) {
				retirement.workingCopyStates.push({
					workingCopy,
					revision: this.workingCopyRevision(workingCopy),
					modified: workingCopy.isModified()
				});
				existingWorkingCopies.add(workingCopy);
			}
		}
	}

	private isEditorGroupFenced(groupId: GroupIdentifier): boolean {
		if (this.retirementFences.size === 0) {
			return false;
		}
		const group = this.editorGroupsService.getGroup(groupId);
		if (!group) {
			return false;
		}
		const scope = this.auxiliaryWindowScopeService.resolveGroup(group);
		return scope.kind === 'managed' && this.retirementFences.has(scope.stateKey);
	}

	private async prepareLiveEditorRetirement(editor: EditorInput, placements: readonly IParadisLiveEditorPlacement[], workingCopies: readonly IWorkingCopy[]): Promise<{ readonly confirmed: boolean; readonly editorToRevert?: IParadisPreparedEditorRevert }> {
		let shouldConfirm = editor.isModified() || workingCopies.some(workingCopy => workingCopy.isModified());
		let closeHandlerWantsConfirm = false;
		if (editor.closeHandler) {
			try {
				closeHandlerWantsConfirm = editor.closeHandler.showConfirm();
				shouldConfirm ||= closeHandlerWantsConfirm;
			} catch (error) {
				this.logService.error('[ParadisEditorScope] Editor close handler failed during scope retirement', error);
				shouldConfirm = true;
			}
		}
		if (!shouldConfirm) {
			return { confirmed: true };
		}

		const placement = placements.find(candidate => candidate.editor === editor);
		if (!placement) {
			return { confirmed: false };
		}

		let confirmation: ConfirmResult;
		if (editor.closeHandler && closeHandlerWantsConfirm) {
			try {
				confirmation = await editor.closeHandler.confirm([{ editor, groupId: placement.groupId }]);
			} catch (error) {
				this.logService.error('[ParadisEditorScope] Editor close confirmation failed during scope retirement', error);
				return { confirmed: false };
			}
		} else {
			confirmation = await this.fileDialogService.showSaveConfirm([editor.getName()]);
		}

		switch (confirmation) {
			case ConfirmResult.SAVE: {
				const saved = await editor.save(placement.groupId, { reason: SaveReason.EXPLICIT });
				return { confirmed: saved !== undefined && !editor.isModified() && workingCopies.every(workingCopy => !workingCopy.isModified()) };
			}
			case ConfirmResult.DONT_SAVE:
				return { confirmed: true, editorToRevert: { editor, groupId: placement.groupId, workingCopies } };
			case ConfirmResult.CANCEL:
				return { confirmed: false };
		}
	}

	private validatePreparedRetirementBackups(stateKey: string, retirement: IParadisPreparedRetirement, allBackups: readonly IWorkingCopyIdentifier[]): boolean {
		const preparedBackupKeys = new Set(retirement.backups.map(identifier => this.identifierKey(identifier)));
		const ownedKeys = new Set(this.ownerLedger.entries.filter(entry => entry.stateKey === stateKey).map(entry => this.identifierKey(entry.identifier)));
		return allBackups
			.filter(identifier => ownedKeys.has(this.identifierKey(identifier)))
			.every(identifier => {
				const key = this.identifierKey(identifier);
				return preparedBackupKeys.has(key) || retirement.handledWorkingCopyKeys.has(key);
			});
	}

	private validatePreparedRetirementState(stateKey: string, retirement: IParadisPreparedRetirement): boolean {
		const preparedEditors = new Set(retirement.editorStates.map(({ editor }) => editor));
		const currentEditors = new Set([
			...(this.liveWorkingSets.get(stateKey)?.placements ?? []),
			...this.collectVisibleLiveEditorState(false, stateKey).placements,
		].map(placement => placement.editor));
		if ([...currentEditors].some(editor => !preparedEditors.has(editor))) {
			return false;
		}
		for (const workingCopy of this.workingCopyService.modifiedWorkingCopies) {
			if (this.ownerLedger.ownerOf(workingCopy) === stateKey && !retirement.handledWorkingCopyKeys.has(this.identifierKey(workingCopy))) {
				return false;
			}
		}

		for (const { editor, modified } of retirement.editorStates) {
			if (editor.isModified() !== modified) {
				return false;
			}
		}

		for (const { workingCopy, revision, modified } of retirement.workingCopyStates) {
			const current = this.workingCopyService.get(workingCopy);
			if (current !== undefined && current !== workingCopy) {
				return false;
			}
			if (this.workingCopyRevision(workingCopy) !== revision || workingCopy.isModified() !== modified) {
				return false;
			}
		}

		return true;
	}

	private schedulePendingBackupDiscard(identifier: IWorkingCopyIdentifier, stateKey: string): void {
		const key = this.identifierKey(identifier);
		const cancellation = new CancellationTokenSource();
		const disposables = new DisposableStore();
		disposables.add(toDisposable(() => cancellation.dispose(true)));
		this.pendingBackupDiscards.set(key, disposables);
		void (async () => {
			let retryDelay = 50;
			try {
				while (!cancellation.token.isCancellationRequested) {
					await timeout(retryDelay, cancellation.token);
					try {
						const owner = this.ownerLedger.ownerOf(identifier);
						if (owner !== stateKey) {
							// An absent owner means the old cleanup already committed. If a backup
							// exists now it is ambiguous/new and must never be deleted by stale intent.
							this.completePendingBackupDiscard(identifier, stateKey);
							return;
						}
						if (await this.workingCopyBackupService.resolve(identifier) !== undefined) {
							await this.workingCopyBackupService.discardBackup(identifier, cancellation.token);
							if (cancellation.token.isCancellationRequested || await this.workingCopyBackupService.resolve(identifier) !== undefined) {
								continue;
							}
						}
						if (this.ownerLedger.release(identifier, stateKey)) {
							try {
								this.saveOwnerLedger();
							} catch (error) {
								this.ownerLedger.assign(identifier, stateKey);
								throw error;
							}
						}
						this.completePendingBackupDiscard(identifier, stateKey);
						return;
					} catch (error) {
						if (!cancellation.token.isCancellationRequested) {
							this.logService.warn('[ParadisEditorScope] Pending retired backup cleanup failed; it will be retried', error);
						}
					}
					retryDelay = Math.min(retryDelay * 2, 30_000);
				}
			} finally {
				if (this.pendingBackupDiscards.get(key) === disposables) {
					this.pendingBackupDiscards.deleteAndDispose(key);
				}
			}
		})();
	}

	private loadPendingBackupDiscards(): void {
		const raw = this.storageService.get(PARADIS_PENDING_BACKUP_DISCARDS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (raw === undefined) {
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				throw new Error('Expected an array');
			}
			for (const candidate of parsed) {
				if (!candidate || typeof candidate.resource !== 'string' || typeof candidate.typeId !== 'string' || typeof candidate.stateKey !== 'string') {
					throw new Error('Invalid pending backup discard entry');
				}
				const identifier = { resource: URI.parse(candidate.resource), typeId: candidate.typeId };
				this.pendingBackupDiscardJournal.set(this.identifierKey(identifier), { identifier, stateKey: candidate.stateKey });
			}
		} catch (error) {
			// Corrupt cleanup intent must not become permission to discard a backup.
			this.pendingBackupDiscardJournal.clear();
			this.logService.error('[ParadisEditorScope] Pending backup discard journal is corrupt; leaving backups untouched', error);
		}
	}

	private stagePendingBackupDiscards(entries: readonly { readonly identifier: IWorkingCopyIdentifier; readonly stateKey: string }[]): void {
		const previous = new Map(this.pendingBackupDiscardJournal);
		for (const entry of entries) {
			this.pendingBackupDiscardJournal.set(this.identifierKey(entry.identifier), entry);
		}
		try {
			this.savePendingBackupDiscards();
		} catch (error) {
			this.pendingBackupDiscardJournal.clear();
			for (const [key, entry] of previous) {
				this.pendingBackupDiscardJournal.set(key, entry);
			}
			throw error;
		}
	}

	private completePendingBackupDiscard(identifier: IWorkingCopyIdentifier, stateKey: string): void {
		const key = this.identifierKey(identifier);
		const pending = this.pendingBackupDiscardJournal.get(key);
		if (pending?.stateKey !== stateKey) {
			return;
		}
		this.pendingBackupDiscardJournal.delete(key);
		try {
			this.savePendingBackupDiscards();
		} catch (error) {
			this.pendingBackupDiscardJournal.set(key, pending);
			throw error;
		}
	}

	private savePendingBackupDiscards(): void {
		if (this.pendingBackupDiscardJournal.size === 0) {
			this.storageService.remove(PARADIS_PENDING_BACKUP_DISCARDS_STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}
		const serialized: ISerializedPendingBackupDiscard[] = [...this.pendingBackupDiscardJournal.values()].map(entry => ({
			resource: entry.identifier.resource.toString(),
			typeId: entry.identifier.typeId,
			stateKey: entry.stateKey
		}));
		this.storageService.store(PARADIS_PENDING_BACKUP_DISCARDS_STORAGE_KEY, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private freezeVisibleEditor(editor: EditorInput, visiblePlacements: readonly IParadisLiveEditorPlacement[], frozenEditors: Set<EditorInput>, frozenPlacements: IParadisLiveEditorPlacement[], retentions: DisposableStore): void {
		const placements = visiblePlacements.filter(placement => placement.editor === editor);
		if (placements.length === 0 || frozenEditors.has(editor)) {
			return;
		}
		if (!this.editorGroupsService.retainEditor) {
			throw new Error('Editor input retention is not available');
		}
		for (const placement of placements) {
			if (!this.editorGroupsService.getGroup(placement.groupId)?.detachEditor) {
				throw new Error('Editor input detach is not available');
			}
		}

		this.retainInto(retentions, editor);
		frozenEditors.add(editor);
		frozenPlacements.push(...placements);
		for (const placement of placements) {
			this.editorGroupsService.getGroup(placement.groupId)?.detachEditor?.(editor);
		}
	}

	private async restoreFrozenRetirement(stateKey: string, placements: readonly IParadisLiveEditorPlacement[], workingCopiesByEditor: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>, retentions: DisposableStore): Promise<void> {
		if (placements.length === 0) {
			retentions.dispose();
			return;
		}
		const restorable = placements.filter(placement => {
			const group = this.editorGroupsService.getGroup(placement.groupId);
			if (!group) {
				return this._activeStateKey === stateKey;
			}
			const scope = this.auxiliaryWindowScopeService.resolveGroup(group);
			return scope.kind === 'managed' && scope.stateKey === stateKey;
		});
		let deferred = placements.filter(placement => !restorable.includes(placement));
		if (restorable.length > 0) {
			try {
				await this.restoreEditorPlacements(restorable);
			} catch (error) {
				deferred = [...placements];
				this.logService.error('[ParadisEditorScope] Failed to restore frozen editors; retained them as scoped live state', error);
			}
		}
		if (deferred.length === 0) {
			retentions.dispose();
			return;
		}
		const deferredEditors = new Set(deferred.map(placement => placement.editor));
		try {
			// 預け先が自分で握ってから、凍結の握りを放す (`addToDeposit` の説明参照)。
			this.addToDeposit(stateKey, deferred, this.selectWorkingCopyOwners(workingCopiesByEditor, deferredEditors), 'retirement-cancel');
		} finally {
			retentions.dispose();
		}
	}

	private selectWorkingCopyOwners(owners: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>, editors: ReadonlySet<EditorInput>): ReadonlyMap<EditorInput, readonly IWorkingCopy[]> {
		const selected = new Map<EditorInput, readonly IWorkingCopy[]>();
		for (const editor of editors) {
			const workingCopies = owners.get(editor);
			if (workingCopies?.length) {
				selected.set(editor, [...workingCopies]);
			}
		}
		return selected;
	}

	private mergeWorkingCopyOwners(...ownerMaps: readonly ReadonlyMap<EditorInput, readonly IWorkingCopy[]>[]): ReadonlyMap<EditorInput, readonly IWorkingCopy[]> {
		const merged = new Map<EditorInput, readonly IWorkingCopy[]>();
		for (const owners of ownerMaps) {
			for (const [editor, workingCopies] of owners) {
				merged.set(editor, [...new Set([...(merged.get(editor) ?? []), ...workingCopies])]);
			}
		}
		return merged;
	}

	private ensureWorkingCopyRevision(workingCopy: IWorkingCopy): void {
		if (!this.workingCopyRevisions.has(workingCopy)) {
			this.workingCopyRevisions.set(workingCopy, 0);
		}
	}

	private workingCopyRevision(workingCopy: IWorkingCopy): number {
		return this.workingCopyRevisions.get(workingCopy) ?? 0;
	}

	private onDidChangeWorkingCopyModifiedState(workingCopy: IWorkingCopy): void {
		if (workingCopy.isModified()) {
			this.pendingOwnerReleases.deleteAndDispose(this.identifierKey(workingCopy));
			this.observeModifiedWorkingCopy(workingCopy);
		} else {
			this.releaseWorkingCopyOwnerWhenSafe(workingCopy);
		}
	}

	private releaseWorkingCopyOwnerWhenSafe(workingCopy: IWorkingCopy): void {
		if (workingCopy.isModified()) {
			return;
		}
		const owner = this.ownerLedger.ownerOf(workingCopy);
		if (owner === undefined) {
			return;
		}

		const key = this.identifierKey(workingCopy);
		const revision = this.workingCopyRevision(workingCopy);
		const cancellation = new CancellationTokenSource();
		const disposables = new DisposableStore();
		disposables.add(toDisposable(() => cancellation.dispose(true)));
		this.pendingOwnerReleases.set(key, disposables);
		void (async () => {
			try {
				// The upstream backup tracker owns backup deletion. Calling discardBackup
				// here would race a subsequent edit and could delete its newer backup.
				// Keep this release pending until the tracker deletion is observable, or
				// until a new revision/owner/Working Copy cancels this attempt.
				let attempt = 0;
				while (!cancellation.token.isCancellationRequested) {
					await timeout(paradisOwnerReleaseRetryDelay(attempt++), cancellation.token);
					const current = this.workingCopyService.get(workingCopy);
					if (workingCopy.isModified()
						|| this.workingCopyRevision(workingCopy) !== revision
						|| (current !== undefined && current !== workingCopy)
						|| this.ownerLedger.ownerOf(workingCopy) !== owner) {
						return;
					}
					try {
						if (await this.workingCopyBackupService.resolve(workingCopy) !== undefined) {
							continue;
						}
					} catch (error) {
						if (!cancellation.token.isCancellationRequested) {
							this.logService.warn('[ParadisEditorScope] Failed to inspect a clean Working Copy backup; owner release remains pending', error);
						}
						continue;
					}
					const currentAfterResolve = this.workingCopyService.get(workingCopy);
					if (workingCopy.isModified()
						|| this.workingCopyRevision(workingCopy) !== revision
						|| (currentAfterResolve !== undefined && currentAfterResolve !== workingCopy)) {
						return;
					}
					if (this.ownerLedger.release(workingCopy, owner)) {
						try {
							this.saveOwnerLedger();
						} catch (error) {
							this.ownerLedger.assign(workingCopy, owner);
							throw error;
						}
					}
					return;
				}
			} catch (error) {
				if (!cancellation.token.isCancellationRequested) {
					this.logService.error('[ParadisEditorScope] Failed to verify saved Working Copy ownership release', error);
				}
			} finally {
				if (this.pendingOwnerReleases.get(key) === disposables) {
					this.pendingOwnerReleases.deleteAndDispose(key);
				}
			}
		})();
	}

	private identifierKey(identifier: IWorkingCopyIdentifier): string {
		return JSON.stringify([identifier.resource.toString(), identifier.typeId]);
	}

	private resolveRestoreGroup(placement: IParadisLiveEditorPlacement): IEditorGroup {
		return this.editorGroupsService.getGroup(placement.groupId)
			?? this.editorGroupsService.parts.find(part => part.windowId === placement.windowId)?.activeGroup
			?? this.editorGroupsService.mainPart.activeGroup;
	}

	private collectModifiedEditorOwners(): Map<EditorInput, IWorkingCopy[]> {
		const result = new Map<EditorInput, IWorkingCopy[]>();
		for (const workingCopy of this.workingCopyService.modifiedWorkingCopies) {
			const editorIdentifier = this.workingCopyEditorService.findEditor(workingCopy);
			if (!editorIdentifier) {
				continue;
			}

			const entries = result.get(editorIdentifier.editor) ?? [];
			entries.push(workingCopy);
			result.set(editorIdentifier.editor, entries);
		}
		return result;
	}

	private collectVisibleLiveEditorState(requireDetach: boolean, stateKey?: string, mainPartOnly = false, exactPart?: IEditorPart, includeClean = false): { readonly modifiedEditorOwners: Map<EditorInput, IWorkingCopy[]>; readonly placements: readonly IParadisLiveEditorPlacement[] } {
		const modifiedEditorOwners = this.collectModifiedEditorOwners();
		const modifiedEditors = new Set(modifiedEditorOwners.keys());
		const placements: IParadisLiveEditorPlacement[] = [];

		for (const part of this.editorGroupsService.parts) {
			if (exactPart && part !== exactPart) {
				continue;
			}
			if (mainPartOnly && part !== this.editorGroupsService.mainPart) {
				continue;
			}
			if (stateKey !== undefined && !mainPartOnly) {
				const partScope = this.auxiliaryWindowScopeService.resolvePart(part);
				if (partScope.kind !== 'managed' || partScope.stateKey !== stateKey) {
					continue;
				}
			}
			for (const group of part.groups) {
				for (const [index, editor] of group.getEditors(EditorsOrder.SEQUENTIAL).entries()) {
					if (!includeClean && !paradisEditorRequiresScopedLiveState(editor, modifiedEditors)) {
						continue;
					}
					if (requireDetach && !group.detachEditor) {
						throw new Error('Editor input detach is not available');
					}

					placements.push({
						editor,
						groupId: group.id,
						windowId: group.windowId,
						index,
						active: group.activeEditor === editor,
						selected: group.isSelected(editor),
						pinned: group.isPinned(editor),
						sticky: group.isSticky(editor),
						transient: group.isTransient(editor),
						viewState: group.activeEditor === editor ? group.activeEditorPane?.getViewState() : undefined
					});
				}
			}
		}

		return { modifiedEditorOwners, placements };
	}

	private observeModifiedWorkingCopy(workingCopy: IWorkingCopy): void {
		if (!workingCopy.isModified() || this._isSwitching) {
			return;
		}
		const editorIdentifier = this.workingCopyEditorService.findEditor(workingCopy);
		if (!editorIdentifier) {
			return;
		}
		const group = this.editorGroupsService.getGroup(editorIdentifier.groupId);
		if (!group) {
			return;
		}
		const scope = this.auxiliaryWindowScopeService.resolveGroup(group);
		if (scope.kind === 'managed' && this.retirementFences.has(scope.stateKey)) {
			return;
		}
		if (scope.kind === 'managed' && this.ownerLedger.ownerOf(workingCopy) === undefined) {
			this.claimWorkingCopy(workingCopy, scope.stateKey);
		}
	}

	private claimWorkingCopy(identifier: IWorkingCopyIdentifier, stateKey: string): void {
		if (this.retirementFences.has(stateKey)) {
			throw new Error(`Working Copy cannot enter a retiring Para Code scope: ${identifier.resource.toString()}`);
		}
		this.pendingOwnerReleases.deleteAndDispose(this.identifierKey(identifier));
		const owner = this.ownerLedger.ownerOf(identifier);
		if (owner !== undefined && owner !== stateKey) {
			throw new Error(`Working Copy belongs to a different Para Code scope: ${identifier.resource.toString()}`);
		}
		if (owner === undefined) {
			this.ownerLedger.assign(identifier, stateKey);
			this.saveOwnerLedger();
		}
	}

	private routeBackup(identifier: IWorkingCopyIdentifier): WorkingCopyBackupRestoreDecision {
		if (!this.managedWorkspace) {
			return WorkingCopyBackupRestoreDecision.Restore;
		}
		if (this._isSwitching || this._activeStateKey === undefined) {
			return WorkingCopyBackupRestoreDecision.Defer;
		}

		const owner = this.ownerLedger.ownerOf(identifier);
		if (owner !== undefined) {
			return owner === this._activeStateKey ? WorkingCopyBackupRestoreDecision.Restore : WorkingCopyBackupRestoreDecision.Defer;
		}
		if (this.ownershipStorageWasCorrupt) {
			return WorkingCopyBackupRestoreDecision.Defer;
		}

		const resourceBelongsToActiveScope = this.activeUri !== undefined && isEqualOrParent(identifier.resource, this.activeUri);
		if (resourceBelongsToActiveScope || (this.legacyMigrationMode && !this.ownershipStorageWasCorrupt)) {
			this.ownerLedger.assign(identifier, this._activeStateKey);
			this.saveOwnerLedger();
			return WorkingCopyBackupRestoreDecision.Restore;
		}

		return WorkingCopyBackupRestoreDecision.Defer;
	}

	private saveOwnerLedger(): void {
		this.storageService.store(PARADIS_WORKING_COPY_OWNERS_STORAGE_KEY, this.ownerLedger.serialize(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private resolveInitialIdentity(): { readonly managed: boolean; readonly stateKey: string | undefined; readonly uri: URI | undefined } {
		const folders = this.contextService.getWorkspace().folders;
		const activeUri = folders.length === 1 ? folders[0].uri : undefined;
		const repositories = this.loadRepositories();
		const managed = repositories.length > 0 && this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE;
		if (!activeUri) {
			return { managed, stateKey: undefined, uri: undefined };
		}

		const activeEntry = this.loadActiveEntry();
		if (activeEntry && isEqual(URI.parse(activeEntry.uri), activeUri)) {
			return { managed, stateKey: activeEntry.stateKey, uri: activeUri };
		}

		return {
			managed,
			stateKey: repositories.find(repository => isEqual(URI.parse(repository.uri), activeUri))?.id,
			uri: activeUri
		};
	}

	private loadRepositories(): readonly ISerializedWorkspaceRepository[] {
		const raw = this.storageService.get(PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return [];
		}
		try {
			const repositories = JSON.parse(raw) as readonly Partial<ISerializedWorkspaceRepository>[];
			return Array.isArray(repositories)
				? repositories.filter((repository): repository is ISerializedWorkspaceRepository => typeof repository.id === 'string' && typeof repository.uri === 'string')
				: [];
		} catch (error) {
			this.logService.error('[ParadisEditorScope] Failed to load repositories for early scope identity', error);
			return [];
		}
	}

	private loadActiveEntry(): ISerializedActiveEntry | undefined {
		const raw = this.storageService.get(PARADIS_WORKSPACE_ACTIVE_ENTRY_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			const entry = JSON.parse(raw) as Partial<ISerializedActiveEntry>;
			return typeof entry.stateKey === 'string' && typeof entry.uri === 'string' ? entry as ISerializedActiveEntry : undefined;
		} catch (error) {
			this.logService.error('[ParadisEditorScope] Failed to load active entry for early scope identity', error);
			return undefined;
		}
	}
}
