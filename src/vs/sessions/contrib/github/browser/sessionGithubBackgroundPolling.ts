/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const LOG_PREFIX = '[SessionGithubBackgroundRefreshScheduler]';

/** Anything with a `refresh` method — satisfied by all sessions GitHub models. */
export interface ISessionGithubRefreshable {
	refresh(): Promise<void>;
}

/**
 * Background (non-active session) tier of the sessions PR polling.
 *
 * The upstream contribution polled every session's PR — including CI and
 * review threads — every 60 seconds, which scales linearly with the session
 * count and drowns GitHub's rate limits once a workspace holds hundreds of
 * worktrees. Non-active sessions only need their list icon to trail reality
 * by minutes, not seconds.
 *
 * This scheduler makes the background tier's traffic **structurally bounded**:
 * one shared round-robin loop refreshes at most one registered model per tick
 * (each PR-model refresh issues ~2 REST requests, so the background tier can
 * never exceed roughly 2 requests per tick interval, no matter
 * how many sessions are registered). Models that have never been fetched are
 * served first (so icons appear), then the least-recently refreshed model —
 * but no model is refreshed more often than `MIN_MODEL_REFRESH_INTERVAL_MS`,
 * so a window with only a handful of sessions stays nearly silent.
 *
 * Intentionally NOT implemented via `GitHubPullRequestModel.startPolling` —
 * the model's `_poll()` re-schedules itself with the scheduler's default 60s
 * interval, so a custom `intervalMs` only applies to the first tick.
 */
export class SessionGithubBackgroundRefreshScheduler extends Disposable {

	/** One model refresh (~2 requests) at most per tick, i.e. at most ~24 requests/min. */
	private static readonly TICK_INTERVAL_MS = 5_000;

	/** Lower bound between two refreshes of the same model. */
	private static readonly MIN_MODEL_REFRESH_INTERVAL_MS = 900_000; // 15 min

	/** `lastRefreshAt === 0` means "never fetched" and is served first. */
	private readonly _entries = new Map<ISessionGithubRefreshable, { refCount: number; lastRefreshAt: number }>();
	private readonly _timer = this._register(new IntervalTimer());

	constructor(
		private readonly _logService: ILogService,
		private readonly _now: () => number = Date.now,
	) {
		super();

		this._timer.cancelAndSet(() => this.tick(), SessionGithubBackgroundRefreshScheduler.TICK_INTERVAL_MS);
	}

	/**
	 * Add `model` to the round-robin. Reference-counted: the same model may be
	 * registered by multiple sessions (worktrees sharing one PR) and stays in
	 * the loop until the last registration is disposed.
	 *
	 * @param hasDataAlready `true` when the model already holds PR data (e.g. it
	 * was the active session's model until a moment ago) — it then waits a full
	 * interval instead of being treated as a cold model that needs data now.
	 */
	register(model: ISessionGithubRefreshable, hasDataAlready: boolean): IDisposable {
		let entry = this._entries.get(model);
		if (!entry) {
			entry = { refCount: 0, lastRefreshAt: hasDataAlready ? this._now() : 0 };
			this._entries.set(model, entry);
		}
		entry.refCount++;

		return toDisposable(() => {
			const current = this._entries.get(model);
			if (current && --current.refCount === 0) {
				this._entries.delete(model);
			}
		});
	}

	/**
	 * Refresh the most deserving model, if any: a never-fetched model first,
	 * otherwise the least-recently refreshed one that is past the per-model
	 * interval. Public for deterministic tests; production ticks come from the
	 * internal timer.
	 */
	tick(): void {
		const now = this._now();

		let candidate: ISessionGithubRefreshable | undefined;
		let candidateEntry: { refCount: number; lastRefreshAt: number } | undefined;
		for (const [model, entry] of this._entries) {
			if (entry.lastRefreshAt === 0) {
				candidate = model;
				candidateEntry = entry;
				break;
			}
			if (now - entry.lastRefreshAt >= SessionGithubBackgroundRefreshScheduler.MIN_MODEL_REFRESH_INTERVAL_MS &&
				(!candidateEntry || entry.lastRefreshAt < candidateEntry.lastRefreshAt)) {
				candidate = model;
				candidateEntry = entry;
			}
		}

		if (!candidate || !candidateEntry) {
			return;
		}

		candidateEntry.lastRefreshAt = now;
		candidate.refresh().catch(err => {
			// Model refreshes swallow fetch errors internally; this only guards
			// against unexpected synchronous throws turning into unhandled rejections.
			this._logService.trace(`${LOG_PREFIX} Background refresh failed`, err);
		});
	}
}
