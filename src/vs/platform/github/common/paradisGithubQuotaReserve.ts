/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RateLimitState } from './cooldownState.js';
import { RequestAccount, RequestContext, RequestPriority } from './types.js';

/**
 * Below this share of the quota left, requests the user is not waiting for wait for the reset.
 * Upstream only stops at 0 remaining, so a busy machine (Para Code's sessions plus agents running
 * `gh` with the same token) spends the whole window and then blocks the user's own requests too.
 */
const PARADIS_RESERVE_RATIO: Partial<Record<RequestPriority, number>> = {
	background: 0.25,
	enrichment: 0.25,
	visible: 0.05,
};

/** Reads the last quota GitHub reported for one account and resource. */
export interface IParadisGithubQuotaSource {
	getState(account: RequestAccount, resource: string): RateLimitState | undefined;
}

/**
 * How long a queued request should wait so the remaining quota is kept for interactive work.
 * Used only as an admission delay of the request queue (githubService.ts), never by the check
 * GitHubTransport makes right before sending, so a request that was admitted is not refused.
 */
export function paradisGithubQuotaReserveDelay(quota: IParadisGithubQuotaSource, context: Pick<RequestContext, 'account' | 'resource' | 'priority'>, now: number): number {
	const ratio = PARADIS_RESERVE_RATIO[context.priority];
	if (ratio === undefined) {
		return 0;
	}
	const resource = context.resource === 'graphql' ? 'graphql' : context.resource === 'checks' ? 'core' : context.resource;
	const state = quota.getState(context.account, resource);
	if (state?.limit === undefined || state.remaining === undefined || state.resetAt === undefined || state.limit <= 0) {
		return 0;
	}
	if (state.remaining / state.limit > ratio) {
		return 0;
	}
	return Math.max(0, state.resetAt - now);
}
