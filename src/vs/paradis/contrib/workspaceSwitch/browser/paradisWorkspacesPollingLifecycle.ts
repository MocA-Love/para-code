/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * 差分の定期の見回り。見回りで git を投げるのは、変更の印が付いた対象と、保険の時間（5分）を過ぎた対象だけ
 * （選ぶのは呼び出し側。paradisWorkspacesDiffStatsTracker.ts）。何も変わっていなければ git は投げない。
 */
const DIFF_STATS_POLL_INTERVAL_MS = 60_000;
/** 変更の知らせから取り直すまでの待ち。保存の連続やビルドの書き込みを 1 回にまとめる。 */
const DIFF_STATS_CHANGE_DELAY_MS = 1_500;
const PR_STATUS_POLL_INTERVAL_MS = 300_000;
const ISSUE_STATUS_POLL_INTERVAL_MS = 300_000;

/**
 * PR・Issue を問い合わせる対象の指紋。対象（URI とブランチ）と今いるスペースのどれかが変わったときだけ値が変わる。
 * worktree の一覧の通知は中身が変わっていなくても来る（main の HEAD の書き換え、ピンの付け外しなど）ので、
 * これを比べて、変わったときだけ PR・Issue を取り直す。
 */
export function paradisGithubTargetsFingerprint(targets: readonly { readonly uri: string; readonly branch: string | undefined }[], active: string | undefined): string {
	const entries = targets.map(target => `${target.uri}\t${target.branch ?? ''}`).sort();
	return JSON.stringify({ entries, active: active ?? null });
}

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
	/**
	 * PR・Issue を問い合わせる対象（worktree とそのブランチ、今いるスペース）が実際に変わったとき。渡すと、PR・Issue は
	 * リポジトリ・worktree の通知（中身が変わっていなくても来る）では取り直さず、これでだけ取り直す。
	 */
	readonly onDidChangeGithubTargets?: Event<void>;
	/**
	 * ウィンドウが表に出ているか（フォーカスがあり、最小化されていない）。渡すと、差分の取り直しは表に出ている
	 * ときだけ行い、裏に回っている間の変更は表に戻ったときに 1 回だけ取り直す。PR・Issue には掛けない。
	 */
	readonly isWindowActive?: () => boolean;
	readonly onDidChangeWindowActive?: Event<unknown>;
}

type SchedulerFactory = (runner: () => void, defaultDelay: number) => IParadisWorkspacesPollingScheduler;

interface IParadisWorkspacesPollState {
	readonly scheduler: IParadisWorkspacesPollingScheduler;
	readonly interval: number;
	/** この種類のポーリングを動かしてよいか（ビューが見えているか、差分ならウィンドウが表に出ているかも）。 */
	readonly gate: () => boolean;
	/** 最後に反映した gate の値。変わったときだけ止める・再開する。 */
	active: boolean;
	/** 変更の知らせによる短い待ちを予約済みか（予約を後ろへずらし続けないため）。 */
	changePending: boolean;
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
	private windowActive = true;

	constructor(
		signals: IParadisWorkspacesPollingSignals,
		refreshDiffStats: () => void,
		refreshPrStatus: () => void,
		schedulerFactory: SchedulerFactory = (runner, defaultDelay) => new RunOnceScheduler(runner, defaultDelay),
		private readonly now: () => number = Date.now,
		refreshIssueStatus?: () => void,
	) {
		super();
		const createState = (runner: () => void, interval: number, gate: () => boolean): IParadisWorkspacesPollState => ({
			scheduler: this._register(schedulerFactory(runner, interval)),
			interval,
			gate,
			active: false,
			changePending: false,
			inFlight: false,
			pendingImmediate: false,
			invalidated: false,
			lastCompletedAt: undefined,
		});
		const isWindowActive = signals.isWindowActive;
		this.diffStats = createState(refreshDiffStats, DIFF_STATS_POLL_INTERVAL_MS, () => this.visible && this.windowActive);
		this.prStatus = createState(refreshPrStatus, PR_STATUS_POLL_INTERVAL_MS, () => this.visible);
		this.issueStatus = refreshIssueStatus !== undefined ? createState(refreshIssueStatus, ISSUE_STATUS_POLL_INTERVAL_MS, () => this.visible) : undefined;

		this._register(signals.onDidChangeVisibility(() => this.setVisible(signals.isBodyVisible())));
		if (isWindowActive !== undefined) {
			this.windowActive = isWindowActive();
			if (signals.onDidChangeWindowActive !== undefined) {
				this._register(signals.onDidChangeWindowActive(() => this.setWindowActive(isWindowActive())));
			}
		}
		const githubFollowsTargets = signals.onDidChangeGithubTargets !== undefined;
		this._register(signals.onDidChangeRepositories(() => this.requestRefresh(true, !githubFollowsTargets)));
		this._register(signals.onDidChangeWorktrees(() => this.requestRefresh(true, !githubFollowsTargets)));
		if (signals.onDidChangeGithubTargets !== undefined) {
			this._register(signals.onDidChangeGithubTargets(() => this.requestGithubRefresh()));
		}
	}

