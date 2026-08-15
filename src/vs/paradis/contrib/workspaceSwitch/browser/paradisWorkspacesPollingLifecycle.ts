/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';

const DIFF_STATS_POLL_INTERVAL_MS = 10_000;
const PR_STATUS_POLL_INTERVAL_MS = 300_000;

/** Workspaces view のポーリングを起動するスケジューラーの最小契約。 */
export interface IParadisWorkspacesPollingScheduler extends IDisposable {
	schedule(delay?: number): void;
	cancel(): void;
}

/** Workspaces view と、その配下のリポジトリ・worktree が発するポーリング用イベント。 */
export interface IParadisWorkspacesPollingSignals {
	readonly isBodyVisible: () => boolean;
	readonly onDidChangeVisibility: Event<boolean>;
	readonly onDidChangeRepositories: Event<void>;
	readonly onDidChangeWorktrees: Event<void>;
}

type SchedulerFactory = (runner: () => void, defaultDelay: number) => IParadisWorkspacesPollingScheduler;

interface IParadisWorkspacesPollState {
	readonly scheduler: IParadisWorkspacesPollingScheduler;
	inFlight: boolean;
	pendingImmediate: boolean;
}

/**
 * Workspaces view 専用の diff / PR ポーリング lifecycle。
 * 非表示中はタイマーを持たず、実行中のコマンドは止めずに完了後の再スケジュールだけを抑止する。
 */
export class ParadisWorkspacesPollingLifecycle extends Disposable {
	private readonly diffStats: IParadisWorkspacesPollState;
	private readonly prStatus: IParadisWorkspacesPollState;
	private started = false;
	private visible = false;

	constructor(
		signals: IParadisWorkspacesPollingSignals,
		refreshDiffStats: () => void,
		refreshPrStatus: () => void,
		schedulerFactory: SchedulerFactory = (runner, defaultDelay) => new RunOnceScheduler(runner, defaultDelay),
	) {
		super();
		this.diffStats = {
			scheduler: this._register(schedulerFactory(refreshDiffStats, DIFF_STATS_POLL_INTERVAL_MS)),
			inFlight: false,
			pendingImmediate: false,
		};
		this.prStatus = {
			scheduler: this._register(schedulerFactory(refreshPrStatus, PR_STATUS_POLL_INTERVAL_MS)),
			inFlight: false,
			pendingImmediate: false,
		};

		this._register(signals.onDidChangeVisibility(() => this.setVisible(signals.isBodyVisible())));
		this._register(signals.onDidChangeRepositories(() => this.requestRefresh()));
		this._register(signals.onDidChangeWorktrees(() => this.requestRefresh()));
	}

	/** renderBody 完了時の可視状態で、初回ポーリングを一度だけ開始する。 */
	start(visible: boolean): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.visible = visible;
		if (visible) {
			this.requestRefresh();
		}
	}

	/** diff コマンドを開始できるときだけ in-flight にする。 */
	beginDiffStatsRefresh(): boolean {
		return this.begin(this.diffStats);
	}

	/** diff コマンド完了後、可視状態に応じて次回実行を決める。 */
	completeDiffStatsRefresh(): void {
		this.complete(this.diffStats, DIFF_STATS_POLL_INTERVAL_MS);
	}

	/** PR コマンドを開始できるときだけ in-flight にする。 */
	beginPrStatusRefresh(): boolean {
		return this.begin(this.prStatus);
	}

	/** PR コマンド完了後、可視状態に応じて次回実行を決める。 */
	completePrStatusRefresh(): void {
		this.complete(this.prStatus, PR_STATUS_POLL_INTERVAL_MS);
	}

	private setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (!this.started) {
			return;
		}
		if (!visible) {
			this.cancelPending(this.diffStats);
			this.cancelPending(this.prStatus);
			return;
		}
		this.requestRefresh();
	}

	private requestRefresh(): void {
		if (!this.started || !this.visible) {
			return;
		}
		this.requestImmediate(this.diffStats);
		this.requestImmediate(this.prStatus);
	}

	private requestImmediate(state: IParadisWorkspacesPollState): void {
		if (state.inFlight) {
			state.pendingImmediate = true;
			return;
		}
		state.scheduler.schedule(0);
	}

	private begin(state: IParadisWorkspacesPollState): boolean {
		if (!this.started || !this.visible) {
			return false;
		}
		if (state.inFlight) {
			state.pendingImmediate = true;
			return false;
		}
		state.inFlight = true;
		state.pendingImmediate = false;
		return true;
	}

	private complete(state: IParadisWorkspacesPollState, interval: number): void {
		if (!state.inFlight) {
			return;
		}
		state.inFlight = false;
		if (!this.visible) {
			state.pendingImmediate = false;
			return;
		}
		if (state.pendingImmediate) {
			state.pendingImmediate = false;
			state.scheduler.schedule(0);
			return;
		}
		state.scheduler.schedule(interval);
	}

	private cancelPending(state: IParadisWorkspacesPollState): void {
		state.scheduler.cancel();
		state.pendingImmediate = false;
	}
}

/**
 * Workspaces view の実イベントと非同期 refresh を lifecycle へ結線する production controller。
 * 可視性はイベント引数ではなく、その時点の isBodyVisible() から必ず読み直す。
 */
export class ParadisWorkspacesPollingController extends Disposable {
	private readonly lifecycle: ParadisWorkspacesPollingLifecycle;

	constructor(
		signals: IParadisWorkspacesPollingSignals,
		private readonly refreshDiffStats: () => Promise<void>,
		private readonly refreshPrStatus: () => Promise<void>,
		schedulerFactory?: SchedulerFactory,
	) {
		super();
		this.lifecycle = this._register(new ParadisWorkspacesPollingLifecycle(
			signals,
			() => { void this.runDiffStatsRefresh(); },
			() => { void this.runPrStatusRefresh(); },
			schedulerFactory,
		));
		this.lifecycle.start(signals.isBodyVisible());
	}

	private async runDiffStatsRefresh(): Promise<void> {
		if (!this.lifecycle.beginDiffStatsRefresh()) {
			return;
		}
		try {
			await this.refreshDiffStats();
		} catch {
			// web ビルド等でコマンド未登録の場合は、diff バッジを出さず次回ポーリングへ進む
		} finally {
			this.lifecycle.completeDiffStatsRefresh();
		}
	}

	private async runPrStatusRefresh(): Promise<void> {
		if (!this.lifecycle.beginPrStatusRefresh()) {
			return;
		}
		try {
			await this.refreshPrStatus();
		} catch {
			// web ビルド等でコマンド未登録の場合は、PR チップを出さず次回ポーリングへ進む
		} finally {
			this.lifecycle.completePrStatusRefresh();
		}
	}
}
