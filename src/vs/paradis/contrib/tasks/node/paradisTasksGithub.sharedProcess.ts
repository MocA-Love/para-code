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
	IParadisTasksError,
	IParadisTasksItem,
	IParadisTasksRateLimit,
	IParadisTasksSearchRequest,
	PARADIS_TASKS_GITHUB_CHANNEL,
	PARADIS_TASKS_MAX_REPOSITORIES,
	PARADIS_TASKS_PAGE_SIZE,
	paradisTasksBuildSearchQuery,
	paradisTasksIsRepositoryName,
	ParadisTasksResponse,
	ParadisTasksSearchResponse,
} from '../common/paradisTasks.js';
import {
	IParadisTasksFieldValue,
	IParadisTasksGithubService,
	IParadisTasksProject,
	IParadisTasksProjectField,
	IParadisTasksProjectItem,
	IParadisTasksProjectItemsRequest,
	IParadisTasksProjectItemsResult,
	IParadisTasksProjectsRequest,
	IParadisTasksProjectsResult,
	IParadisTasksProjectView,
	PARADIS_TASKS_PROJECT_PAGE_SIZE,
	paradisTasksProjectItemsQuery,
	ParadisTasksViewLayout,
} from '../common/paradisTasksProjects.js';

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
/** 同じ要求に同じ応答を返す時間。Orca の一覧のキャッシュ（60 秒）に揃える。 */
export const PARADIS_TASKS_CACHE_TTL_MS = 60_000;
/** プロジェクトとビューの一覧を使い回す時間。めったに変わらないので長めにする（更新ボタンで読み直せる）。 */
export const PARADIS_TASKS_PROJECTS_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 50;
/** GitHub API 利用状況の画面に出す呼び出し元の名前。 */
const SEARCH_CALL_SITE = 'gh api graphql (tasks search)';
const PROJECTS_CALL_SITE = 'gh api graphql (tasks projects)';
const PROJECT_ITEMS_CALL_SITE = 'gh api graphql (tasks project items)';
/** ユーザー・組織の login。 */
const OWNER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** 1 つの持ち主・リポジトリから読むプロジェクトの数。 */
const PROJECTS_PER_OWNER = 20;

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
interface IGqlRateLimit { readonly limit?: number; readonly remaining?: number; readonly resetAt?: string }
interface IGqlEnvelope<TData> {
	readonly data?: TData & { readonly rateLimit?: IGqlRateLimit };
	readonly errors?: readonly { readonly type?: string; readonly message?: string }[];
}
interface IGqlSearchData {
	readonly search?: { readonly issueCount?: number; readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null }; readonly nodes?: readonly (IGqlNode | null)[] };
}

const PROJECT_FRAGMENT = `fragment ParadisProject on ProjectV2 { number title url closed owner { ... on Organization { login } ... on User { login } }
	views(first: 30) { nodes { number name layout filter } } }`;

/**
 * プロジェクトの一覧の問い合わせ。自分のプロジェクトと、リポジトリごとに「つながったプロジェクト」と「持ち主（組織・ユーザー）の
 * プロジェクト」を 1 回で読む（別名 r0, r1, ...）。リポジトリの名前は {@link paradisTasksIsRepositoryName} を通したものだけを埋める。
 */
