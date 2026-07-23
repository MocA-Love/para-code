/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { GitHubApiClient, GitHubApiError, IGitHubApiRequestOptions, IGitHubApiResponse } from './githubApiClient.js';

const LOG_PREFIX = '[SessionGithubRequestGate]';

/**
 * Call sites whose requests are queued behind everything else. These are bulk /
 * best-effort lookups (e.g. resolving the PR number for every session at
 * startup) that must never starve interactive traffic such as the active
 * session's PR polling. The strings must match the `callSite` argument passed
 * to {@link GitHubApiClient.request} by the respective callers.
 */
const LOW_PRIORITY_CALL_SITES: ReadonlySet<string> = new Set([
	'githubApi.findPullRequestByHeadBranch',
]);

interface IGateQueueItem {
	readonly dispatch: () => void;
	readonly reject: (err: Error) => void;
}

export interface ISessionGithubRequestGateOptions {
	/** Sustained request budget. Also the bucket capacity (max burst). */
	readonly budgetPerMinute?: number;
	readonly maxConcurrent?: number;
	readonly backoffInitialMs?: number;
	readonly backoffMaxMs?: number;
	/** Clock, injectable for tests. */
	readonly now?: () => number;
}

/**
 * Global gate for all sessions-layer GitHub API traffic (REST and GraphQL).
 *
 * With hundreds of worktree sessions in one window, per-session polling used to
 * scale linearly and blow through GitHub's rate limits (primary and secondary).
 * This gate makes the total request volume structurally bounded, independent of
 * the session count:
 *
 * - **Budget**: a token bucket caps throughput at `budgetPerMinute` requests
 *   per minute (default 30 — well under GitHub's 5,000/hour primary REST
 *   limit). Conditional (ETag / 304) responses still count against GitHub's
 *   quota, so the budget counts every request, not just 200s.
 * - **Concurrency**: at most `maxConcurrent` requests in flight, so bursts
 *   cannot trip GitHub's secondary (abuse-detection) limits.
 * - **Backoff**: when GitHub signals a rate limit (429, 403 with an exhausted
 *   or abuse indication, or a GraphQL RATE_LIMITED error), ALL traffic is
 *   paused with exponential backoff (30s → doubling → max 300s). Only a
 *   success dispatched *after* the last rate-limit signal resets the backoff,
 *   so an in-flight request from before the signal cannot lift the pause.
 * - **Priority lanes**: bulk lookups ({@link LOW_PRIORITY_CALL_SITES}) are
 *   dispatched only when no interactive request is waiting.
 */
export class SessionGithubRequestGate extends Disposable {

	private readonly _budgetPerMinute: number;
	private readonly _maxConcurrent: number;
	private readonly _backoffInitialMs: number;
	private readonly _backoffMaxMs: number;
	private readonly _now: () => number;

	private readonly _highQueue: IGateQueueItem[] = [];
	private readonly _lowQueue: IGateQueueItem[] = [];
	private _tokens: number;
	private _lastRefillAt: number;
	private _inFlight = 0;
	private _pausedUntil = 0;
	private _backoffMs = 0;
	private _lastRateLimitAt = -1;

	private readonly _pumpScheduler = this._register(new RunOnceScheduler(() => this._pump(), 0));

	constructor(
		private readonly _logService: ILogService,
		options?: ISessionGithubRequestGateOptions,
	) {
		super();

		this._budgetPerMinute = options?.budgetPerMinute ?? 30;
		this._maxConcurrent = options?.maxConcurrent ?? 4;
		this._backoffInitialMs = options?.backoffInitialMs ?? 30_000;
		this._backoffMaxMs = options?.backoffMaxMs ?? 300_000;
		this._now = options?.now ?? Date.now;
		this._tokens = this._budgetPerMinute;
		this._lastRefillAt = this._now();
	}

	/**
	 * Queue `fn` behind the gate. Resolution order is FIFO within a lane; the
	 * high lane always drains before the low lane.
	 */
	run<T>(callSite: string, fn: () => Promise<T>): Promise<T> {
		if (this._store.isDisposed) {
			return Promise.reject(new CancellationError());
		}

		return new Promise<T>((resolve, reject) => {
			const dispatch = () => {
				const dispatchedAt = this._now();
				fn().then(
					value => {
						this._onRequestSettled(undefined, dispatchedAt);
						resolve(value);
					},
					err => {
						this._onRequestSettled(err, dispatchedAt);
						reject(err);
					}
				);
			};

			const queue = LOW_PRIORITY_CALL_SITES.has(callSite) ? this._lowQueue : this._highQueue;
			queue.push({ dispatch, reject });
			this._pumpScheduler.schedule(0);
		});
	}

