/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService, asJson } from '../../../../platform/request/common/request.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';

const LOG_PREFIX = '[GitHubApiClient]';
const TRACE_PREFIX = '[PR-ICON-TRACE]';
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_GRAPHQL_ENDPOINT = `${GITHUB_API_BASE}/graphql`;

export interface IGitHubApiRequestOptions {
	readonly data?: unknown;
	readonly etag?: string;
}

export interface IGitHubApiResponse<T> {
	readonly data: T | undefined;
	readonly statusCode: number;
	readonly etag?: string;
}

interface IGitHubGraphQLError {
	readonly message: string;
}

interface IGitHubGraphQLResponse<T> {
	readonly data?: T;
	readonly errors?: readonly IGitHubGraphQLError[];
}

// PARA-PATCH: GitHub meters REST and GraphQL against completely separate budgets
// (and GraphQL bills by query size, not by request), so consumers that want to
// stay under the limits have to track them apart. See sessionGithubRequestGate.ts.
export type GitHubApiResource = 'rest' | 'graphql';

/** PARA-PATCH: one `x-ratelimit-*` reading, as reported by GitHub. */
export interface IGitHubRateLimitSnapshot {
	readonly resource: GitHubApiResource;
	/** Budget for the current window — requests for REST, points for GraphQL. */
	readonly limit: number | undefined;
	readonly remaining: number | undefined;
	/** When the current window resets, in epoch milliseconds. */
	readonly resetAtMs: number | undefined;
}

export class GitHubApiError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		readonly rateLimitRemaining: number | undefined,
	) {
		super(message);
		this.name = 'GitHubApiError';
	}
}

/**
 * Low-level GitHub REST API client. Handles authentication,
 * request construction, and error classification.
 *
 * This class is stateless with respect to domain data — it only
 * manages auth tokens and raw HTTP communication.
 */
export class GitHubApiClient extends Disposable {

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async request<T>(method: string, path: string, callSite: string, options?: IGitHubApiRequestOptions): Promise<IGitHubApiResponse<T>> {
		return this._request<T>(method, `${GITHUB_API_BASE}${path}`, path, 'application/vnd.github.v3+json', callSite, options);
	}

	async graphql<T>(query: string, callSite: string, variables?: Record<string, unknown>): Promise<T> {
		const response = await this._request<IGitHubGraphQLResponse<T>>(
			'POST',
			GITHUB_GRAPHQL_ENDPOINT,
			'/graphql',
			'application/vnd.github+json',
			callSite,
			{ data: { query, variables } }
		);

		if (response.data?.errors?.length) {
			throw new GitHubApiError(
				response.data.errors.map(error => error.message).join('; '),
				200,
				undefined,
			);
		}

		if (!response.data?.data) {
			throw new GitHubApiError('GitHub GraphQL response did not include data', 200, undefined);
		}

		return response.data.data;
	}

