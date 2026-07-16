/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { timeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { IWorkingCopy, IWorkingCopyIdentifier } from '../../../../workbench/services/workingCopy/common/workingCopy.js';
import { IWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/common/workingCopyBackup.js';
import { WorkingCopyBackupRestoreDecision, IWorkingCopyBackupRestoreRouter } from '../../../../workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.js';
import { IWorkingCopyEditorService } from '../../../../workbench/services/workingCopy/common/workingCopyEditorService.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { IParadisEditorScopeService, ParadisWorkingCopyOwnerLedger, ParadisWorkingCopyOwnerLedgerLoadState } from '../common/paradisEditorScope.js';
import { IParadisAuxiliaryWindowScopeService, PARADIS_WORKSPACE_ACTIVE_ENTRY_STORAGE_KEY, PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY } from '../common/paradisWorkspaceSwitch.js';

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
	readonly editorStates: readonly IParadisPreparedEditorState[];
	readonly workingCopyStates: readonly IParadisPreparedWorkingCopyState[];
	readonly handledWorkingCopyKeys: ReadonlySet<string>;
	readonly frozenPlacements: readonly IParadisLiveEditorPlacement[];
	readonly frozenWorkingCopiesByEditor: ReadonlyMap<EditorInput, readonly IWorkingCopy[]>;
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

/**
 * Owns both runtime live EditorInputs and persistent Working Copy backup
 * ownership. It deliberately does not depend on the workspace switch service,
 * allowing the restore router to start during BlockRestore without a cycle.
 */
export class ParadisEditorScopeService extends Disposable implements IParadisEditorScopeService {

	declare readonly _serviceBrand: undefined;

	private readonly liveWorkingSets = new Map<string, IParadisLiveWorkingSet>();
	private readonly preparedRetirements = new Map<string, IParadisPreparedRetirement>();
	private readonly pendingBackupDiscards = this._register(new DisposableMap<string, DisposableStore>());
	private readonly pendingBackupDiscardJournal = new Map<string, { readonly identifier: IWorkingCopyIdentifier; readonly stateKey: string }>();
	private readonly pendingOwnerReleases = this._register(new DisposableMap<string, DisposableStore>());
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
			for (const retirement of this.preparedRetirements.values()) {
				retirement.frozenRetentions.dispose();
			}
			this.preparedRetirements.clear();
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

		const { modifiedEditorOwners, placements } = this.collectVisibleLiveEditorState(true, stateKey, true);
		const excludedEditors = new Set(placements.map(placement => placement.editor));

		for (const editor of excludedEditors) {
			for (const workingCopy of modifiedEditorOwners.get(editor) ?? []) {
				this.claimWorkingCopy(workingCopy, stateKey);
			}
		}

		const retentions = new DisposableStore();
		try {
			for (const editor of excludedEditors) {
				retentions.add(this.editorGroupsService.retainEditor(editor));
			}

			saveSerializedState([...excludedEditors]);
			if (placements.length === 0) {
				retentions.dispose();
				return;
			}

			this.liveWorkingSets.set(stateKey, {
				placements,
				workingCopiesByEditor: this.selectWorkingCopyOwners(modifiedEditorOwners, excludedEditors),
				retentions
			});
			for (const placement of placements) {
				this.editorGroupsService.getGroup(placement.groupId)?.detachEditor?.(placement.editor);
			}
		} catch (error) {
			if (!this.liveWorkingSets.has(stateKey)) {
				retentions.dispose();
			}
			throw error;
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

		const retentions = new DisposableStore();
		try {
			for (const editor of editors) {
				retentions.add(this.editorGroupsService.retainEditor(editor));
			}

			const existing = this.liveWorkingSets.get(stateKey);
			if (existing) {
				existing.retentions.add(retentions);
				this.liveWorkingSets.set(stateKey, {
					placements: [...existing.placements, ...placements],
					workingCopiesByEditor: this.mergeWorkingCopyOwners(
						existing.workingCopiesByEditor,
						this.selectWorkingCopyOwners(modifiedEditorOwners, editors)
					),
					retentions: existing.retentions
				});
			} else {
				this.liveWorkingSets.set(stateKey, {
					placements,
					workingCopiesByEditor: this.selectWorkingCopyOwners(modifiedEditorOwners, editors),
					retentions
				});
			}

			for (const placement of placements) {
				this.editorGroupsService.getGroup(placement.groupId)?.detachEditor?.(placement.editor);
			}
		} catch (error) {
			if (!this.liveWorkingSets.has(stateKey)) {
				retentions.dispose();
			}
			throw error;
		}
	}

	async restoreScope(stateKey: string): Promise<void> {
		const liveWorkingSet = this.liveWorkingSets.get(stateKey);
		if (!liveWorkingSet) {
			return;
		}

		await this.restoreEditorPlacements(liveWorkingSet.placements);
		this.liveWorkingSets.delete(stateKey);
		liveWorkingSet.retentions.dispose();
	}

	private async restoreEditorPlacements(placementsToRestore: readonly IParadisLiveEditorPlacement[]): Promise<void> {
		const opened: { readonly group: IEditorGroup; readonly editor: EditorInput }[] = [];
		const restoredPlacements: { readonly group: IEditorGroup; readonly placement: IParadisLiveEditorPlacement }[] = [];
		try {
			const placements = [...placementsToRestore].sort((left, right) => Number(left.active) - Number(right.active));
			for (const placement of placements) {
				const group = this.resolveRestoreGroup(placement);
				const wasOpen = group.contains(placement.editor, { strictEquals: true });
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
				if (!wasOpen) {
					opened.push({ group, editor: placement.editor });
				}
				restoredPlacements.push({ group, placement });
			}

			for (const group of new Set(restoredPlacements.map(entry => entry.group))) {
				const groupPlacements = restoredPlacements.filter(entry => entry.group === group).map(entry => entry.placement);
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
				this.liveWorkingSets.set(stateKey, previousLiveState);
			}
			this.saveOwnerLedger();
		}

		await this.commitSwitch(stateKey, uri);
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
					message: localize('paradis.editorScope.backupRetirementMessage', "This space contains unsaved backup data."),
					detail: localize('paradis.editorScope.backupRetirementDetail', "Removing the space will permanently discard its unrestored editor backups."),
					primaryButton: localize('paradis.editorScope.backupRetirementConfirm', "Discard Backups and Remove")
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
			return;
		}
		this.preparedRetirements.delete(stateKey);
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

	async retireScopes(stateKeys: readonly string[]): Promise<boolean> {
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

		retentions.add(this.editorGroupsService.retainEditor(editor));
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
		const existing = this.liveWorkingSets.get(stateKey);
		if (existing) {
			existing.retentions.add(retentions);
			this.liveWorkingSets.set(stateKey, {
				placements: [...existing.placements, ...deferred],
				workingCopiesByEditor: this.mergeWorkingCopyOwners(existing.workingCopiesByEditor, this.selectWorkingCopyOwners(workingCopiesByEditor, deferredEditors)),
				retentions: existing.retentions
			});
		} else {
			this.liveWorkingSets.set(stateKey, {
				placements: deferred,
				workingCopiesByEditor: this.selectWorkingCopyOwners(workingCopiesByEditor, deferredEditors),
				retentions
			});
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
				let firstAttempt = true;
				while (!cancellation.token.isCancellationRequested) {
					await timeout(firstAttempt ? 0 : 50, cancellation.token);
					firstAttempt = false;
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

	private collectVisibleLiveEditorState(requireDetach: boolean, stateKey?: string, mainPartOnly = false, exactPart?: IEditorPart): { readonly modifiedEditorOwners: Map<EditorInput, IWorkingCopy[]>; readonly placements: readonly IParadisLiveEditorPlacement[] } {
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
					if (!paradisEditorRequiresScopedLiveState(editor, modifiedEditors)) {
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
		if (scope.kind === 'managed' && this.ownerLedger.ownerOf(workingCopy) === undefined) {
			this.claimWorkingCopy(workingCopy, scope.stateKey);
		}
	}

	private claimWorkingCopy(identifier: IWorkingCopyIdentifier, stateKey: string): void {
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
