/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面の GitHub の取得口（shared process）。手元の gh で GraphQL の検索を 1 回だけ投げる。
// - トークンは gh が持ち、このプロセスにも画面にも出さない（`gh api graphql` を起動するだけ）
// - shared process は全部の窓で 1 つなので、同じ要求は相乗りさせ、60 秒は同じ応答を返す（API の回数を窓の数に比例させない）
// - 定期の取得はしない。読むのは画面を開いたとき・検索を確定したとき・更新ボタンのときだけ
// - 呼び出しは GitHub API 利用状況の画面に数え（paradisRecordGithubCall）、枠を使い切ったら worktree の gh と同じ台帳
//   （paradisGithubRateLimitPause）でリセットまで止める
// 手元の gh を使うのは SSH の窓でも同じ（今のタスクボードと同じ。接続先の gh は使わない）。

import * as cp from 'child_process';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv, ParadisRawShellEnvResolver } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisIsGithubRateLimitMessage, paradisRecordGithubCall, paradisTruncateGithubErrorMessage } from '../../githubMetrics/common/paradisGithubMetrics.js';
import { paradisGithubRateLimitPause, ParadisGithubRateLimitPause } from '../../githubMetrics/common/paradisGithubRateLimitPause.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisTasksGithubService,
	IParadisTasksItem,
	IParadisTasksRateLimit,
	IParadisTasksSearchRequest,
	IParadisTasksSearchResult,
	PARADIS_TASKS_GITHUB_CHANNEL,
	PARADIS_TASKS_MAX_REPOSITORIES,
	PARADIS_TASKS_PAGE_SIZE,
	paradisTasksBuildSearchQuery,
	paradisTasksIsRepositoryName,
	ParadisTasksSearchResponse,
} from '../common/paradisTasks.js';

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
/** 同じ要求に同じ応答を返す時間。Orca の一覧のキャッシュ（60 秒）に揃える。 */
export const PARADIS_TASKS_CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 50;
/** GitHub API 利用状況の画面に出す呼び出し元の名前。 */
const CALL_SITE = 'gh api graphql (tasks search)';

const SEARCH_QUERY = `query($q: String!, $n: Int!, $after: String) {
	search(query: $q, type: ISSUE, first: $n, after: $after) {
		issueCount
		pageInfo { hasNextPage endCursor }
		nodes {
			__typename
			... on Issue { number title url state stateReason updatedAt repository { nameWithOwner } author { login } comments { totalCount }
				assignees(first: 5) { nodes { login avatarUrl(size: 40) } } labels(first: 6) { nodes { name color } } }
			... on PullRequest { number title url state isDraft reviewDecision updatedAt repository { nameWithOwner } author { login } comments { totalCount }
				assignees(first: 5) { nodes { login avatarUrl(size: 40) } } labels(first: 6) { nodes { name color } } }
		}
	}
	rateLimit { limit remaining resetAt }
}`;

interface IGqlUserNodes { readonly nodes?: readonly ({ readonly login?: string; readonly avatarUrl?: string } | null)[] }
interface IGqlLabelNodes { readonly nodes?: readonly ({ readonly name?: string; readonly color?: string } | null)[] }
interface IGqlNode {
	readonly __typename?: string;
	readonly number?: number;
	readonly title?: string;
	readonly url?: string;
	readonly state?: string;
	readonly stateReason?: string | null;
	readonly isDraft?: boolean;
	readonly reviewDecision?: string | null;
	readonly updatedAt?: string;
	readonly repository?: { readonly nameWithOwner?: string };
	readonly author?: { readonly login?: string } | null;
	readonly comments?: { readonly totalCount?: number };
	readonly assignees?: IGqlUserNodes;
	readonly labels?: IGqlLabelNodes;
}
interface IGqlSearchResponse {
	readonly data?: {
		readonly search?: { readonly issueCount?: number; readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null }; readonly nodes?: readonly (IGqlNode | null)[] };
		readonly rateLimit?: { readonly limit?: number; readonly remaining?: number; readonly resetAt?: string };
	};
	readonly errors?: readonly { readonly type?: string; readonly message?: string }[];
}

interface IGhOutput {
	readonly stdout: string;
	readonly stderr: string;
	readonly failed: boolean;
	readonly notFound: boolean;
}

/** gh を起動する口。テストでは差し替える。 */
export type ParadisTasksGhRunner = (args: readonly string[]) => Promise<IGhOutput>;

