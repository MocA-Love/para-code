/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisAgentStatusSnapshot, PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';

const STATUS_POLL_INTERVAL_MS = 2_000;

export interface IParadisAgentStatusSnapshotOutcome {
	readonly sequence: number;
	readonly snapshot?: IParadisAgentStatusSnapshot;
	readonly error?: unknown;
}

export const IParadisAgentStatusSnapshotService = createDecorator<IParadisAgentStatusSnapshotService>('paradisAgentStatusSnapshotService');

export interface IParadisAgentStatusSnapshotService {
	readonly _serviceBrand: undefined;
	subscribe(listener: (outcome: IParadisAgentStatusSnapshotOutcome) => void): IDisposable;
	requestRefresh(): void;
}

/** @internal Test seam for deterministic time; production always uses RunOnceScheduler. */
export interface IParadisAgentStatusSnapshotScheduler extends IDisposable {
	schedule(delay: number): void;
	cancel(): void;
}

/** @internal Test seam for deterministic scheduler and transport behavior. */
export interface IParadisAgentStatusSnapshotServiceTestSeam {
	readonly schedulerFactory?: (runner: () => void) => IParadisAgentStatusSnapshotScheduler;
	readonly transport?: () => Promise<IParadisAgentStatusSnapshot>;
}

const testSeamKey = Symbol('paradisAgentStatusSnapshotServiceTestSeam');

interface IParadisAgentStatusSnapshotTestSharedProcessService extends ISharedProcessService {
	readonly [testSeamKey]?: IParadisAgentStatusSnapshotServiceTestSeam;
}

/**
 * One renderer-local producer for Agent status. It intentionally keeps polling while the window is
 * hidden because notification transitions and stale-status cleanup depend on the same snapshots.
 */
export class ParadisAgentStatusSnapshotService extends Disposable implements IParadisAgentStatusSnapshotService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidOutcome = this._register(new Emitter<IParadisAgentStatusSnapshotOutcome>());
	private readonly _scheduler: IParadisAgentStatusSnapshotScheduler;
	private readonly _transport: () => Promise<IParadisAgentStatusSnapshot>;
	private _latest: IParadisAgentStatusSnapshotOutcome | undefined;
	private _sequence = 0;
	private _generation = 0;
	private _inFlight = false;
	private _pendingImmediate = false;
	private _disposed = false;

	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		super();
		const testSeam = (sharedProcessService as IParadisAgentStatusSnapshotTestSharedProcessService)[testSeamKey];
		this._transport = testSeam?.transport ?? (() => sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
			.call<IParadisAgentStatusSnapshot>('listAgentStatusSnapshot'));
		this._scheduler = this._register((testSeam?.schedulerFactory ?? (runner => new RunOnceScheduler(runner, 0)))(() => {
			void this._poll();
		}));
		this._scheduler.schedule(0);
	}

	subscribe(listener: (outcome: IParadisAgentStatusSnapshotOutcome) => void): IDisposable {
		if (this._disposed) {
			return Disposable.None;
		}
		let lastSequence = 0;
		const deliver = (outcome: IParadisAgentStatusSnapshotOutcome) => {
			if (outcome.sequence <= lastSequence) {
				return;
			}
			lastSequence = outcome.sequence;
			listener(outcome);
		};
		const subscription = this._onDidOutcome.event(deliver);
		const latest = this._latest;
		if (latest) {
			try {
				deliver(latest);
			} catch (error) {
				subscription.dispose();
				throw error;
			}
		}
		return subscription;
	}

	requestRefresh(): void {
		if (this._disposed) {
			return;
		}
		this._generation++;
		if (this._inFlight) {
			this._pendingImmediate = true;
			return;
		}
		this._scheduler.schedule(0);
	}

	private async _poll(): Promise<void> {
		if (this._disposed || this._inFlight) {
			return;
		}
		this._inFlight = true;
		const generation = this._generation;
		try {
			const snapshot = await this._transport();
			if (!this._disposed && generation === this._generation) {
				this._publish(Object.freeze({
					sequence: ++this._sequence,
					snapshot: Object.freeze({
						paneStatuses: Object.freeze(snapshot.paneStatuses.map(status => Object.freeze({ ...status }))),
						agentHookTokens: Object.freeze([...snapshot.agentHookTokens]),
						...(snapshot.agentHookTokenIssueUrls ? {
							agentHookTokenIssueUrls: Object.freeze(snapshot.agentHookTokenIssueUrls.map(entry => Object.freeze({ token: entry.token, issueUrls: Object.freeze([...entry.issueUrls]) }))),
						} : {}),
					}),
				}));
			}
		} catch (error) {
			// A refresh requested while this transport is running makes a successful snapshot
			// stale, but it must not erase the failed attempt from consumers' consecutive-failure
			// accounting. The queued immediate refresh will still run next.
			if (!this._disposed) {
				this._publish(Object.freeze({ sequence: ++this._sequence, error }));
			}
		} finally {
			this._inFlight = false;
			if (!this._disposed) {
				if (this._pendingImmediate) {
					this._pendingImmediate = false;
					this._scheduler.schedule(0);
				} else {
					this._scheduler.schedule(STATUS_POLL_INTERVAL_MS);
				}
			}
		}
	}

	private _publish(outcome: IParadisAgentStatusSnapshotOutcome): void {
		this._latest = outcome;
		this._onDidOutcome.fire(outcome);
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._generation++;
		this._pendingImmediate = false;
		this._scheduler.cancel();
		super.dispose();
	}
}

/** @internal Creates the real service with deterministic dependencies without widening its DI constructor. */
export function paradisCreateAgentStatusSnapshotServiceForTest(
	sharedProcessService: ISharedProcessService,
	testSeam: IParadisAgentStatusSnapshotServiceTestSeam,
): ParadisAgentStatusSnapshotService {
	const testSharedProcessService = Object.create(sharedProcessService) as IParadisAgentStatusSnapshotTestSharedProcessService;
	Object.defineProperty(testSharedProcessService, testSeamKey, { value: testSeam });
	return new ParadisAgentStatusSnapshotService(testSharedProcessService);
}

registerSingleton(IParadisAgentStatusSnapshotService, ParadisAgentStatusSnapshotService, InstantiationType.Delayed);
