/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
// PARA-PATCH: upstream added IDefaultAccountService to GitHubApiClient's constructor (GH Enterprise endpoint derivation)
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
// Feeds the GitHub API Usage dashboard (paradis/contrib/githubMetrics) so its "space" breakdown
// also covers this window's own REST/GraphQL traffic, not just gh-CLI calls from worktrees.
import { paradisRecordRemoteGithubCall } from '../../../../paradis/contrib/githubMetrics/common/paradisGithubMetrics.js';
import { GitHubApiClient, GitHubApiError, GitHubApiResource, IGitHubApiRequestOptions, IGitHubApiResponse, IGitHubRateLimitSnapshot } from './githubApiClient.js';

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

/**
 * Upper bound for a pause derived from `x-ratelimit-reset`. GitHub's windows are
 * an hour at most, so anything beyond that is a broken header we should not
 * honour verbatim.
 */
const MAX_PAUSE_MS = 3_600_000;

interface IGateQueueItem {
	readonly resource: GitHubApiResource;
	readonly isLowPriority: boolean;
	readonly dispatch: () => void;
	readonly reject: (err: Error) => void;
}

/**
 * Per-resource throttling state. REST and GraphQL have entirely separate budgets
 * on GitHub's side, so they need separate backoff and separate accounting here —
 * a REST success says nothing about whether the GraphQL budget has recovered.
 */
interface IResourceState {
	/** All traffic for this resource is paused until this timestamp. */
	pausedUntil: number;
	/** Low-priority traffic for this resource is paused until this timestamp. */
	lowPriorityPausedUntil: number;
	backoffMs: number;
	lastRateLimitAt: number;
	limit: number | undefined;
	remaining: number | undefined;
	resetAtMs: number | undefined;
}

export interface ISessionGithubRequestGateOptions {
	/** Sustained request budget. Also the bucket capacity (max burst). */
	readonly budgetPerMinute?: number;
	readonly maxConcurrent?: number;
	readonly backoffInitialMs?: number;
	readonly backoffMaxMs?: number;
	/** Remaining-budget fraction at or below which ALL traffic waits for the window reset. */
	readonly criticalRemainingRatio?: number;
	/** Remaining-budget fraction at or below which low-priority traffic waits for the window reset. */
	readonly lowPriorityRemainingRatio?: number;
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
 *   limit). Conditional (ETag / 304) responses still count against the bucket,
 *   so the budget counts every request, not just 200s.
 * - **Concurrency**: at most `maxConcurrent` requests in flight, so bursts
 *   cannot trip GitHub's secondary (abuse-detection) limits.
 * - **Per-resource budgets**: a request count is not a budget for GraphQL,
 *   which is billed in *points* proportional to query size against a separate
 *   5,000/hour allowance. The gate therefore tracks GitHub's own accounting
 *   from the `x-ratelimit-*` headers per resource, throttling low-priority
 *   traffic once a budget drops below `lowPriorityRemainingRatio` and holding
 *   everything until the window resets below `criticalRemainingRatio`.
 * - **Backoff**: when GitHub signals a rate limit (429, 403 with an exhausted
 *   or abuse indication, or a GraphQL RATE_LIMITED error), that resource's
 *   traffic is paused with exponential backoff (30s → doubling → max 300s), or
 *   until `x-ratelimit-reset` if that is later — a primary limit resets on a
 *   fixed window, which exponential backoff alone would keep re-entering. Only
 *   a success on the *same resource* dispatched *after* the last rate-limit
 *   signal resets the backoff.
 * - **Priority lanes**: bulk lookups ({@link LOW_PRIORITY_CALL_SITES}) are
 *   dispatched only when no interactive request is waiting.
 */
export class SessionGithubRequestGate extends Disposable {

	private readonly _budgetPerMinute: number;
	private readonly _maxConcurrent: number;
	private readonly _backoffInitialMs: number;
	private readonly _backoffMaxMs: number;
	private readonly _criticalRemainingRatio: number;
	private readonly _lowPriorityRemainingRatio: number;
	private readonly _now: () => number;