/** GraphQL の 1 件を一覧の形にする。欠けているものは捨てる（undefined）。 */
export function paradisTasksItemFromNode(node: IGqlNode | null | undefined): IParadisTasksItem | undefined {
	if (!node || (node.__typename !== 'Issue' && node.__typename !== 'PullRequest')) {
		return undefined;
	}
	const repository = node.repository?.nameWithOwner;
	if (typeof node.number !== 'number' || typeof node.title !== 'string' || typeof node.url !== 'string' || typeof repository !== 'string' || typeof node.updatedAt !== 'string') {
		return undefined;
	}
	return {
		kind: node.__typename === 'PullRequest' ? 'pr' : 'issue',
		repository,
		number: node.number,
		title: node.title,
		url: node.url,
		state: node.state ?? 'OPEN',
		stateReason: node.stateReason ?? undefined,
		isDraft: node.isDraft,
		reviewDecision: node.reviewDecision ?? undefined,
		author: node.author?.login,
		assignees: (node.assignees?.nodes ?? []).flatMap(user => user?.login ? [{ login: user.login, avatarUrl: user.avatarUrl }] : []),
		labels: (node.labels?.nodes ?? []).flatMap(label => label?.name ? [{ name: label.name, color: /^[0-9a-f]{6}$/i.test(label.color ?? '') ? label.color! : '888888' }] : []),
		updatedAt: node.updatedAt,
		comments: node.comments?.totalCount,
	};
}

interface ICacheEntry {
	readonly at: number;
	readonly result: IParadisTasksSearchResult;
}

export class ParadisTasksGithubService extends Disposable implements IParadisTasksGithubService {

	private readonly cache = new Map<string, ICacheEntry>();
	private readonly inFlight = new Map<string, Promise<ParadisTasksSearchResponse>>();

	constructor(
		private readonly runGh: ParadisTasksGhRunner,
		private readonly logService: ILogService,
		private readonly rateLimitPause: ParadisGithubRateLimitPause = paradisGithubRateLimitPause(),
		private readonly now: () => number = Date.now,
	) {
		super();
	}

	async search(request: IParadisTasksSearchRequest): Promise<ParadisTasksSearchResponse> {
		const repositories = [...new Set(request.repositories.filter(paradisTasksIsRepositoryName))].sort().slice(0, PARADIS_TASKS_MAX_REPOSITORIES);
		if (repositories.length === 0) {
			return { ok: true, result: { items: [], total: 0, hasNextPage: false, fetchedAt: this.now() } };
		}
		const mode = request.mode === 'pr' ? 'pr' : 'issue';
		const query = paradisTasksBuildSearchQuery(mode, typeof request.query === 'string' ? request.query : '', repositories);
		const after = typeof request.after === 'string' && request.after.length > 0 ? request.after : undefined;
		const key = JSON.stringify([query, after ?? '']);

		const cached = this.cache.get(key);
		if (!request.force && cached && this.now() - cached.at < PARADIS_TASKS_CACHE_TTL_MS) {
			return { ok: true, result: cached.result };
		}
		const running = this.inFlight.get(key);
		if (running) {
			return running;
		}
		const pausedUntil = this.rateLimitPause.pausedUntilFor('', 'graphql');
		if (pausedUntil !== undefined) {
			return { ok: false, error: { kind: 'rate-limited', message: 'GitHub API rate limit', retryAt: pausedUntil } };
		}
		const promise = this.fetch(query, after).then(response => {
			if (response.ok) {
				this.remember(key, response.result);
			}
			return response;
		}).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, promise);
		return promise;
	}

	private remember(key: string, result: IParadisTasksSearchResult): void {
		this.cache.delete(key);
		this.cache.set(key, { at: result.fetchedAt, result });
		while (this.cache.size > CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.cache.delete(oldest);
		}
	}

	private async fetch(query: string, after: string | undefined): Promise<ParadisTasksSearchResponse> {
		const args = ['api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `q=${query}`, '-F', `n=${PARADIS_TASKS_PAGE_SIZE}`];
		if (after) {
			args.push('-f', `after=${after}`);
		}
		const startedAt = this.now();
		let output: IGhOutput;
		try {
			output = await this.runGh(args);
		} catch (error) {
			const message = paradisTruncateGithubErrorMessage(error instanceof Error ? error.message : String(error));
			this.record(startedAt, false, false, message);
			return { ok: false, error: { kind: 'failed', message } };
		}
		if (output.notFound) {
			return { ok: false, error: { kind: 'no-gh', message: 'gh is not installed' } };
		}

		let parsed: IGqlSearchResponse | undefined;
		try {
			parsed = output.stdout.trim() ? JSON.parse(output.stdout) as IGqlSearchResponse : undefined;
		} catch {
			parsed = undefined;
		}
		const rateLimit = this.readRateLimit(parsed);
		const errorText = [output.stderr, ...(parsed?.errors ?? []).map(error => `${error.type ?? ''} ${error.message ?? ''}`)].join('\n').trim();
		const search = parsed?.data?.search;
		if (output.failed || !search) {
			const rateLimited = paradisIsGithubRateLimitMessage(errorText) || rateLimit?.remaining === 0;
			const message = paradisTruncateGithubErrorMessage(errorText || 'GitHub returned no result');
			this.record(startedAt, false, rateLimited, message);
			if (rateLimited) {
				const retryAt = this.rateLimitPause.noteRateLimited('', 'graphql');
				return { ok: false, error: { kind: 'rate-limited', message, retryAt } };
			}
			const auth = /gh auth login|authentication|401|bad credentials/i.test(errorText);
			this.logService.trace(`[ParadisTasks] search failed: ${message}`);
			return { ok: false, error: { kind: auth ? 'auth' : 'failed', message } };
		}
		this.record(startedAt, true, false, undefined);
		if (rateLimit) {
			this.rateLimitPause.noteRateLimits([{ resource: 'graphql', limit: rateLimit.limit, used: rateLimit.limit - rateLimit.remaining, remaining: rateLimit.remaining, resetAt: rateLimit.resetAt }]);
		}
		const items = (search.nodes ?? []).flatMap(node => {
			const item = paradisTasksItemFromNode(node);
			return item ? [item] : [];
		});
		return {
			ok: true,
			result: {
				items,
				total: search.issueCount ?? items.length,
				endCursor: search.pageInfo?.endCursor ?? undefined,
				hasNextPage: search.pageInfo?.hasNextPage === true,
				fetchedAt: this.now(),
				rateLimit,
			},
		};
	}

	private readRateLimit(parsed: IGqlSearchResponse | undefined): IParadisTasksRateLimit | undefined {
		const value = parsed?.data?.rateLimit;
		const resetAt = value?.resetAt ? Date.parse(value.resetAt) : NaN;
		if (typeof value?.limit !== 'number' || typeof value.remaining !== 'number' || isNaN(resetAt)) {
			return undefined;
		}
		return { limit: value.limit, remaining: value.remaining, resetAt };
	}

	private record(startedAt: number, success: boolean, rateLimited: boolean, errorMessage: string | undefined): void {
		paradisRecordGithubCall({ at: this.now(), callSite: CALL_SITE, resource: 'graphql', durationMs: this.now() - startedAt, success, rateLimited, errorMessage });
	}
}

