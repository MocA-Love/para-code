/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAuxiliaryEditorPart, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ParadisAuxiliaryWindowScopeLedger, ParadisAuxiliaryWindowScopeLedgerLoadState } from '../common/paradisAuxiliaryWindowScope.js';
import { IParadisAuxiliaryWindowScopeService, ParadisBindingScope } from '../common/paradisWorkspaceSwitch.js';

interface ILiveAuxiliaryWindowScope {
	readonly part: IAuxiliaryEditorPart;
	readonly entryId?: string;
	readonly scope: ParadisBindingScope;
}

const PARADIS_AUXILIARY_WINDOW_SCOPES_STORAGE_KEY = 'paradis.workspaceSwitch.auxiliaryWindowScopes';

/**
 * Keeps auxiliary editor windows pinned to the Para Code space that created
 * them. Stable group ids bridge renderer reloads; window ids are runtime-only.
 */
export class ParadisAuxiliaryWindowScopeService extends Disposable implements IParadisAuxiliaryWindowScopeService {

	declare readonly _serviceBrand: undefined;

	private readonly ledger: ParadisAuxiliaryWindowScopeLedger;
	private readonly loadState: ParadisAuxiliaryWindowScopeLedgerLoadState;
	private readonly liveScopes = new Map<number, ILiveAuxiliaryWindowScope>();
	private readonly partListeners = this._register(new DisposableMap<number>());
	/** `null` means the creating auxiliary window itself has unresolved ownership. */
	private readonly pendingNewParts = new Map<number, string | null | undefined>();
	private _activeStateKey: string | undefined;
	private _managed = false;
	private _switching = false;
	private _initialized = false;
	private _shutdownStarted = false;

	readonly initializationBarrier: Promise<void>;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();

		const loaded = ParadisAuxiliaryWindowScopeLedger.load(
			this.storageService.get(PARADIS_AUXILIARY_WINDOW_SCOPES_STORAGE_KEY, StorageScope.WORKSPACE)
		);
		this.ledger = loaded.ledger;
		this.loadState = loaded.state;

		this._register(lifecycleService.onWillShutdown(() => this._shutdownStarted = true));
		this._register(this.editorGroupsService.onDidCreateAuxiliaryEditorPart(part => this.onDidCreatePart(part)));
		this._register(this.editorGroupsService.onDidAddGroup(group => this.onDidChangeGroups(group.windowId)));
		this._register(this.editorGroupsService.onDidRemoveGroup(group => this.onDidChangeGroups(group.windowId)));

