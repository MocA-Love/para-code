/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../base/common/observable.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISessionGithubRefreshable } from './sessionGithubBackgroundPolling.js';

const LOG_PREFIX = '[SessionGithubReviewThreadsRefresh]';

/** How long review threads may stay stale when the pull request looks unchanged. */
const DEFAULT_FALLBACK_INTERVAL_MS = 600_000; // 10 min

export interface ISessionGithubReviewThreadsRefreshOptions {
	readonly fallbackIntervalMs?: number;
	/** Clock, injectable for tests. */
	readonly now?: () => number;
}

/**
 * Change-driven refresh for a pull request's review threads.
 *
 * Review threads are the only sessions-layer data fetched over GraphQL, and
 * GraphQL bills by query size rather than by request: GitHub scores a query as
 * the product of its connection page sizes divided by 100, against a budget of
 * 5,000 points per hour that is completely separate from the REST budget. A
 * GraphQL request also cannot be made conditional (it is a POST, so ETag /
 * `304 Not Modified` — which REST gets for free — does not apply), so every
 * poll pays full price whether or not anything changed.
 *
 * Polling review threads on their own timer therefore burned quota continuously
 * for data that only changes when a human writes or resolves a comment. Instead
 * this rides along with the pull-request model's REST polling, which is already
 * running and already free while nothing changes:
 *
 * - **Change-driven**: refresh when the pull request's `updatedAt` moves (which
 *   is what happens when a review comment is added), plus once on startup so
 *   the first read populates the model.
 * - **Fallback**: refresh at `fallbackIntervalMs` at the latest, so changes
 *   that leave `updatedAt` untouched — e.g. somebody else resolving a thread —
 *   still land within bounded staleness.
 *
 * The user's own actions are not covered here and do not need to be: posting a
 * reply and resolving a thread both force a refresh on the model directly, so
 * they still reflect immediately.
 */
export function startChangeDrivenReviewThreadsRefresh(
	model: ISessionGithubRefreshable,
	/** Pull request change token — the model's `updatedAt`, or `undefined` before it has data. */
	changeTokenObs: IObservable<string | undefined>,
	logService: ILogService,
	options?: ISessionGithubReviewThreadsRefreshOptions,
): IDisposable {
	const fallbackIntervalMs = options?.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS;
	const now = options?.now ?? Date.now;

	const store = new DisposableStore();

	let lastToken: string | undefined = undefined;
	let lastRefreshAt = 0;

	const refresh = (reason: string): void => {
		lastRefreshAt = now();
		logService.trace(`${LOG_PREFIX} Refreshing review threads (${reason})`);
		model.refresh().catch(err => {
			// Model refreshes swallow fetch errors internally; this only guards
			// against unexpected synchronous throws becoming unhandled rejections.
			logService.trace(`${LOG_PREFIX} Review thread refresh failed`, err);
		});
	};

	store.add(autorun(reader => {
		const token = changeTokenObs.read(reader);
		if (token === undefined || token === lastToken) {
			// No pull request data yet, or nothing moved since the last refresh.
			return;
		}

		lastToken = token;
		refresh('pull request updated');
	}));

	const fallbackTimer = store.add(new IntervalTimer());
	fallbackTimer.cancelAndSet(() => {
		if (now() - lastRefreshAt >= fallbackIntervalMs) {
			refresh('fallback interval');
		}
	}, fallbackIntervalMs);

	return store;
}