	private _pump(): void {
		if (this._store.isDisposed) {
			return;
		}

		this._refillTokens();

		const now = this._now();
		while (
			this._inFlight < this._maxConcurrent &&
			this._tokens >= 1 &&
			now >= this._pausedUntil &&
			(this._highQueue.length > 0 || this._lowQueue.length > 0)
		) {
			const item = this._highQueue.length > 0 ? this._highQueue.shift()! : this._lowQueue.shift()!;
			this._tokens -= 1;
			this._inFlight += 1;
			item.dispatch();
		}

		this._scheduleNextPump();
	}

	private _scheduleNextPump(): void {
		if (this._highQueue.length === 0 && this._lowQueue.length === 0) {
			return;
		}

		const now = this._now();
		let delayMs = 0;
		if (now < this._pausedUntil) {
			delayMs = Math.max(delayMs, this._pausedUntil - now);
		}
		if (this._tokens < 1) {
			// Time until the bucket has one whole token again.
			const msPerToken = 60_000 / this._budgetPerMinute;
			delayMs = Math.max(delayMs, Math.ceil((1 - this._tokens) * msPerToken));
		}
		if (delayMs === 0 && this._inFlight >= this._maxConcurrent) {
			// Fully saturated: a completing request re-schedules the pump.
			return;
		}

		this._pumpScheduler.schedule(delayMs);
	}

	private _refillTokens(): void {
		const now = this._now();
		const elapsedMs = now - this._lastRefillAt;
		this._lastRefillAt = now;
		this._tokens = Math.min(
			this._budgetPerMinute,
			this._tokens + (elapsedMs / 60_000) * this._budgetPerMinute
		);
	}

	private _onRequestSettled(err: unknown, dispatchedAt: number): void {
		this._inFlight -= 1;

		if (err === undefined) {
			// Only a success whose request STARTED after the last rate-limit signal
			// proves the limit has lifted; an older in-flight success must not undo
			// the pause that a concurrent 403/429 just established.
			if (dispatchedAt > this._lastRateLimitAt && this._backoffMs !== 0) {
				this._logService.info(`${LOG_PREFIX} GitHub request succeeded; resetting rate-limit backoff`);
				this._backoffMs = 0;
			}
		} else if (isRateLimitError(err)) {
			const now = this._now();
			this._lastRateLimitAt = now;
			this._backoffMs = this._backoffMs === 0
				? this._backoffInitialMs
				: Math.min(this._backoffMs * 2, this._backoffMaxMs);
			this._pausedUntil = Math.max(this._pausedUntil, now + this._backoffMs);
			this._logService.warn(`${LOG_PREFIX} GitHub rate limit detected; pausing ALL sessions GitHub traffic for ${Math.round(this._backoffMs / 1000)}s (queued: ${this._highQueue.length} high / ${this._lowQueue.length} low)`);
		}

		this._pumpScheduler.schedule(0);
	}

	override dispose(): void {
		const pending = [...this._highQueue, ...this._lowQueue];
		this._highQueue.length = 0;
		this._lowQueue.length = 0;
		super.dispose();

		for (const item of pending) {
			item.reject(new CancellationError());
		}
	}
}

/**
 * `true` for errors that indicate GitHub is throttling us — either the primary
 * quota is exhausted or the secondary (abuse) limiter fired. Plain 403s (e.g.
 * missing repository permissions) must NOT pause the gate.
 */
export function isRateLimitError(err: unknown): boolean {
	if (!(err instanceof GitHubApiError)) {
		return false;
	}
	if (err.statusCode === 429) {
		return true;
	}
	if (err.statusCode === 403) {
		return err.rateLimitRemaining === 0 || /rate limit|abuse|secondary/i.test(err.message);
	}
	if (err.statusCode === 200) {
		// GraphQL rate limits surface as a 200 response with an error entry
		// (type RATE_LIMITED, message "API rate limit exceeded ...").
		return /rate.?limit/i.test(err.message);
	}
	return false;
}

/**
 * Drop-in replacement for {@link GitHubApiClient} that routes every REST and
 * GraphQL call through a shared {@link SessionGithubRequestGate}. Substituted
 * at the single construction point in `githubService.ts` so all existing
 * fetchers/models inherit the gating without modification.
 */
export class SessionGithubGatedApiClient extends GitHubApiClient {

	private readonly _gate: SessionGithubRequestGate;

	constructor(
		@IRequestService requestService: IRequestService,
		@IAuthenticationService authenticationService: IAuthenticationService,
		@ILogService logService: ILogService,
	) {
		super(requestService, authenticationService, logService);
		this._gate = this._register(new SessionGithubRequestGate(logService));
	}

	override async request<T>(method: string, path: string, callSite: string, options?: IGitHubApiRequestOptions): Promise<IGitHubApiResponse<T>> {
		return this._gate.run(callSite, () => super.request<T>(method, path, callSite, options));
	}

	override async graphql<T>(query: string, callSite: string, variables?: Record<string, unknown>): Promise<T> {
		return this._gate.run(callSite, () => super.graphql<T>(query, callSite, variables));
	}
}