/** gh を手元のログインシェルの env で起動する（worktree の gh・使用量の監視と同じやり方）。 */
function createGhRunner(cachedShellEnv: ParadisCachedShellEnv): ParadisTasksGhRunner {
	return async args => {
		const env = await cachedShellEnv.getEnv();
		return new Promise<IGhOutput>(resolve => {
			cp.execFile('gh', [...args], {
				encoding: 'utf8',
				timeout: GH_TIMEOUT_MS,
				maxBuffer: GH_MAX_BUFFER,
				killSignal: 'SIGKILL',
				windowsHide: true,
				env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
			}, (err, stdout, stderr) => {
				const notFound = (err as { code?: unknown } | null)?.code === 'ENOENT';
				resolve({ stdout: stdout ?? '', stderr: stderr ?? (err?.message ?? ''), failed: Boolean(err), notFound });
			});
		});
	};
}

class ParadisTasksGithubChannel implements IServerChannel<string> {

	constructor(private readonly service: IParadisTasksGithubService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'search':
				// ProxyChannel.toService は引数を配列で送る
				return this.service.search(paradisTasksCoerceSearchRequest(Array.isArray(arg) ? arg[0] : arg)) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/** 窓から届いた値を検索の要求の形に揃える（型が保証されないので、知らない値は空にする）。 */
export function paradisTasksCoerceSearchRequest(value: unknown): IParadisTasksSearchRequest {
	const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
	return {
		mode: raw.mode === 'pr' ? 'pr' : 'issue',
		repositories: Array.isArray(raw.repositories) ? raw.repositories.filter((repo): repo is string => typeof repo === 'string') : [],
		query: typeof raw.query === 'string' ? raw.query.slice(0, 512) : '',
		after: typeof raw.after === 'string' ? raw.after.slice(0, 200) : undefined,
		force: raw.force === true,
	};
}

ParadisSharedProcessContributions.register(PARADIS_TASKS_GITHUB_CHANNEL, ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const shellEnvResolver: ParadisRawShellEnvResolver = createParadisShellEnvResolver(logService, configurationService, environmentService.args);
	const cachedShellEnv = new ParadisCachedShellEnv(logService, 'ParadisTasks', shellEnvResolver, Date.now, reportParadisShellEnvDiagnosticError);
	const service = new ParadisTasksGithubService(createGhRunner(cachedShellEnv), logService);
	server.registerChannel(PARADIS_TASKS_GITHUB_CHANNEL, new ParadisTasksGithubChannel(service));
	return service;
});