		this.initializationBarrier = this.initialize();
	}

	setMainScope(stateKey: string | undefined, managed: boolean, switching: boolean): void {
		this._activeStateKey = stateKey;
		this._managed = managed;
		this._switching = switching;
		if (!this._initialized || switching) {
			return;
		}

		if (managed) {
			for (const live of [...this.liveScopes.values()]) {
				if (live.entryId || live.scope.kind === 'managed' || this.pendingNewParts.has(live.part.windowId)) {
					continue;
				}
				if (this.loadState === ParadisAuxiliaryWindowScopeLedgerLoadState.Missing && stateKey !== undefined) {
					const entryId = this.ledger.create(stateKey, live.part.groups.map(group => group.id));
					this.registerPart(live.part, { kind: 'managed', stateKey }, entryId);
					this.persist();
				} else {
					this.registerPart(live.part, { kind: 'pending' });
				}
			}
		} else {
			let changed = false;
			for (const live of [...this.liveScopes.values()]) {
				if (live.entryId) {
					this.ledger.delete(live.entryId);
					changed = true;
				}
				this.registerPart(live.part, { kind: 'unscoped' });
			}
			if (changed) {
				this.persist();
			}
		}

		for (const [windowId, sourceStateKey] of [...this.pendingNewParts]) {
			const part = this.editorGroupsService.parts.find(candidate => candidate.windowId === windowId);
			if (part && part !== this.editorGroupsService.mainPart) {
				this.registerNewPart(part as IAuxiliaryEditorPart, sourceStateKey);
			}
		}
	}

	resolveWindow(windowId: number): ParadisBindingScope {
		if (windowId === this.editorGroupsService.mainPart.windowId) {
			return this.mainScope;
		}
		return this.liveScopes.get(windowId)?.scope ?? { kind: 'pending' };
	}

	resolvePart(part: IEditorPart): ParadisBindingScope {
		return part === this.editorGroupsService.mainPart ? this.mainScope : this.resolveWindow(part.windowId);
	}

	resolveGroup(group: IEditorGroup): ParadisBindingScope {
		return this.resolveWindow(group.windowId);
	}

	getPinnedParts(stateKey?: string): readonly IAuxiliaryEditorPart[] {
		return [...this.liveScopes.values()]
			.filter(entry => entry.scope.kind === 'managed' && (stateKey === undefined || entry.scope.stateKey === stateKey))
			.map(entry => entry.part);
	}

	hasVisibleScope(stateKey: string): boolean {
		return this.getPinnedParts(stateKey).length > 0;
	}

	async retireScope(stateKey: string): Promise<boolean> {
		if (!await this.closeScopeWindowsForRetirement(stateKey)) {
			return false;
		}
		this.commitScopeRetirement(stateKey);
		return true;
	}

	async closeScopeWindowsForRetirement(stateKey: string): Promise<boolean> {
		const parts = [...this.getPinnedParts(stateKey)];
		for (const part of parts) {
			if (!part.close()) {
				return false;
			}
		}
		return true;
	}

	commitScopeRetirement(stateKey: string): void {
		this.ledger.retire(stateKey);
		// A native window can exceptionally refuse to close after the data-bearing
		// editor retirement has committed. Do not leave that live window assigning
		// new state to an unreachable retired key.
		for (const live of [...this.liveScopes.values()]) {
			if (live.scope.kind === 'managed' && live.scope.stateKey === stateKey) {
				this.registerPart(live.part, { kind: 'unscoped' });
			}
		}
		this.persist();
	}

	private get mainScope(): ParadisBindingScope {
		if (this._switching || (this._managed && this._activeStateKey === undefined)) {
			return { kind: 'pending' };
		}
		return this._activeStateKey !== undefined
			? { kind: 'managed', stateKey: this._activeStateKey }
			: { kind: 'unscoped' };
	}

	private async initialize(): Promise<void> {
		await this.editorGroupsService.whenReady;
		for (const part of this.editorGroupsService.parts) {
			if (part !== this.editorGroupsService.mainPart) {
				this.registerRestoredPart(part as IAuxiliaryEditorPart);
			}
		}
		this._initialized = true;
	}

	private onDidCreatePart(part: IAuxiliaryEditorPart): void {
		if (!this._initialized) {
			return;
		}
		const activeWindowId = getActiveWindow().vscodeWindowId;
		const sourceScope = this.resolveWindow(activeWindowId);
		const sourceStateKey = activeWindowId === part.windowId || activeWindowId === this.editorGroupsService.mainPart.windowId
			? undefined
			: sourceScope.kind === 'managed' ? sourceScope.stateKey : sourceScope.kind === 'pending' ? null : undefined;
		if (this._switching) {
			this.pendingNewParts.set(part.windowId, sourceStateKey);
			this.registerPart(part, { kind: 'pending' });
			return;
		}
		this.registerNewPart(part, sourceStateKey);
	}

	private registerRestoredPart(part: IAuxiliaryEditorPart): void {
		const matched = this.ledger.match(part.groups.map(group => group.id));
		if (matched) {
			this.registerPart(part, { kind: 'managed', stateKey: matched.stateKey }, matched.id);
			return;
		}

		if (this.loadState === ParadisAuxiliaryWindowScopeLedgerLoadState.Missing && this._activeStateKey !== undefined) {
			const entryId = this.ledger.create(this._activeStateKey, part.groups.map(group => group.id));
			this.registerPart(part, { kind: 'managed', stateKey: this._activeStateKey }, entryId);
			this.persist();
			return;
		}

		this.registerPart(part, this._managed ? { kind: 'pending' } : { kind: 'unscoped' });
	}

	private registerNewPart(part: IAuxiliaryEditorPart, sourceStateKey?: string | null): void {
		this.pendingNewParts.delete(part.windowId);
		if (sourceStateKey === null) {
			this.registerPart(part, { kind: 'pending' });
			return;
		}
		const stateKey = sourceStateKey ?? this._activeStateKey;
		if (stateKey === undefined) {
			this.registerPart(part, this._managed ? { kind: 'pending' } : { kind: 'unscoped' });
			return;
		}

		const entryId = this.ledger.create(stateKey, part.groups.map(group => group.id));
		this.registerPart(part, { kind: 'managed', stateKey }, entryId);
		this.persist();
	}

	private registerPart(part: IAuxiliaryEditorPart, scope: ParadisBindingScope, entryId?: string): void {
		this.partListeners.deleteAndDispose(part.windowId);
		this.liveScopes.set(part.windowId, { part, scope, entryId });
		const listeners = new DisposableStore();
		listeners.add(part.onWillClose(() => {
			this.pendingNewParts.delete(part.windowId);
			this.liveScopes.delete(part.windowId);
			this.partListeners.deleteAndDispose(part.windowId);
			if (!this._shutdownStarted && entryId) {
				this.ledger.delete(entryId);
				this.persist();
			}
		}));
		this.partListeners.set(part.windowId, listeners);
	}

	private onDidChangeGroups(windowId: number): void {
		const live = this.liveScopes.get(windowId);
		if (!live?.entryId) {
			return;
		}
		this.ledger.updateGroups(live.entryId, live.part.groups.map(group => group.id));
		this.persist();
	}

	private persist(): void {
		this.storageService.store(
			PARADIS_AUXILIARY_WINDOW_SCOPES_STORAGE_KEY,
			this.ledger.serialize(),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}
}
