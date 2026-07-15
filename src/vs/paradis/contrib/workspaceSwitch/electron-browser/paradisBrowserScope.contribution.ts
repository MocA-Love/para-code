/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter } from '../../../../base/common/event.js';
import { combinedDisposable, Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ParadisBrowserScopeState, PARADIS_BROWSER_SCOPE_STORAGE_KEY } from '../common/paradisBrowserScopeState.js';
import { IParadisBrowserScopeService, IParadisWorkspaceSwitchService, ParadisBindingScope } from '../common/paradisWorkspaceSwitch.js';

/**
 * BrowserViewのworkspace scope authority。
 *
 * Unit 1以降、Renderer reload中もMainのWebContentsViewは保持され、新Rendererが同じviewIdへ
 * re-attachする。このserviceはviewId→stateKeyをWORKSPACE storageへ保存し、inactive scopeの
 * viewを現在scopeへ誤tagしない。台帳はParadisBrowserScopeState内のMap 1個だけを正とする。
 */
export class ParadisBrowserScopeService extends Disposable implements IParadisBrowserScopeService {
	declare readonly _serviceBrand: undefined;

	private readonly _state: ParadisBrowserScopeState;
	private readonly _inputListeners = this._register(new DisposableMap<string>());
	private readonly _pendingCreatedDuringSwitch = new Set<string>();
	private readonly _initialPendingViewIds = new Set<string>();
	private readonly _filterChanged = this._register(new Emitter<void>());
	private _shutdownStarted = false;
	private _initialSnapshotSucceeded = false;
	private _probingPendingContext = false;

	readonly initializationBarrier: Promise<void>;
	readonly onDidChangeStableScope;
	get revision(): number { return this._state.revision; }

	constructor(
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();

		// Synchronous load is intentionally the first observable operation. No view event may tag an
		// inactive Main-retained view before its persisted scope has been restored.
		this._state = this._register(new ParadisBrowserScopeState(
			this.storageService.get(PARADIS_BROWSER_SCOPE_STORAGE_KEY, StorageScope.WORKSPACE),
		));
		this.onDidChangeStableScope = this._state.onDidChangeStableScope;

		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(() => this._hookKnownViews()));
		this._hookKnownViews();

		this._register(this.lifecycleService.onWillShutdown(() => this._shutdownStarted = true));
		this._register(this.workspaceSwitchService.onWillSwitchScope(() => {
			this._hideAllBrowserViews();
			// isSwitching becomes true before this event. Invalidate immediately so callers cannot
			// observe an outgoing stable view through a stale contextual collection.
			this._filterChanged.fire();
		}));
		this._register(this.workspaceSwitchService.onDidSwitchScope(() => this._onScopeSwitchCompleted()));
		this._register(this.workspaceSwitchService.onDidRetireScope(stateKey => this._retireScope(stateKey)));
		this._register(this.workspaceSwitchService.onDidChangeRepositories(() => {
			this._reevaluatePendingContextualViews();
			this._reevaluateUnscopedViews();
		}));