	/** controller 構築時の実可視状態で、初回ポーリングを一度だけ開始する。 */
	start(visible: boolean): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.visible = visible;
		for (const state of this.allStates()) {
			state.active = state.gate();
			// 止まった状態で始まったものは、動き出したときに resume が最初の 1 回を取る
			if (state.active) {
				this.requestImmediate(state);
			}
		}
	}

	/**
	 * 差分の対象に変更の印が付いた。少し待ってから取り直す（待っている間の知らせはまとめる）。
	 * 止まっている間は、表に出たときに 1 回だけ取り直す。
	 */
	requestDiffStatsRefreshForChange(): void {
		if (!this.started) {
			return;
		}
		const state = this.diffStats;
		if (!state.active) {
			state.invalidated = true;
			return;
		}
		if (state.inFlight) {
			state.pendingImmediate = true;
			return;
		}
		if (state.changePending) {
			return;
		}
		state.changePending = true;
		state.scheduler.schedule(DIFF_STATS_CHANGE_DELAY_MS);
	}

	/** diff コマンドを開始できるときだけ in-flight にする。 */
	beginDiffStatsRefresh(): boolean {
		return this.begin(this.diffStats);
	}

	/** diff コマンド完了後、可視状態に応じて次回実行を決める。 */
	completeDiffStatsRefresh(): void {
		this.complete(this.diffStats);
	}

	/** PR コマンドを開始できるときだけ in-flight にする。 */
	beginPrStatusRefresh(): boolean {
		return this.begin(this.prStatus);
	}

	/** PR コマンド完了後、可視状態に応じて次回実行を決める。 */
	completePrStatusRefresh(): void {
		this.complete(this.prStatus);
	}

	/** Issue コマンドを開始できるときだけ in-flight にする。refreshIssueStatus 未指定なら常に false。 */
	beginIssueStatusRefresh(): boolean {
		return this.issueStatus !== undefined && this.begin(this.issueStatus);
	}

	/** Issue コマンド完了後、可視状態に応じて次回実行を決める。 */
	completeIssueStatusRefresh(): void {
		if (this.issueStatus !== undefined) {
			this.complete(this.issueStatus);
		}
	}

	/**
	 * 新規 Issue URL の検出時など、通常の300秒周期を待たずに次のIssue解決を即時実行させたい時に呼ぶ。
	 * diff/PR と違い repositories/worktrees の変化ではなく、エージェント状態の変化が契機になるため
	 * requestRefresh (private) とは別に公開する。
	 */
	requestImmediateIssueStatusRefresh(): void {
		if (this.issueStatus !== undefined && this.started && this.issueStatus.active) {
			this.requestImmediate(this.issueStatus);
		}
	}

	override dispose(): void {
		this.started = false;
		this.visible = false;
		for (const state of this.allStates()) {
			state.active = false;
			state.changePending = false;
			state.inFlight = false;
			state.pendingImmediate = false;
			state.invalidated = false;
		}
		super.dispose();
	}

	private setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		this.applyGates();
	}

	private setWindowActive(windowActive: boolean): void {
		if (this.windowActive === windowActive) {
			return;
		}
		this.windowActive = windowActive;
		this.applyGates();
	}

	/** 各種類の gate を読み直し、変わったものだけ止める・再開する。 */
	private applyGates(): void {
		if (!this.started) {
			return;
		}
		for (const state of this.allStates()) {
			const active = state.gate();
			if (active === state.active) {
				continue;
			}
			state.active = active;
			if (active) {
				this.resume(state);
			} else {
				this.cancelPending(state);
			}
		}
	}

	/** `includeGithub` が false なら diff だけを取り直す（PR・Issue は onDidChangeGithubTargets に任せる）。 */
	private requestRefresh(markInvalidated = false, includeGithub = true): void {
		if (!this.started) {
			return;
		}
		const states = includeGithub ? this.allStates() : [this.diffStats];
		for (const state of states) {
			if (state.active) {
				this.requestImmediate(state);
			} else if (markInvalidated) {
				state.invalidated = true;
			}
		}
	}

	/** PR・Issue の問い合わせ対象が変わった。非表示なら表示に戻ったときに取り直す。 */
	private requestGithubRefresh(): void {
		if (!this.started) {
			return;
		}
		const states = this.issueStatus !== undefined ? [this.prStatus, this.issueStatus] : [this.prStatus];
		for (const state of states) {
			if (state.active) {
				this.requestImmediate(state);
			} else {
				state.invalidated = true;
			}
		}
	}

	private allStates(): IParadisWorkspacesPollState[] {
		return this.issueStatus !== undefined ? [this.diffStats, this.prStatus, this.issueStatus] : [this.diffStats, this.prStatus];
	}

	private requestImmediate(state: IParadisWorkspacesPollState): void {
		if (state.inFlight) {
			state.pendingImmediate = true;
			return;
		}
		state.changePending = false;
		state.scheduler.schedule(0);
	}

	private begin(state: IParadisWorkspacesPollState): boolean {
		if (!this.started || !state.active) {
			return false;
		}
		if (state.inFlight) {
			state.pendingImmediate = true;
			return false;
		}
		state.inFlight = true;
		state.pendingImmediate = false;
		state.changePending = false;
		return true;
	}

	private complete(state: IParadisWorkspacesPollState): void {
		if (!state.inFlight) {
			return;
		}
		state.inFlight = false;
		state.lastCompletedAt = this.now();
		if (!state.active) {
			return;
		}
		if (state.pendingImmediate || state.invalidated) {
			state.pendingImmediate = false;
			state.invalidated = false;
			state.scheduler.schedule(0);
			return;
		}
		state.scheduler.schedule(state.interval);
	}

	private cancelPending(state: IParadisWorkspacesPollState): void {
		state.scheduler.cancel();
		if (state.changePending) {
			// 待っていた変更は、表に戻ったときに取り直す
			state.invalidated = true;
		}
		state.changePending = false;
		state.pendingImmediate = false;
	}

	private resume(state: IParadisWorkspacesPollState): void {
		if (state.inFlight) {
			return;
		}
		const interval = state.interval;
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

	/** 差分の対象に変更の印が付いたとき。少し待ってから取り直す。 */
	requestDiffStatsRefreshForChange(): void {
		this.lifecycle.requestDiffStatsRefreshForChange();
	}
}