export function paradisTasksProjectsQuery(repositories: readonly string[]): string {
	const order = `orderBy: { field: UPDATED_AT, direction: DESC }`;
	const parts = repositories.filter(paradisTasksIsRepositoryName).map((repository, index) => {
		const [owner, name] = repository.split('/');
		return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
		projectsV2(first: ${PROJECTS_PER_OWNER}, ${order}) { nodes { ...ParadisProject } }
		owner { ... on ProjectV2Owner { projectsV2(first: ${PROJECTS_PER_OWNER}, ${order}) { nodes { ...ParadisProject } } } } }`;
	});
	return `query {
	viewer { projectsV2(first: ${PROJECTS_PER_OWNER}, ${order}) { nodes { ...ParadisProject } } }
	${parts.join('\n\t')}
	rateLimit { limit remaining resetAt }
}
${PROJECT_FRAGMENT}`;
}

interface IGqlProjectNode {
	readonly number?: number;
	readonly title?: string;
	readonly url?: string;
	readonly closed?: boolean;
	readonly owner?: { readonly login?: string };
	readonly views?: { readonly nodes?: readonly ({ readonly number?: number; readonly name?: string; readonly layout?: string; readonly filter?: string | null } | null)[] };
}
interface IGqlProjectList { readonly projectsV2?: { readonly nodes?: readonly (IGqlProjectNode | null)[] } | null }
type IGqlProjectsData = { readonly viewer?: IGqlProjectList } & { readonly [alias: string]: (IGqlProjectList & { readonly owner?: IGqlProjectList | null }) | null | undefined };

function layoutOf(value: string | undefined): ParadisTasksViewLayout {
	return value === 'BOARD_LAYOUT' || value === 'ROADMAP_LAYOUT' ? value : 'TABLE_LAYOUT';
}

/** プロジェクトの一覧の応答を、重ねずに（持ち主と番号で 1 つ）並べる。リポジトリにつながったものを先に、閉じたものは後ろに置く。 */
export function paradisTasksProjectsFromData(data: IGqlProjectsData, repositoryCount: number): IParadisTasksProject[] {
	const lists: (IGqlProjectList | null | undefined)[] = [];
	for (let index = 0; index < repositoryCount; index++) {
		lists.push(data[`r${index}`]);
	}
	for (let index = 0; index < repositoryCount; index++) {
		lists.push(data[`r${index}`]?.owner);
	}
	lists.push(data.viewer);
	const seen = new Set<string>();
	const projects: IParadisTasksProject[] = [];
	for (const node of lists.flatMap(list => list?.projectsV2?.nodes ?? [])) {
		const owner = node?.owner?.login;
		if (!node || !owner || typeof node.number !== 'number' || typeof node.title !== 'string') {
			continue;
		}
		const key = `${owner.toLowerCase()}#${node.number}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const views: IParadisTasksProjectView[] = (node.views?.nodes ?? []).flatMap(view => view && typeof view.number === 'number' && typeof view.name === 'string'
			? [{ number: view.number, name: view.name, layout: layoutOf(view.layout), filter: view.filter ?? undefined }]
			: []);
		projects.push({ owner, number: node.number, title: node.title, url: node.url ?? '', closed: node.closed === true, views });
	}
	return [...projects.filter(project => !project.closed), ...projects.filter(project => project.closed)];
}

const PROJECT_ITEMS_QUERY = `query($owner: String!, $number: Int!, $view: Int!, $n: Int!, $q: String, $after: String) {
	repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
		title url
		view(number: $view) { number name layout filter
			fields(first: 30) { nodes { ... on ProjectV2FieldCommon { name dataType } ... on ProjectV2SingleSelectField { options { name color } } } }
			verticalGroupByFields(first: 1) { nodes { ... on ProjectV2FieldCommon { name } } }
			groupByFields(first: 1) { nodes { ... on ProjectV2FieldCommon { name } } }
		}
		items(first: $n, after: $after, query: $q) { totalCount pageInfo { hasNextPage endCursor } nodes { id isArchived
			content { __typename
				... on Issue { number title url state stateReason updatedAt repository { nameWithOwner } assignees(first: 5) { nodes { login avatarUrl(size: 40) } } labels(first: 6) { nodes { name color } } }
				... on PullRequest { number title url state isDraft updatedAt repository { nameWithOwner } assignees(first: 5) { nodes { login avatarUrl(size: 40) } } labels(first: 6) { nodes { name color } } }
				... on DraftIssue { title updatedAt assignees(first: 5) { nodes { login avatarUrl(size: 40) } } }
			}
			fieldValues(first: 20) { nodes { __typename
				... on ProjectV2ItemFieldSingleSelectValue { name color field { ... on ProjectV2FieldCommon { name } } }
				... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
				... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
				... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
				... on ProjectV2ItemFieldIterationValue { title startDate duration field { ... on ProjectV2FieldCommon { name } } }
				... on ProjectV2ItemFieldMilestoneValue { milestone { title } field { ... on ProjectV2FieldCommon { name } } }
				... on ProjectV2ItemFieldPullRequestValue { pullRequests(first: 3) { nodes { number } } field { ... on ProjectV2FieldCommon { name } } }
			} }
		} }
	} } }
	rateLimit { limit remaining resetAt }
}`;

