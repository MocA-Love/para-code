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
	/** 今の状態になった時刻（shared process の changedAt）。完了の直前の状態に入った時刻＝ターンの作業の開始。 */
	private readonly _previousChangedAt = new Map<string, number>();
	private readonly _pendingActionTimers = this._register(new DisposableMap<string>());
	private _disposed = false;
	/** 最初のスナップショットを受け取ったか。 */
	private _primed = false;

	constructor(
		/** `since` は遷移の直前の状態に入った時刻（分からなければ undefined）。 */
		private readonly _notify: (token: string, status: ParadisAgentNotifyStatus, since?: number) => void,
		private readonly _scheduler: IParadisAgentStatusNotificationScheduler = defaultScheduler,
		/**
		 * ウィンドウを再読み込みしたときの、読み込み直した時刻。最初のスナップショットのうち、この時刻より前に
		 * 今の状態になったものは、読み込み直す前のウィンドウが通知済みなので、基準として覚えるだけにする
		 * （鳴らし直さない）。再読み込みでなければ undefined（最初のスナップショットも通知する）。
		 */
		private readonly _reloadedAt?: number,
	) {
		super();
	}

	accept(statuses: readonly IParadisAgentPaneStatus[]): void {
		if (this._disposed) {
			return;
		}
		const seenTokens = new Set<string>();
		const first = !this._primed;
		this._primed = true;
		for (const paneStatus of statuses) {
			seenTokens.add(paneStatus.token);
			const previous = this._previousStatus.get(paneStatus.token);
			const previousChangedAt = this._previousChangedAt.get(paneStatus.token);
			this._previousStatus.set(paneStatus.token, paneStatus.status);
			if (previous === paneStatus.status) {
				// hook は同じ状態のままでもイベントのたびに changedAt を書き直すので、状態が変わったときの
				// 時刻だけを覚える（完了の直前の working に入った時刻＝ターンの作業の開始、を保つ）。
				continue;
			}
			this._previousChangedAt.set(paneStatus.token, paneStatus.changedAt);
			if (first && this._reloadedAt !== undefined && paneStatus.changedAt < this._reloadedAt) {
				// 再読み込みの前からこの状態だった。前のウィンドウが通知済みなので、二重に鳴らさない。
				continue;
			}

			this._pendingActionTimers.deleteAndDispose(paneStatus.token);
			if (paneStatus.status === 'review') {
				// Para Code が止まっている間の完了を流し直したもの（W2-20）は、印だけで鳴らさない。
				if (paneStatus.quiet !== true) {
					this._notify(paneStatus.token, paneStatus.status, previous !== undefined ? previousChangedAt : undefined);
				}
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
				this._previousChangedAt.delete(token);
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
		this._previousChangedAt.clear();
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