	private async _request<T>(method: string, url: string, pathForLogging: string, accept: string, callSite: string, options?: IGitHubApiRequestOptions): Promise<IGitHubApiResponse<T>> {
		const token = await this._getAuthToken();

		this._logService.trace(`${LOG_PREFIX} ${method} ${pathForLogging}`);
		this._logService.trace(`${TRACE_PREFIX} [GitHubApiClient] -> ${method} ${pathForLogging} (callSite ${callSite}${options?.etag !== undefined ? `, ifNoneMatch ${options.etag}` : ''})`);

		const response = await this._requestService.request({
			type: method,
			url,
			headers: {
				'Authorization': `token ${token}`,
				'Accept': accept,
				'User-Agent': 'VSCode-Sessions-GitHub',
				...(options?.etag !== undefined ? { 'If-None-Match': options.etag } : {}),
				...(options?.data !== undefined ? { 'Content-Type': 'application/json' } : {}),
			},
			data: options?.data !== undefined ? JSON.stringify(options.data) : undefined,
			// Bypass the renderer HTTP cache so conditional polling reaches GitHub (see PR_ICON_POLLING.md).
			disableCache: true,
			callSite
		}, CancellationToken.None);

		const rateLimitRemaining = parseRateLimitHeader(response.res.headers?.['x-ratelimit-remaining']);
		if (rateLimitRemaining !== undefined && rateLimitRemaining < 100) {
			this._logService.warn(`${LOG_PREFIX} GitHub API rate limit low: ${rateLimitRemaining} remaining`);
		}

		// PARA-PATCH: hand the full rate-limit reading to subclasses. GitHub's own
		// guidance is to read these headers rather than to query the budget, and they
		// are the only way to tell the REST and GraphQL windows apart (GraphQL is
		// billed in points, so a request count says nothing about what is left).
		this._onRateLimitSnapshot({
			resource: parseRateLimitResourceHeader(response.res.headers?.['x-ratelimit-resource'], url === GITHUB_GRAPHQL_ENDPOINT),
			limit: parseRateLimitHeader(response.res.headers?.['x-ratelimit-limit']),
			remaining: rateLimitRemaining,
			resetAtMs: parseRateLimitResetHeader(response.res.headers?.['x-ratelimit-reset']),
		});

		const statusCode = response.res.statusCode ?? 0;
		const responseETag = response.res.headers?.['etag'];

		this._logService.trace(`${TRACE_PREFIX} [GitHubApiClient] <- ${method} ${pathForLogging} status ${statusCode}${responseETag ? `, etag ${responseETag}` : ''}${rateLimitRemaining !== undefined ? `, rateLimitRemaining ${rateLimitRemaining}` : ''} (callSite ${callSite})`);

		if (
			statusCode === 204 /* No Content */ ||
			statusCode === 304 /* Not Modified */
		) {
			return { data: undefined, statusCode, etag: responseETag };
		}

		if (statusCode < 200 || statusCode >= 300) {
			const errorBody = await asJson<{ message?: string }>(response).catch(() => undefined);
			throw new GitHubApiError(
				errorBody?.message ?? `GitHub API request failed: ${method} ${pathForLogging} (${statusCode})`,
				statusCode,
				rateLimitRemaining,
			);
		}

		const data = await asJson<T>(response);
		if (!data) {
			throw new GitHubApiError(
				`Failed to parse response for ${method} ${pathForLogging}`,
				statusCode,
				rateLimitRemaining,
			);
		}

		return { data, statusCode, etag: responseETag };
	}

	/**
	 * PARA-PATCH: called for every response that carried rate-limit headers.
	 * No-op here; {@link SessionGithubGatedApiClient} uses it to keep the shared
	 * request gate's per-resource budgets in sync with GitHub's own accounting.
	 */
	protected _onRateLimitSnapshot(_snapshot: IGitHubRateLimitSnapshot): void { }

	private async _getAuthToken(): Promise<string> {
		let sessions = await this._authenticationService.getSessions('github', [], { silent: true });
		if (!sessions || sessions.length === 0) {
			sessions = await this._authenticationService.getSessions('github', [], { createIfNone: true });
		}
		if (!sessions || sessions.length === 0) {
			throw new Error('No GitHub authentication sessions available');
		}

		// Prefer a session with 'repo' scope, but fall back to the first available session
		const repoScopeSession = sessions.find(session => session.scopes.includes('repo'));
		return repoScopeSession?.accessToken ?? sessions[0].accessToken ?? '';
	}
}

function parseRateLimitHeader(value: string | string[] | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const str = Array.isArray(value) ? value[0] : value;
	const parsed = parseInt(str, 10);
	return isNaN(parsed) ? undefined : parsed;
}

// PARA-PATCH: `x-ratelimit-reset` is a UTC epoch **second**.
function parseRateLimitResetHeader(value: string | string[] | undefined): number | undefined {
	const seconds = parseRateLimitHeader(value);
	return seconds === undefined ? undefined : seconds * 1000;
}

// PARA-PATCH: `x-ratelimit-resource` names the bucket the response was billed to
// ('core', 'graphql', 'search', ...). Fall back to the endpoint when it is absent.
function parseRateLimitResourceHeader(value: string | string[] | undefined, isGraphQLEndpoint: boolean): GitHubApiResource {
	const str = Array.isArray(value) ? value[0] : value;
	if (str === 'graphql') {
		return 'graphql';
	}
	if (str !== undefined) {
		return 'rest';
	}
	return isGraphQLEndpoint ? 'graphql' : 'rest';
}