interface IGqlFieldValue {
	readonly __typename?: string;
	readonly name?: string;
	readonly color?: string;
	readonly text?: string;
	readonly number?: number;
	readonly date?: string;
	readonly title?: string;
	readonly startDate?: string;
	readonly duration?: number;
	readonly milestone?: { readonly title?: string } | null;
	readonly pullRequests?: { readonly nodes?: readonly ({ readonly number?: number } | null)[] };
	readonly field?: { readonly name?: string };
}
interface IGqlProjectItem {
	readonly id?: string;
	readonly isArchived?: boolean;
	readonly content?: (IGqlNode & { readonly __typename?: string }) | null;
	readonly fieldValues?: { readonly nodes?: readonly (IGqlFieldValue | null)[] };
}
interface IGqlProjectV2 {
	readonly title?: string;
	readonly url?: string;
	readonly view?: {
		readonly number?: number; readonly name?: string; readonly layout?: string; readonly filter?: string | null;
		readonly fields?: { readonly nodes?: readonly ({ readonly name?: string; readonly dataType?: string; readonly options?: readonly { readonly name?: string; readonly color?: string }[] } | null)[] };
		readonly verticalGroupByFields?: { readonly nodes?: readonly ({ readonly name?: string } | null)[] };
		readonly groupByFields?: { readonly nodes?: readonly ({ readonly name?: string } | null)[] };
	} | null;
	readonly items?: { readonly totalCount?: number; readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null }; readonly nodes?: readonly (IGqlProjectItem | null)[] };
}
interface IGqlProjectItemsData {
	readonly repositoryOwner?: { readonly projectV2?: IGqlProjectV2 | null } | null;
}

/** 欄の値を画面に出す形にする。読めない種類は undefined。 */
function fieldValueOf(value: IGqlFieldValue): IParadisTasksFieldValue | undefined {
	switch (value.__typename) {
		case 'ProjectV2ItemFieldSingleSelectValue':
			return value.name ? { text: value.name, color: value.color } : undefined;
		case 'ProjectV2ItemFieldTextValue':
			return value.text ? { text: value.text } : undefined;
		case 'ProjectV2ItemFieldNumberValue':
			return typeof value.number === 'number' ? { text: String(value.number) } : undefined;
		case 'ProjectV2ItemFieldDateValue':
			return value.date ? { text: value.date, date: value.date } : undefined;
		case 'ProjectV2ItemFieldIterationValue':
			return value.title ? { text: value.title, startDate: value.startDate, duration: value.duration } : undefined;
		case 'ProjectV2ItemFieldMilestoneValue':
			return value.milestone?.title ? { text: value.milestone.title } : undefined;
		case 'ProjectV2ItemFieldPullRequestValue': {
			const numbers = (value.pullRequests?.nodes ?? []).flatMap(pr => typeof pr?.number === 'number' ? [`#${pr.number}`] : []);
			return numbers.length > 0 ? { text: numbers.join(' ') } : undefined;
		}
		default:
			return undefined;
	}
}

