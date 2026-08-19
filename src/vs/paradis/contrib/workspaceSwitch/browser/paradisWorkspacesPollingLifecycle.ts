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
const ISSUE_STATUS_POLL_INTERVAL_MS = 300_000;

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
	invalidated: boolean;
	lastCompletedAt: number | undefined;
}

/**
 * Workspaces view 専用の diff / PR ポーリング lifecycle。
 * 非表示中はタイマーを持たず、実行中のコマンドは止めずに完了後の再スケジュールだけを抑止する。
 */
export class ParadisWorkspacesPollingLifecycle extends Disposable {
	private readonly diffStats: IParadisWorkspacesPollState;
	private readonly prStatus: IParadisWorkspacesPollState;
	/**
	 * 検出済み Issue の解決ポーリング。呼び出し元 (refreshIssueStatus) が省略された場合は
	 * undefined のままにし、開始・完了・即時要求のすべてを無害な no-op にする
	 * (Web ビルド等、Issueマーク自体を持たない構成／既存テストの3引数呼び出しとの互換のため)。
	 */
	private readonly issueStatus: IParadisWorkspacesPollState | undefined;
	private started = false;
	private visible = false;

	constructor(
		signals: IParadisWorkspacesPollingSignals,
		refreshDiffStats: () => void,
		refreshPrStatus: () => void,
		schedulerFactory: SchedulerFactory = (runner, defaultDelay) => new RunOnceScheduler(runner, defaultDelay),
		private readonly now: () => number = Date.now,
		refreshIssueStatus?: () => void,
	) {
		super();
		this.diffStats = {
			scheduler: this._register(schedulerFactory(refreshDiffStats, DIFF_STATS_POLL_INTERVAL_MS)),
			inFlight: false,
			pendingImmediate: false,
			invalidated: false,
			lastCompletedAt: undefined,
		};
		this.prStatus = {
			scheduler: this._register(schedulerFactory(refreshPrStatus, PR_STATUS_POLL_INTERVAL_MS)),
			inFlight: false,
			pendingImmediate: false,
			invalidated: false,
			lastCompletedAt: undefined,
		};
		this.issueStatus = refreshIssueStatus !== undefined ? {
			scheduler: this._register(schedulerFactory(refreshIssueStatus, ISSUE_STATUS_POLL_INTERVAL_MS)),
			inFlight: false,
			pendingImmediate: false,
			invalidated: false,
			lastCompletedAt: undefined,
		} : undefined;

		this._register(signals.onDidChangeVisibility(() => this.setVisible(signals.isBodyVisible())));
		this._register(signals.onDidChangeRepositories(() => this.requestRefresh(true)));
		this._register(signals.onDidChangeWorktrees(() => this.requestRefresh(true)));
	}

	/** controller 構築時の実可視状態で、初回ポーリングを一度だけ開始する。 */
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

	/** Issue コマンドを開始できるときだけ in-flight にする。refreshIssueStatus 未指定なら常に false。 */
	beginIssueStatusRefresh(): boolean {
		return this.issueStatus !== undefined && this.begin(this.issueStatus);
	}

	/** Issue コマンド完了後、可視状態に応じて次回実行を決める。 */
	completeIssueStatusRefresh(): void {
		if (this.issueStatus !== undefined) {
			this.complete(this.issueStatus, ISSUE_STATUS_POLL_INTERVAL_MS);
		}
	}

	/**
	 * 新規 Issue URL の検出時など、通常の300秒周期を待たずに次のIssue解決を即時実行させたい時に呼ぶ。
	 * diff/PR と違い repositories/worktrees の変化ではなく、エージェント状態の変化が契機になるため
	 * requestRefresh (private) とは別に公開する。
	 */
	requestImmediateIssueStatusRefresh(): void {
		if (this.issueStatus !== undefined && this.started && this.visible) {
			this.requestImmediate(this.issueStatus);
		}
	}

	override dispose(): void {
		this.started = false;
		this.visible = false;
		this.diffStats.inFlight = false;
		this.diffStats.pendingImmediate = false;
		this.diffStats.invalidated = false;
		this.prStatus.inFlight = false;
		this.prStatus.pendingImmediate = false;
		this.prStatus.invalidated = false;
		if (this.issueStatus !== undefined) {
			this.issueStatus.inFlight = false;
			this.issueStatus.pendingImmediate = false;
			this.issueStatus.invalidated = false;
		}
		super.dispose();
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
			if (this.issueStatus !== undefined) {
				this.cancelPending(this.issueStatus);
			}
			return;
		}
		this.resume(this.diffStats, DIFF_STATS_POLL_INTERVAL_MS);
		this.resume(this.prStatus, PR_STATUS_POLL_INTERVAL_MS);
		if (this.issueStatus !== undefined) {
			this.resume(this.issueStatus, ISSUE_STATUS_POLL_INTERVAL_MS);
		}
	}

	private requestRefresh(markInvalidated = false): void {
		if (!this.started) {
			return;
		}
		if (!this.visible) {
			if (markInvalidated) {
				this.diffStats.invalidated = true;
				this.prStatus.invalidated = true;
				if (this.issueStatus !== undefined) {
					this.issueStatus.invalidated = true;
				}
			}
			return;
		}
		this.requestImmediate(this.diffStats);
		this.requestImmediate(this.prStatus);
		if (this.issueStatus !== undefined) {
			this.requestImmediate(this.issueStatus);
		}
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
		state.lastCompletedAt = this.now();
		if (!this.visible) {
			return;
		}
		if (state.pendingImmediate || state.invalidated) {
			state.pendingImmediate = false;
			state.invalidated = false;
			state.scheduler.schedule(0);
			return;
		}
		state.scheduler.schedule(interval);
	}

	private cancelPending(state: IParadisWorkspacesPollState): void {
		state.scheduler.cancel();
		state.pendingImmediate = false;
	}

	private resume(state: IParadisWorkspacesPollState, interval: number): void {
		if (state.inFlight) {
			return;
		}
		const elapsed = state.lastCompletedAt === undefined ? interval : this.now() - state.lastCompletedAt;
		if (state.invalidated || elapsed >= interval) {
			state.invalidated = false;
			state.scheduler.schedule(0);
			return;
		}
		state.scheduler.schedule(Math.max(0, interval - elapsed));
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
		now?: () => number,
		private readonly refreshIssueStatus?: () => Promise<void>,
	) {
		super();
		this.lifecycle = this._register(new ParadisWorkspacesPollingLifecycle(
			signals,
			() => { void this.runDiffStatsRefresh(); },
			() => { void this.runPrStatusRefresh(); },
			schedulerFactory,
			now,
			this.refreshIssueStatus !== undefined ? () => { void this.runIssueStatusRefresh(); } : undefined,
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

	private async runIssueStatusRefresh(): Promise<void> {
		if (this.refreshIssueStatus === undefined || !this.lifecycle.beginIssueStatusRefresh()) {
			return;
		}
		try {
			await this.refreshIssueStatus();
		} catch {
			// web ビルド等でコマンド未登録の場合は、Issueマークの詳細を出さず次回ポーリングへ進む
		} finally {
			this.lifecycle.completeIssueStatusRefresh();
		}
	}

	/** 新規 Issue URL の検出時に、通常の300秒周期を待たず次のIssue解決を即時実行させる。 */
	requestImmediateIssueStatusRefresh(): void {
		this.lifecycle.requestImmediateIssueStatusRefresh();
	}
}