	private readonly _highQueue: IGateQueueItem[] = [];
	private readonly _lowQueue: IGateQueueItem[] = [];
	private readonly _resourceStates = new Map<GitHubApiResource, IResourceState>();
	private _tokens: number;
	private _lastRefillAt: number;
	private _inFlight = 0;

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
		this._criticalRemainingRatio = options?.criticalRemainingRatio ?? 0.05;
		this._lowPriorityRemainingRatio = options?.lowPriorityRemainingRatio ?? 0.25;
		this._now = options?.now ?? Date.now;
		this._tokens = this._budgetPerMinute;
		this._lastRefillAt = this._now();
	}

	/**
	 * Queue `fn` behind the gate. Resolution order is FIFO within a lane (and,
	 * while a resource is paused, within a resource); the high lane always drains
	 * before the low lane.
	 */
	run<T>(callSite: string, fn: () => Promise<T>, resource: GitHubApiResource = 'rest'): Promise<T> {
		if (this._store.isDisposed) {
			return Promise.reject(new CancellationError());
		}

		return new Promise<T>((resolve, reject) => {
			const dispatch = () => {
				const dispatchedAt = this._now();
				fn().then(
					value => {
						this._onRequestSettled(undefined, dispatchedAt, resource);
						this._recordMetrics(callSite, resource, dispatchedAt, undefined);
						resolve(value);
					},
					err => {
						this._onRequestSettled(err, dispatchedAt, resource);
						this._recordMetrics(callSite, resource, dispatchedAt, err);
						reject(err);
					}
				);
			};

			const isLowPriority = LOW_PRIORITY_CALL_SITES.has(callSite);
			const queue = isLowPriority ? this._lowQueue : this._highQueue;
			queue.push({ resource, isLowPriority, dispatch, reject });
			this._pumpScheduler.schedule(0);
		});
	}

	/**
	 * Record GitHub's own view of a budget, as reported by the `x-ratelimit-*`
	 * response headers. This is what lets the gate stay under the GraphQL limit,
	 * which a request count cannot express.
	 */
	noteRateLimitSnapshot(snapshot: IGitHubRateLimitSnapshot): void {
		if (this._store.isDisposed) {
			return;
		}

		const state = this._stateFor(snapshot.resource);
		state.limit = snapshot.limit ?? state.limit;
		state.remaining = snapshot.remaining ?? state.remaining;
		state.resetAtMs = snapshot.resetAtMs ?? state.resetAtMs;

		if (state.limit === undefined || state.remaining === undefined || state.limit <= 0) {
			return;
		}

		const resumeAt = this._resolveResetAt(state.resetAtMs);
		if (resumeAt === undefined) {
			return;
		}

		const remainingRatio = state.remaining / state.limit;
		if (remainingRatio <= this._criticalRemainingRatio) {
			if (state.pausedUntil < resumeAt) {
				state.pausedUntil = resumeAt;
				this._logService.warn(`${LOG_PREFIX} GitHub ${snapshot.resource} budget nearly exhausted (${state.remaining}/${state.limit}); holding all ${snapshot.resource} traffic for ${Math.round((resumeAt - this._now()) / 1000)}s until the window resets`);
			}
		} else if (remainingRatio <= this._lowPriorityRemainingRatio) {
			if (state.lowPriorityPausedUntil < resumeAt) {
				state.lowPriorityPausedUntil = resumeAt;
				this._logService.info(`${LOG_PREFIX} GitHub ${snapshot.resource} budget low (${state.remaining}/${state.limit}); deferring bulk ${snapshot.resource} lookups until the window resets`);
			}
		}

		this._pumpScheduler.schedule(0);
	}

	private _stateFor(resource: GitHubApiResource): IResourceState {
		let state = this._resourceStates.get(resource);
		if (!state) {
			state = {
				pausedUntil: 0,
				lowPriorityPausedUntil: 0,
				backoffMs: 0,
				lastRateLimitAt: -1,
				limit: undefined,
				remaining: undefined,
				resetAtMs: undefined,
			};
			this._resourceStates.set(resource, state);
		}
		return state;
	}

	/** The earliest time `item` may be dispatched, given its resource and lane. */
	private _dispatchableAt(item: IGateQueueItem): number {
		const state = this._stateFor(item.resource);
		return item.isLowPriority
			? Math.max(state.pausedUntil, state.lowPriorityPausedUntil)
			: state.pausedUntil;
	}

	/**
	 * Take the next item that may run now: a dispatchable high-lane item first,
	 * otherwise a dispatchable low-lane one. Items whose resource is paused are
	 * skipped rather than blocking the queue, so a paused GraphQL budget cannot
	 * stall REST traffic — including the low lane, which would otherwise sit
	 * behind a high-lane GraphQL request that cannot run for another hour.
	 */
	private _takeNextDispatchable(now: number): IGateQueueItem | undefined {
		const highIndex = this._highQueue.findIndex(item => this._dispatchableAt(item) <= now);
		if (highIndex !== -1) {
			return this._highQueue.splice(highIndex, 1)[0];
		}

		const lowIndex = this._lowQueue.findIndex(item => this._dispatchableAt(item) <= now);
		return lowIndex !== -1 ? this._lowQueue.splice(lowIndex, 1)[0] : undefined;
	}

	private _pump(): void {
		if (this._store.isDisposed) {
			return;
		}

		this._refillTokens();

		while (this._inFlight < this._maxConcurrent && this._tokens >= 1) {
			const item = this._takeNextDispatchable(this._now());
			if (!item) {
				break;
			}

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

		// Soonest moment any queued item's resource comes off pause. Both lanes count:
		// the low lane runs whenever the high lane has nothing dispatchable.
		let earliestDispatchableAt = Number.POSITIVE_INFINITY;
		for (const item of this._highQueue) {
			earliestDispatchableAt = Math.min(earliestDispatchableAt, this._dispatchableAt(item));
		}
		for (const item of this._lowQueue) {
			earliestDispatchableAt = Math.min(earliestDispatchableAt, this._dispatchableAt(item));
		}
		if (earliestDispatchableAt > now && earliestDispatchableAt !== Number.POSITIVE_INFINITY) {
			delayMs = Math.max(delayMs, earliestDispatchableAt - now);
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

	/** A usable resume timestamp from `x-ratelimit-reset`, or `undefined`. */
	private _resolveResetAt(resetAtMs: number | undefined): number | undefined {
		if (resetAtMs === undefined) {
			return undefined;
		}

		const now = this._now();
		if (resetAtMs <= now) {
			return undefined;
		}

		return Math.min(resetAtMs, now + MAX_PAUSE_MS);
	}

	private _onRequestSettled(err: unknown, dispatchedAt: number, resource: GitHubApiResource): void {
		this._inFlight -= 1;

		const state = this._stateFor(resource);

		if (err === undefined) {
			// Only a success whose request STARTED after the last rate-limit signal
			// proves the limit has lifted; an older in-flight success must not undo
			// the pause that a concurrent 403/429 just established. It also has to be
			// a success on the SAME resource — REST recovering says nothing about the
			// GraphQL budget, and treating it as proof used to lift GraphQL pauses
			// immediately, straight back into the limit.
			if (dispatchedAt > state.lastRateLimitAt && state.backoffMs !== 0) {
				this._logService.info(`${LOG_PREFIX} GitHub ${resource} request succeeded; resetting its rate-limit backoff`);
				state.backoffMs = 0;
			}
		} else if (isRateLimitError(err)) {
			const now = this._now();
			state.lastRateLimitAt = now;
			state.backoffMs = state.backoffMs === 0
				? this._backoffInitialMs
				: Math.min(state.backoffMs * 2, this._backoffMaxMs);

			// A primary limit resets on a fixed window (an hour for GraphQL), so
			// honour `x-ratelimit-reset` when it is further out than the backoff —
			// otherwise we just re-enter the limit every few minutes.
			const resumeAt = Math.max(now + state.backoffMs, this._resolveResetAt(state.resetAtMs) ?? 0);
			state.pausedUntil = Math.max(state.pausedUntil, resumeAt);
			this._logService.warn(`${LOG_PREFIX} GitHub ${resource} rate limit detected; pausing ${resource} traffic for ${Math.round((resumeAt - now) / 1000)}s (queued: ${this._highQueue.length} high / ${this._lowQueue.length} low)`);
		}

		this._pumpScheduler.schedule(0);
	}

	/**
	 * Forwards this call to the GitHub API Usage dashboard. `resource` uses this gate's own
	 * 'rest'/'graphql' vocabulary, mapped to 'core'/'graphql' to match `gh api rate_limit`'s
	 * resource names. There is no worktreePath here — this gate serves the whole window, not a
	 * single worktree/session — so these calls land in the dashboard's unscoped-space bucket.
	 */
	private _recordMetrics(callSite: string, resource: GitHubApiResource, dispatchedAt: number, err: unknown): void {
		paradisRecordRemoteGithubCall({
			at: this._now(),
			callSite,
			resource: resource === 'graphql' ? 'graphql' : 'core',
			durationMs: this._now() - dispatchedAt,
			success: err === undefined,
			rateLimited: err !== undefined && isRateLimitError(err),
			errorMessage: err === undefined ? undefined : err instanceof Error ? err.message : String(err),
		});
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
		@IDefaultAccountService defaultAccountService: IDefaultAccountService,
		@ILogService logService: ILogService,
	) {
		super(requestService, authenticationService, defaultAccountService, logService);
		this._gate = this._register(new SessionGithubRequestGate(logService));
	}

	override async request<T>(method: string, path: string, callSite: string, options?: IGitHubApiRequestOptions): Promise<IGitHubApiResponse<T>> {
		return this._gate.run(callSite, () => super.request<T>(method, path, callSite, options), 'rest');
	}

	override async graphql<T>(query: string, callSite: string, variables?: Record<string, unknown>, options?: Pick<IGitHubApiRequestOptions, 'token' | 'createAuthenticationSession'>): Promise<T> {
		return this._gate.run(callSite, () => super.graphql<T>(query, callSite, variables, options), 'graphql');
	}

	protected override _onRateLimitSnapshot(snapshot: IGitHubRateLimitSnapshot): void {
		this._gate.noteRateLimitSnapshot(snapshot);
	}
}