/** プロジェクトの項目の応答を、画面の形にする。プロジェクトかビューが無ければ undefined。 */
export function paradisTasksProjectItemsFromData(data: IGqlProjectItemsData, viewNumber: number): Omit<IParadisTasksProjectItemsResult, 'fetchedAt' | 'rateLimit'> | undefined {
	const project = data.repositoryOwner?.projectV2;
	const view = project?.view;
	if (!project || !view) {
		return undefined;
	}
	const fields: IParadisTasksProjectField[] = (view.fields?.nodes ?? []).flatMap(field => field?.name && field.dataType
		? [{ name: field.name, dataType: field.dataType, options: field.options?.flatMap(option => option.name ? [{ name: option.name, color: option.color }] : []) }]
		: []);
	const items: IParadisTasksProjectItem[] = [];
	for (const node of project.items?.nodes ?? []) {
		if (!node?.id || node.isArchived) {
			continue;
		}
		const values: { [field: string]: IParadisTasksFieldValue } = {};
		for (const value of node.fieldValues?.nodes ?? []) {
			const name = value?.field?.name;
			const converted = value && name ? fieldValueOf(value) : undefined;
			if (name && converted) {
				values[name] = converted;
			}
		}
		const content = node.content;
		const typename = content?.__typename;
		const base = typename === 'Issue' || typename === 'PullRequest' ? paradisTasksItemFromNode(content) : undefined;
		if (base) {
			items.push({ id: node.id, kind: base.kind, number: base.number, title: base.title, url: base.url, repository: base.repository, state: base.state, stateReason: base.stateReason, isDraft: base.isDraft, assignees: base.assignees, labels: base.labels, updatedAt: base.updatedAt, values });
		} else if (typename === 'DraftIssue' && typeof content?.title === 'string') {
			const assignees = (content.assignees?.nodes ?? []).flatMap(user => user?.login ? [{ login: user.login, avatarUrl: user.avatarUrl }] : []);
			items.push({ id: node.id, kind: 'draft', title: content.title, assignees, labels: [], updatedAt: content.updatedAt, values });
		}
	}
	const columnField = view.verticalGroupByFields?.nodes?.[0]?.name ?? view.groupByFields?.nodes?.[0]?.name ?? undefined;
	return {
		title: project.title ?? '',
		url: project.url ?? '',
		view: { number: view.number ?? viewNumber, name: view.name ?? '', layout: layoutOf(view.layout), filter: view.filter ?? undefined },
		fields,
		columnField,
		items,
		total: project.items?.totalCount ?? items.length,
		endCursor: project.items?.pageInfo?.endCursor ?? undefined,
		hasNextPage: project.items?.pageInfo?.hasNextPage === true,
	};
}

/** `owner/name` の並びを、形を確かめて重ねずに（大文字小文字を区別せず）上限まで並べる。並びは鍵が揃うよう整える。 */
function paradisTasksNormalizeRepositories(repositories: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const repository of [...repositories].filter(paradisTasksIsRepositoryName).sort()) {
		if (!seen.has(repository.toLowerCase())) {
			seen.add(repository.toLowerCase());
			result.push(repository);
		}
	}
	return result.slice(0, PARADIS_TASKS_MAX_REPOSITORIES);
}

interface IGhOutput {
	readonly stdout: string;
	readonly stderr: string;
	readonly failed: boolean;
	readonly notFound: boolean;
	/** 時間切れで止めた（{@link GH_TIMEOUT_MS}）。 */
	readonly timedOut?: boolean;
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
	readonly ttl: number;
	readonly value: unknown;
}

/** GraphQL を 1 回投げた結果。`data` は応答の `data` をそのまま（形は呼び出し側が確かめる）。 */
type GraphqlResponse<TData> =
	| {
		readonly ok: true;
		readonly data: TData;
		readonly rateLimit?: IParadisTasksRateLimit;
		/** 応答に errors があった（data は一部だけのことがある）。呼び出し側が data が足りるかを見て、足りなければこれで失敗にする。 */
		readonly partialError?: IParadisTasksError;
	}
	| { readonly ok: false; readonly error: IParadisTasksError };

export class ParadisTasksGithubService extends Disposable implements IParadisTasksGithubService {

	private readonly cache = new Map<string, ICacheEntry>();
	private readonly inFlight = new Map<string, Promise<unknown>>();

	constructor(
		private readonly runGh: ParadisTasksGhRunner,
		private readonly logService: ILogService,
		private readonly rateLimitPause: ParadisGithubRateLimitPause = paradisGithubRateLimitPause(),
		private readonly now: () => number = Date.now,
	) {
		super();
	}

