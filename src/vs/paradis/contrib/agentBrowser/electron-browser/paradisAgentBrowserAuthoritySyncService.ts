/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisCollectLivePaneInstances } from '../browser/paradisLivePaneInstances.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisBindingAuthorityManifest, ParadisBindingAuthorityScope } from '../common/paradisBindingAuthority.js';
import { IParadisBrowserScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

export const IParadisAgentBrowserAuthoritySyncService = createDecorator<IParadisAgentBrowserAuthoritySyncService>('paradisAgentBrowserAuthoritySyncService');

export interface IParadisAgentBrowserAuthoritySyncService {
	readonly _serviceBrand: undefined;
	/** Last revision acknowledged exactly by the current shared-process Renderer connection. */
	readonly acceptedRevision: number;
	/** True after workbench shutdown starts; no further manifest may be materialized or sent. */
	readonly isFrozen: boolean;
	/** Enqueues a fresh snapshot and resolves only with its exact accepted revision. */
	syncNow(): Promise<number>;
}

interface IRevisionWaiter {
	readonly requestSerial: number;
	readonly resolve: (revision: number) => void;
	readonly reject: (error: Error) => void;
}

const RETRY_DELAY_MS = 3_000;
const MAX_EXPLICIT_SYNC_WAITERS = 256;

function copyScope(scope: ParadisBindingAuthorityScope): ParadisBindingAuthorityScope {
	return scope.kind === 'managed'
		? Object.freeze({ kind: 'managed', stateKey: scope.stateKey })
		: Object.freeze({ kind: scope.kind });
}

/**
 * The sole Renderer writer for binding authority manifests. Requests are coalesced while one IPC
 * is in flight, but every caller is completed only by the revision that includes its request.
 */
export class ParadisAgentBrowserAuthoritySyncService extends Disposable implements IParadisAgentBrowserAuthoritySyncService {
	declare readonly _serviceBrand: undefined;

	private _nextRevision = 0;
	private _acceptedRevision = 0;
	private _requestSerial = 0;
	private _completedRequestSerial = 0;
	private _draining = false;
	private _frozen = false;
	private _terminalInitialized = false;
	private _browserViewsInitialized = false;
	private _browserScopeInitialized = false;
	private readonly _waiters: IRevisionWaiter[] = [];
	private readonly _retryScheduler = this._register(new RunOnceScheduler(() => this._requestBackgroundSync(), RETRY_DELAY_MS));

	get acceptedRevision(): number { return this._acceptedRevision; }
	get isFrozen(): boolean { return this._frozen; }

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();

		const request = () => this._requestBackgroundSync();
		this._register(this.paneTokenService.onDidChange(request));
		this._register(this.terminalService.onDidChangeInstances(request));
		this._register(this.terminalService.onDidChangeConnectionState(request));
		this._register(this.terminalService.onAnyInstanceProcessIdReady(request));
		this._register(this.terminalGroupService.onDidChangeGroups(request));
		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(request));
		this._register(this.terminalScopeService.onDidChangeStableScope(request));
		this._register(this.browserScopeService.onDidChangeStableScope(request));
		this._register(this.workspaceSwitchService.onWillSwitchScope(request));
		this._register(this.workspaceSwitchService.onDidSwitchScope(request));
		this._register(this.lifecycleService.onWillShutdown(() => this._freeze()));

		void this.terminalService.whenConnected.then(
			() => {
				if (!this._frozen) {
					this._terminalInitialized = true;
					request();
				}
			},
			() => request(),
		);
		void this.browserViewWorkbenchService.whenInitialized.then(
			succeeded => {
				if (!this._frozen) {
					this._browserViewsInitialized = succeeded;
					request();
				}
			},
			() => request(),
		);
		void this.browserScopeService.initializationBarrier.then(
			() => {
				if (!this._frozen) {
					this._browserScopeInitialized = true;
					request();
				}
			},
			() => request(),
		);

		if (this.lifecycleService.willShutdown) {
			this._freeze();
		} else {
			request();
		}
	}

	syncNow(): Promise<number> {
		if (this._frozen) {
			return Promise.reject(new Error('Para Browser authority sync is unavailable while the window is shutting down.'));
		}
		if (this._waiters.length >= MAX_EXPLICIT_SYNC_WAITERS) {
			return Promise.reject(new Error('Para Browser authority sync waiter capacity reached.'));
		}
		if (this._requestSerial >= Number.MAX_SAFE_INTEGER) {
			return Promise.reject(new Error('Para Browser authority sync request capacity reached.'));
		}
		const requestSerial = ++this._requestSerial;
		const result = new Promise<number>((resolve, reject) => {
			this._waiters.push({ requestSerial, resolve, reject });
		});
		this._startDrain();
		return result;
	}

	private _requestBackgroundSync(): void {
		if (this._frozen || this._requestSerial >= Number.MAX_SAFE_INTEGER) {
			return;
		}
		// Background changes need one trailing snapshot, not one retained Promise per event. The
		// request serial coalesces event storms while the current IPC remains single-flight.
		this._requestSerial++;
		this._startDrain();
	}

	private _startDrain(): void {
		if (this._draining || this._frozen) {
			return;
		}
		this._draining = true;
		void this._drain().finally(() => {
			this._draining = false;
			if (!this._frozen && this._completedRequestSerial < this._requestSerial) {
				this._startDrain();
			}
		});
	}

	private async _drain(): Promise<void> {
		while (!this._frozen && this._completedRequestSerial < this._requestSerial) {
			const targetRequestSerial = this._requestSerial;
			let revision = 0;
			try {
				revision = this._nextAuthorityRevision();
				const manifest = this._createManifest(revision);
				const acknowledgement = await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
					.call<unknown>('syncBindingAuthority', [manifest]);
				if (this._frozen) {
					return;
				}
				if (typeof acknowledgement !== 'object' || acknowledgement === null
					|| Reflect.get(acknowledgement, 'accepted') !== true
					|| Reflect.get(acknowledgement, 'revision') !== revision) {
					throw new Error('Para Browser authority acknowledgement was rejected.');
				}
				this._acceptedRevision = revision;
				this._completedRequestSerial = targetRequestSerial;
				this._retryScheduler.cancel();
				this._resolveWaiters(targetRequestSerial, revision);
			} catch (error) {
				if (this._frozen) {
					return;
				}
				this._completedRequestSerial = targetRequestSerial;
				this._rejectWaiters(targetRequestSerial, error instanceof Error ? error : new Error('Para Browser authority sync failed.'));
				if (!this._retryScheduler.isScheduled()) {
					this._retryScheduler.schedule();
				}
			}
		}
	}

	private _nextAuthorityRevision(): number {
		if (this._nextRevision >= Number.MAX_SAFE_INTEGER) {
			throw new Error('Para Browser authority revision capacity reached.');
		}
		return ++this._nextRevision;
	}

	private _createManifest(revision: number): IParadisBindingAuthorityManifest {
		const livePanes = paradisCollectLivePaneInstances(this.terminalService, this.terminalGroupService, this.paneTokenService);
		const livePaneByToken = new Map(livePanes.map(entry => [entry.token, entry.instance]));
		const panes = this.paneTokenService.listPaneTokens()
			.map(({ instanceId, token }) => {
				const shellPid = livePaneByToken.get(token)?.processId;
				return Object.freeze({
					token,
					...(typeof shellPid === 'number' && Number.isSafeInteger(shellPid) && shellPid > 0 ? { shellPid } : {}),
					scope: copyScope(this.terminalScopeService.resolveScope(instanceId)),
				});
			})
			.sort((left, right) => left.token.localeCompare(right.token));
		const browserViews = [...this.browserViewWorkbenchService.getKnownBrowserViews().keys()]
			.map(viewId => Object.freeze({ viewId, scope: copyScope(this.browserScopeService.resolveScope(viewId)) }))
			.sort((left, right) => left.viewId.localeCompare(right.viewId));
		return Object.freeze({
			revision,
			complete: this._terminalInitialized && this._browserViewsInitialized && this._browserScopeInitialized,
			panes: Object.freeze(panes),
			browserViews: Object.freeze(browserViews),
		});
	}

	private _resolveWaiters(targetRequestSerial: number, revision: number): void {
		for (let index = this._waiters.length - 1; index >= 0; index--) {
			const waiter = this._waiters[index];
			if (waiter.requestSerial <= targetRequestSerial) {
				this._waiters.splice(index, 1);
				waiter.resolve(revision);
			}
		}
	}

	private _rejectWaiters(targetRequestSerial: number, error: Error): void {
		for (let index = this._waiters.length - 1; index >= 0; index--) {
			const waiter = this._waiters[index];
			if (waiter.requestSerial <= targetRequestSerial) {
				this._waiters.splice(index, 1);
				waiter.reject(error);
			}
		}
	}

	private _freeze(): void {
		if (this._frozen) {
			return;
		}
		this._frozen = true;
		this._retryScheduler.cancel();
		this._completedRequestSerial = this._requestSerial;
		const error = new Error('Para Browser authority sync is unavailable while the window is shutting down.');
		for (const waiter of this._waiters.splice(0)) {
			waiter.reject(error);
		}
	}

	override dispose(): void {
		this._freeze();
		super.dispose();
	}
}

registerSingleton(IParadisAgentBrowserAuthoritySyncService, ParadisAgentBrowserAuthoritySyncService, InstantiationType.Delayed);
