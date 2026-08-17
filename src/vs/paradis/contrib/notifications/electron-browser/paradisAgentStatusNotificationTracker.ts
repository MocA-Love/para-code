/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisAgentPaneStatus, ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';

const ACTION_CONFIRM_DELAY_MS = 5_000;

export type ParadisAgentNotifyStatus = 'review' | 'permission' | 'question';

export interface IParadisAgentStatusNotificationScheduler {
	schedule(runner: () => void, delay: number): IDisposable;
}

const defaultScheduler: IParadisAgentStatusNotificationScheduler = {
	schedule: (runner, delay) => disposableTimeout(runner, delay),
};

/**
 * Tracks pane status transitions independently from their transport. Poll failures never reach this
 * class, so they cannot discard transition history or pending action confirmations.
 */
export class ParadisAgentStatusNotificationTracker extends Disposable {
	private readonly _previousStatus = new Map<string, ParadisAgentStatus>();
	private readonly _pendingActionTimers = this._register(new DisposableMap<string>());
	private _disposed = false;

	constructor(
		private readonly _notify: (token: string, status: ParadisAgentNotifyStatus) => void,
		private readonly _scheduler: IParadisAgentStatusNotificationScheduler = defaultScheduler,
	) {
		super();
	}

	accept(statuses: readonly IParadisAgentPaneStatus[]): void {
		if (this._disposed) {
			return;
		}
		const seenTokens = new Set<string>();
		for (const paneStatus of statuses) {
			seenTokens.add(paneStatus.token);
			const previous = this._previousStatus.get(paneStatus.token);
			this._previousStatus.set(paneStatus.token, paneStatus.status);
			if (previous === paneStatus.status) {
				continue;
			}

			this._pendingActionTimers.deleteAndDispose(paneStatus.token);
			if (paneStatus.status === 'review') {
				this._notify(paneStatus.token, paneStatus.status);
				continue;
			}
			if (paneStatus.status !== 'permission' && paneStatus.status !== 'question') {
				continue;
			}

			const token = paneStatus.token;
			const status = paneStatus.status;
			this._pendingActionTimers.set(token, this._scheduler.schedule(() => {
				this._pendingActionTimers.deleteAndDispose(token);
				if (!this._disposed && this._previousStatus.get(token) === status) {
					this._notify(token, status);
				}
			}, ACTION_CONFIRM_DELAY_MS));
		}

		for (const token of [...this._previousStatus.keys()]) {
			if (!seenTokens.has(token)) {
				this._previousStatus.delete(token);
				this._pendingActionTimers.deleteAndDispose(token);
			}
		}
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._previousStatus.clear();
		super.dispose();
	}
}

/** The production subscription seam between the renderer singleton producer and notification state. */
export class ParadisAgentStatusNotificationConsumer extends Disposable {
	constructor(
		snapshotService: IParadisAgentStatusSnapshotService,
		tracker: ParadisAgentStatusNotificationTracker,
		onPollFailure: (error: unknown) => void,
	) {
		super();
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined) {
				tracker.accept(outcome.snapshot.paneStatuses);
			} else {
				onPollFailure(outcome.error);
			}
		}));
	}
}