		this.initializationBarrier = this._initialize();
	}

	resolveScope(viewId: string): ParadisBindingScope {
		if (this.workspaceSwitchService.isSwitching) {
			return { kind: 'pending' };
		}
		return this._state.resolveScope(viewId);
	}

	private async _initialize(): Promise<void> {
		// IBrowserViewWorkbenchService guarantees this promise is non-rejecting. Keep the defensive
		// catch so a third-party/test implementation cannot strand binding UI forever.
		try {
			this._initialSnapshotSucceeded = await this.browserViewWorkbenchService.whenInitialized;
		} catch {
			this._initialSnapshotSucceeded = false;
		}

		this._hookKnownViews();
		const contextualIds = new Set(this.browserViewWorkbenchService.getContextualBrowserViews().keys());
		let changed = false;
		for (const [viewId, input] of this.browserViewWorkbenchService.getKnownBrowserViews()) {
			if (this._state.isRetiredBeforeInitialization(viewId)) {
				input.dispose(true);
				if (!this.browserViewWorkbenchService.getKnownBrowserViews().has(viewId)) {
					this._state.convergeRetiredView(viewId);
				}
				continue;
			}
			if (this._state.resolveScope(viewId).kind === 'managed') {
				continue;
			}
			if (!this._initialSnapshotSucceeded) {
				this._state.markPending(viewId);
				this._initialPendingViewIds.add(viewId);
				continue;
			}
			// Corrupt storage cannot prove which inactive scope owns an initial Main-retained view.
			if (this._state.storageStatus === 'corrupt' || this.workspaceSwitchService.isSwitching || !contextualIds.has(viewId)) {
				this._state.markPending(viewId);
				this._initialPendingViewIds.add(viewId);
				continue;
			}
			const tagged = this._tagForCurrentWorkspace(viewId, 'initialTag');
			if (!tagged) {
				this._initialPendingViewIds.add(viewId);
			}
			changed = tagged || changed;
		}
		this._state.completeInitialization(
			this._initialSnapshotSucceeded,
			new Set(this.browserViewWorkbenchService.getKnownBrowserViews().keys()),
		);
		if (changed) {
			this._persist();
		}

		// Register our filter only after contextual membership was sampled for initial unknown views;
		// otherwise our own pending filter would make every one of them look inactive.
		this._register(this.browserViewWorkbenchService.registerContextualFilter({
			include: input => this._isInActiveScope(input),
			onDidChange: this._filterChanged.event,
		}));
	}

	private _hookKnownViews(): void {
		for (const [viewId, input] of this.browserViewWorkbenchService.getKnownBrowserViews()) {
			if (this._state.isRetiredBeforeInitialization(viewId)) {
				input.dispose(true);
				if (!this.browserViewWorkbenchService.getKnownBrowserViews().has(viewId)) {
					this._state.convergeRetiredView(viewId);
				}
				continue;
			}
			this._hookInput(viewId, input);
			if (!this._state.initialized) {
				this._state.markPending(viewId);
				continue;
			}
			if (this._state.resolveScope(viewId).kind !== 'pending') {
				continue;
			}
			if (this._initialPendingViewIds.has(viewId)) {
				continue;
			}
			if (this.workspaceSwitchService.isSwitching) {
				this._pendingCreatedDuringSwitch.add(viewId);
				continue;
			}
			if (this._tagForCurrentWorkspace(viewId, 'initialTag')) {
				this._persist();
				this._filterChanged.fire();
			}
		}
	}

	private _hookInput(viewId: string, input: BrowserEditorInput): void {
		if (this._inputListeners.has(viewId)) {
			return;
		}
		this._inputListeners.set(viewId, combinedDisposable(
			input.onBeforeDispose(event => {
				if (this.workspaceSwitchService.isSwitching) {
					event.veto();
				}
			}),
			input.onWillDispose(() => {
				this._inputListeners.deleteAndDispose(viewId);
				this._pendingCreatedDuringSwitch.delete(viewId);
				// A Renderer/window shutdown is not a user close. Main retains the BrowserView and the
				// next Renderer must recover the persisted mapping.
				if (this._shutdownStarted || this.lifecycleService.willShutdown || this.workspaceSwitchService.isSwitching) {
					return;
				}
				this._initialPendingViewIds.delete(viewId);
				if (this._state.deleteForUserClose(viewId)) {
					this._persist();
				}
				this._filterChanged.fire();
			}),
		));
	}

	private _onScopeSwitchCompleted(): void {
		this._reevaluatePendingContextualViews();
		this._reevaluateUnscopedViews();
		this._filterChanged.fire();
	}

	private _reevaluatePendingContextualViews(): void {
		if (!this._state.initialized || this.workspaceSwitchService.isSwitching) {
			return;
		}
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		let changed = false;
		for (const viewId of this._getContextualViewIdsIncludingPending()) {
			if (this._state.resolveScope(viewId).kind !== 'pending') {
				continue;
			}
			if (this._initialPendingViewIds.has(viewId)
				&& (!this._initialSnapshotSucceeded || this._state.storageStatus === 'corrupt')) {
				continue;
			}
			if (activeStateKey === undefined && this._isManagedWorkspace()) {
				continue;
			}
			this._tagForCurrentWorkspace(viewId, 'initialTag');
			this._pendingCreatedDuringSwitch.delete(viewId);
			this._initialPendingViewIds.delete(viewId);
			changed = true;
		}
		if (changed) {
			this._persist();
			this._filterChanged.fire();
		}
	}

	private _tagForCurrentWorkspace(viewId: string, reason: 'initialTag' | 'reassign'): boolean {
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		if (activeStateKey !== undefined) {
			this._state.tagManaged(viewId, activeStateKey, reason);
			return true;
		}
		if (this._isManagedWorkspace()) {
			this._state.markPending(viewId);
			return false;
		}
		this._state.tagUnscoped(viewId, reason);
		return true;
	}

	private _isManagedWorkspace(): boolean {
		return this.workspaceSwitchService.isManagedWorkspaceWindow;
	}

	private _getContextualViewIdsIncludingPending(): Set<string> {
		this._probingPendingContext = true;
		try {
			return new Set(this.browserViewWorkbenchService.getContextualBrowserViews().keys());
		} finally {
			this._probingPendingContext = false;
		}
	}

	private _reevaluateUnscopedViews(): void {
		if (!this._state.initialized || this.workspaceSwitchService.isSwitching) {
			return;
		}
		const activeStateKey = this.workspaceSwitchService.activeStateKey;
		if (activeStateKey === undefined) {
			return;
		}
		const contextualIds = new Set(this.browserViewWorkbenchService.getContextualBrowserViews().keys());
		let changed = false;
		for (const viewId of contextualIds) {
			if (this._state.resolveScope(viewId).kind === 'unscoped') {
				this._state.tagManaged(viewId, activeStateKey, 'reassign');
				changed = true;
			}
		}
		if (changed) {
			this._persist();
			this._filterChanged.fire();
		}
	}

	private _retireScope(stateKey: string): void {
		const retiredViewIds = this._state.retireScope(stateKey);
		if (retiredViewIds.length === 0) {
			return;
		}
		this._persist();
		for (const viewId of retiredViewIds) {
			this._initialPendingViewIds.delete(viewId);
			this.browserViewWorkbenchService.getKnownBrowserViews().get(viewId)?.dispose(true);
		}
		this._filterChanged.fire();
	}

	private _isInActiveScope(input: BrowserEditorInput): boolean {
		const scope = this.resolveScope(input.serialize().id);
		if (scope.kind === 'pending') {
			return this._probingPendingContext;
		}
		return scope.kind === 'unscoped'
			|| (scope.kind === 'managed' && scope.stateKey === this.workspaceSwitchService.activeStateKey);
	}

	private _hideAllBrowserViews(): void {
		for (const [, input] of this.browserViewWorkbenchService.getKnownBrowserViews()) {
			if (input.model?.visible) {
				void input.model.setVisible(false);
			}
		}
	}

	private _persist(): void {
		this.storageService.store(
			PARADIS_BROWSER_SCOPE_STORAGE_KEY,
			this._state.serialize(),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}
}

registerSingleton(IParadisBrowserScopeService, ParadisBrowserScopeService, InstantiationType.Delayed);

/** AfterRestored starter only. All state lives in the singleton service above. */
class ParadisBrowserScopeStarter implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisBrowserWorkspaceScope';

	constructor(@IParadisBrowserScopeService _scopeService: IParadisBrowserScopeService) { }
}

registerWorkbenchContribution2(ParadisBrowserScopeStarter.ID, ParadisBrowserScopeStarter, WorkbenchPhase.AfterRestored);