	async search(request: IParadisTasksSearchRequest): Promise<ParadisTasksSearchResponse> {
		const repositories = paradisTasksNormalizeRepositories(request.repositories);
		if (repositories.length === 0) {
			return { ok: true, result: { items: [], total: 0, hasNextPage: false, fetchedAt: this.now() } };
		}
		const mode = request.mode === 'pr' ? 'pr' : 'issue';
		const query = paradisTasksBuildSearchQuery(mode, typeof request.query === 'string' ? request.query : '', repositories);
		const after = typeof request.after === 'string' && request.after.length > 0 ? request.after : undefined;
		return this.cached(JSON.stringify(['search', query, after ?? '']), PARADIS_TASKS_CACHE_TTL_MS, request.force === true, async (): Promise<ParadisTasksSearchResponse> => {
			const response = await this.graphql<IGqlSearchData>(SEARCH_CALL_SITE, SEARCH_QUERY, { q: query, n: PARADIS_TASKS_PAGE_SIZE, after });
			if (!response.ok) {
				return response;
			}
			// Issue・PR の検索は errors があれば（gh が失敗を返せば）失敗にする（一部だけの結果を正しい一覧に見せない）
			const search = response.data.search;
			if (response.partialError || !search) {
				return { ok: false, error: response.partialError ?? { kind: 'failed', message: 'GitHub returned no result' } };
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
					rateLimit: response.rateLimit,
				},
			};
		});
	}

	async listProjects(request: IParadisTasksProjectsRequest): Promise<ParadisTasksResponse<IParadisTasksProjectsResult>> {
		const repositories = paradisTasksNormalizeRepositories(request.repositories);
		return this.cached(JSON.stringify(['projects', repositories]), PARADIS_TASKS_PROJECTS_CACHE_TTL_MS, request.force === true, async (): Promise<ParadisTasksResponse<IParadisTasksProjectsResult>> => {
			const response = await this.graphql<IGqlProjectsData>(PROJECTS_CALL_SITE, paradisTasksProjectsQuery(repositories), {});
			if (!response.ok) {
				return response;
			}
			const projects = paradisTasksProjectsFromData(response.data, repositories.length);
			// 一部の持ち主（権限の無い組織など）が読めなくても、読めた分は出す。1 つも読めずに errors があるときだけ失敗にする
			if (projects.length === 0 && response.partialError) {
				return { ok: false, error: response.partialError };
			}
			return { ok: true, result: { projects, fetchedAt: this.now(), rateLimit: response.rateLimit } };
		});
	}

	async projectItems(request: IParadisTasksProjectItemsRequest): Promise<ParadisTasksResponse<IParadisTasksProjectItemsResult>> {
		if (!OWNER_LOGIN.test(request.owner) || !(request.number > 0) || !(request.view > 0)) {
			return { ok: false, error: { kind: 'failed', message: 'invalid project' } };
		}
		const after = typeof request.after === 'string' && request.after.length > 0 ? request.after : undefined;
		const viewFilter = typeof request.viewFilter === 'string' ? request.viewFilter : undefined;
		const query = paradisTasksProjectItemsQuery(viewFilter, request.query);
		const key = JSON.stringify(['items', request.owner, request.number, request.view, query ?? '', after ?? '']);
		return this.cached(key, PARADIS_TASKS_CACHE_TTL_MS, request.force === true, async (): Promise<ParadisTasksResponse<IParadisTasksProjectItemsResult>> => {
			const response = await this.graphql<IGqlProjectItemsData>(PROJECT_ITEMS_CALL_SITE, PROJECT_ITEMS_QUERY, {
				owner: request.owner, number: request.number, view: request.view, n: PARADIS_TASKS_PROJECT_PAGE_SIZE, q: query, after,
			});
			if (!response.ok) {
				return response;
			}
			const result = paradisTasksProjectItemsFromData(response.data, request.view);
			if (!result) {
				return { ok: false, error: response.partialError ?? { kind: 'failed', message: 'GitHub returned no project or view' } };
			}
			// プロジェクトとビューが読めても、項目が読めなかったなら失敗にする（空のボードに見せない）
			if (response.partialError && result.items.length === 0) {
				return { ok: false, error: response.partialError };
			}
			return { ok: true, result: { ...result, fetchedAt: this.now(), rateLimit: response.rateLimit } };
		});
	}

	/**
	 * 同じ鍵の要求は相乗りし、`ttl` の間は同じ応答を返す（失敗は覚えない）。`force` はキャッシュを使わない
	 * （飛んでいる要求には相乗りする）。
	 */
	private async cached<T extends { readonly ok: boolean }>(key: string, ttl: number, force: boolean, produce: () => Promise<T>): Promise<T> {
		const entry = this.cache.get(key);
		if (!force && entry && this.now() - entry.at < entry.ttl) {
			return entry.value as T;
		}
		const running = this.inFlight.get(key);
		if (running) {
			return running as Promise<T>;
		}
		const promise = produce().then(value => {
			if (value.ok) {
				this.cache.delete(key);
				this.cache.set(key, { at: this.now(), ttl, value });
				while (this.cache.size > CACHE_MAX_ENTRIES) {
					const oldest = this.cache.keys().next().value;
					if (oldest === undefined) {
						break;
					}
					this.cache.delete(oldest);
				}
			}
			return value;
		}).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, promise);
		return promise;
	}

	/**
	 * `gh api graphql` を 1 回起動する。上限で止めている間は起動しない。呼び出しは GitHub API 利用状況に数え、
	 * 応答の rateLimit は worktree の gh と同じ台帳へ渡す。
	 */
	private async graphql<TData>(callSite: string, query: string, variables: { readonly [name: string]: string | number | undefined }): Promise<GraphqlResponse<TData>> {
		const pausedUntil = this.rateLimitPause.pausedUntilFor('', 'graphql');
		if (pausedUntil !== undefined) {
			return { ok: false, error: { kind: 'rate-limited', message: 'GitHub API rate limit', retryAt: pausedUntil } };
		}
		const args = ['api', 'graphql', '-f', `query=${query}`];
		for (const [name, value] of Object.entries(variables)) {
			if (typeof value === 'number') {
				args.push('-F', `${name}=${value}`);
			} else if (typeof value === 'string') {
				args.push('-f', `${name}=${value}`);
			}
		}
		const startedAt = this.now();
		let output: IGhOutput;
		try {
			output = await this.runGh(args);
		} catch (error) {
			const message = paradisTruncateGithubErrorMessage(error instanceof Error ? error.message : String(error));
			this.record(callSite, startedAt, false, false, message);
			return { ok: false, error: { kind: 'failed', message } };
		}
		if (output.notFound) {
			return { ok: false, error: { kind: 'no-gh', message: 'gh is not installed' } };
		}
		if (output.timedOut) {
			const message = `gh did not answer within ${GH_TIMEOUT_MS / 1000} seconds`;
			this.record(callSite, startedAt, false, false, message);
			return { ok: false, error: { kind: 'timeout', message } };
		}

		let parsed: IGqlEnvelope<TData> | undefined;
		try {
			parsed = output.stdout.trim() ? JSON.parse(output.stdout) as IGqlEnvelope<TData> : undefined;
		} catch {
			parsed = undefined;
		}
		const rateLimit = this.readRateLimit(parsed?.data?.rateLimit);
		const errorText = [output.stderr, ...(parsed?.errors ?? []).map(error => `${error.type ?? ''} ${error.message ?? ''}`)].join('\n').trim();
		// gh の project のスコープが無い。data があっても肝心の部分が空なので、専用の案内にする
		if ((parsed?.errors ?? []).some(error => error.type === 'INSUFFICIENT_SCOPES') || /INSUFFICIENT_SCOPES|read:project/.test(output.stderr)) {
			const message = paradisTruncateGithubErrorMessage(errorText);
			this.record(callSite, startedAt, false, false, message);
			return { ok: false, error: { kind: 'scope', message } };
		}
		if (!parsed?.data) {
			const rateLimited = paradisIsGithubRateLimitMessage(errorText) || rateLimit?.remaining === 0;
			const message = paradisTruncateGithubErrorMessage(errorText || 'GitHub returned no result');
			this.record(callSite, startedAt, false, rateLimited, message);
			if (rateLimited) {
				const retryAt = this.rateLimitPause.noteRateLimited('', 'graphql');
				return { ok: false, error: { kind: 'rate-limited', message, retryAt } };
			}
			const auth = /gh auth login|authentication|401|bad credentials/i.test(errorText);
			this.logService.trace(`[ParadisTasks] ${callSite} failed: ${message}`);
			return { ok: false, error: { kind: auth ? 'auth' : 'failed', message } };
		}
		// errors があっても data は返る（読めない組織のプロジェクト、見つからないビューなど）。足りるかは呼び出し側が決める
		const partial = output.failed || (parsed.errors?.length ?? 0) > 0;
		const partialMessage = partial ? paradisTruncateGithubErrorMessage(errorText || 'GitHub returned errors') : undefined;
		this.record(callSite, startedAt, !partial, false, partialMessage);
		if (rateLimit) {
			this.rateLimitPause.noteRateLimits([{ resource: 'graphql', limit: rateLimit.limit, used: rateLimit.limit - rateLimit.remaining, remaining: rateLimit.remaining, resetAt: rateLimit.resetAt }]);
		}
		return { ok: true, data: parsed.data, rateLimit, partialError: partialMessage ? { kind: 'failed', message: partialMessage } : undefined };
	}

	private readRateLimit(value: IGqlRateLimit | undefined): IParadisTasksRateLimit | undefined {
		const resetAt = value?.resetAt ? Date.parse(value.resetAt) : NaN;
		if (typeof value?.limit !== 'number' || typeof value.remaining !== 'number' || isNaN(resetAt)) {
			return undefined;
		}
		return { limit: value.limit, remaining: value.remaining, resetAt };
	}

	private record(callSite: string, startedAt: number, success: boolean, rateLimited: boolean, errorMessage: string | undefined): void {
		paradisRecordGithubCall({ at: this.now(), callSite, resource: 'graphql', durationMs: this.now() - startedAt, success, rateLimited, errorMessage });
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
				// execFile の timeout で止めたときは killed が立つ（SIGKILL）
				const timedOut = Boolean(err && (err as { killed?: boolean }).killed);
				resolve({ stdout: stdout ?? '', stderr: stderr ?? (err?.message ?? ''), failed: Boolean(err), notFound, timedOut });
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
			// ProxyChannel.toService は引数を配列で送る
			case 'search':
				return this.service.search(paradisTasksCoerceSearchRequest(Array.isArray(arg) ? arg[0] : arg)) as Promise<T>;
			case 'listProjects':
				return this.service.listProjects(paradisTasksCoerceProjectsRequest(Array.isArray(arg) ? arg[0] : arg)) as Promise<T>;
			case 'projectItems':
				return this.service.projectItems(paradisTasksCoerceProjectItemsRequest(Array.isArray(arg) ? arg[0] : arg)) as Promise<T>;
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

export function paradisTasksCoerceProjectsRequest(value: unknown): IParadisTasksProjectsRequest {
	const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
	return {
		repositories: Array.isArray(raw.repositories) ? raw.repositories.filter((repo): repo is string => typeof repo === 'string') : [],
		force: raw.force === true,
	};
}

export function paradisTasksCoerceProjectItemsRequest(value: unknown): IParadisTasksProjectItemsRequest {
	const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
	const integer = (input: unknown) => typeof input === 'number' && Number.isInteger(input) && input > 0 ? input : 0;
	return {
		owner: typeof raw.owner === 'string' ? raw.owner : '',
		number: integer(raw.number),
		view: integer(raw.view),
		viewFilter: typeof raw.viewFilter === 'string' ? raw.viewFilter.slice(0, 512) : undefined,
		query: typeof raw.query === 'string' ? raw.query.slice(0, 512) : undefined,
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
