/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
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
	readonly retentions: DisposableStore;
}

interface IParadisPreparedEditorRevert {
	readonly editor: EditorInput;
	readonly groupId: GroupIdentifier;
}

interface IParadisPreparedRetirement {
	readonly backups: readonly IWorkingCopyIdentifier[];
	readonly editorsToRevert: readonly IParadisPreparedEditorRevert[];
}

interface ISerializedWorkspaceRepository {
	readonly id: string;
	readonly uri: string;
}

interface ISerializedActiveEntry {
	readonly stateKey: string;
	readonly uri: string;
}

const PARADIS_WORKING_COPY_OWNERS_STORAGE_KEY = 'paradis.workspaceSwitch.workingCopyOwners';

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

		const initialIdentity = this.resolveInitialIdentity();
		this.managedWorkspace = initialIdentity.managed;
		this._activeStateKey = initialIdentity.stateKey;
		this.activeUri = initialIdentity.uri;

		this._register(this.backupRestoreRouter.registerProvider({ route: identifier => this.routeBackup(identifier) }));
		this._register(this.workingCopyService.onDidRegister(workingCopy => this.observeModifiedWorkingCopy(workingCopy)));
		this._register(this.workingCopyService.onDidChangeDirty(workingCopy => this.observeModifiedWorkingCopy(workingCopy)));
		this._register(this.workingCopyService.onDidChangeContent(workingCopy => this.observeModifiedWorkingCopy(workingCopy)));

		for (const workingCopy of this.workingCopyService.modifiedWorkingCopies) {
			this.observeModifiedWorkingCopy(workingCopy);
		}
		void this.auxiliaryWindowScopeService.initializationBarrier.then(() => {
			for (const workingCopy of this.workingCopyService.modifiedWorkingCopies) {
				this.observeModifiedWorkingCopy(workingCopy);
			}
		});
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

			this.liveWorkingSets.set(stateKey, { placements, retentions });
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
					retentions: existing.retentions
				});
			} else {
				this.liveWorkingSets.set(stateKey, { placements, retentions });
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

		const opened: { readonly group: IEditorGroup; readonly editor: EditorInput }[] = [];
		const restoredPlacements: { readonly group: IEditorGroup; readonly placement: IParadisLiveEditorPlacement }[] = [];
		try {
			const placements = [...liveWorkingSet.placements].sort((left, right) => Number(left.active) - Number(right.active));
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

		this.liveWorkingSets.delete(stateKey);
		liveWorkingSet.retentions.dispose();
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
		const visiblePlacements = this.collectVisibleLiveEditorState(false, stateKey).placements;
		const retirementPlacements = liveWorkingSet
			? [...liveWorkingSet.placements, ...visiblePlacements]
			: visiblePlacements;
		const editorsToRevert: IParadisPreparedEditorRevert[] = [];
		if (retirementPlacements.length > 0) {
			const editors = [...new Set(retirementPlacements.map(placement => placement.editor))];
			for (const editor of editors) {
				const result = await this.prepareLiveEditorRetirement(editor, retirementPlacements);
				if (!result.confirmed) {
					return false;
				}
				if (result.editorToRevert) {
					editorsToRevert.push(result.editorToRevert);
				}
			}
		}

		const ownedKeys = new Set(this.ownerLedger.entries.filter(entry => entry.stateKey === stateKey).map(entry => this.identifierKey(entry.identifier)));
		const backups = (await this.workingCopyBackupService.getBackups()).filter(identifier => ownedKeys.has(this.identifierKey(identifier)));
		if (retirementPlacements.length === 0 && backups.length > 0) {
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('paradis.editorScope.backupRetirementMessage', "This space contains unsaved backup data."),
				detail: localize('paradis.editorScope.backupRetirementDetail', "Removing the space will permanently discard its unrestored editor backups."),
				primaryButton: localize('paradis.editorScope.backupRetirementConfirm', "Discard Backups and Remove")
			});
			if (!confirmed) {
				return false;
			}
		}

		this.preparedRetirements.set(stateKey, { backups, editorsToRevert });
		return true;
	}

	cancelScopeRetirement(stateKey: string): void {
		this.preparedRetirements.delete(stateKey);
	}

	async retireScope(stateKey: string): Promise<boolean> {
		if (!this.preparedRetirements.has(stateKey) && !await this.prepareScopeRetirement(stateKey)) {
			return false;
		}

		const preparedRetirement = this.preparedRetirements.get(stateKey);
		if (!preparedRetirement) {
			return false;
		}
		for (const { editor, groupId } of preparedRetirement.editorsToRevert) {
			try {
				await editor.revert(groupId);
			} catch (error) {
				this.logService.error('[ParadisEditorScope] Editor revert failed during scope retirement', error);
				try {
					await editor.revert(groupId, { soft: true });
				} catch (softRevertError) {
					this.logService.error('[ParadisEditorScope] Editor soft revert failed during scope retirement', softRevertError);
					return false;
				}
			}
			if (editor.isModified()) {
				return false;
			}
		}
		const ownedKeys = new Set(this.ownerLedger.entries.filter(entry => entry.stateKey === stateKey).map(entry => this.identifierKey(entry.identifier)));
		const currentBackups = (await this.workingCopyBackupService.getBackups()).filter(identifier => ownedKeys.has(this.identifierKey(identifier)));
		const backupsToDiscard = new Map([...preparedRetirement.backups, ...currentBackups].map(identifier => [this.identifierKey(identifier), identifier]));
		for (const identifier of backupsToDiscard.values()) {
			await this.workingCopyBackupService.discardBackup(identifier);
		}
		this.preparedRetirements.delete(stateKey);

		const liveWorkingSet = this.liveWorkingSets.get(stateKey);
		if (liveWorkingSet) {
			this.liveWorkingSets.delete(stateKey);
			liveWorkingSet.retentions.dispose();
		}
		this.ownerLedger.retire(stateKey);
		this.saveOwnerLedger();
		return true;
	}

	private async prepareLiveEditorRetirement(editor: EditorInput, placements: readonly IParadisLiveEditorPlacement[]): Promise<{ readonly confirmed: boolean; readonly editorToRevert?: IParadisPreparedEditorRevert }> {
		let shouldConfirm = editor.isModified();
		if (editor.closeHandler) {
			try {
				shouldConfirm = editor.closeHandler.showConfirm();
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
		if (editor.closeHandler) {
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
				return { confirmed: saved !== undefined && !editor.isModified() };
			}
			case ConfirmResult.DONT_SAVE:
				return { confirmed: true, editorToRevert: { editor, groupId: placement.groupId } };
			case ConfirmResult.CANCEL:
				return { confirmed: false };
		}
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
