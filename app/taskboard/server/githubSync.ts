// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type {
	ITaskBoardCheck,
	ITaskBoardComment,
	ITaskBoardProjectField,
	ITaskBoardProjectOption,
	ITaskBoardProjectOptionInput,
	TaskBoardProjectColor,
	ITaskBoardFlow,
	ITaskBoardGitHubState,
	ITaskBoardIssueDetail,
	ITaskBoardIssueEvent,
	ITaskBoardPrRef,
	ITaskBoardPullDetail,
	ITaskBoardTask,
	TaskBoardCheckState,
	TaskBoardIssueEventKind,
	TaskBoardPrState,
} from '@engine/paradisTaskBoard.js';
import { TASK_BOARD_DONE, TASK_BOARD_TODO } from '@engine/paradisTaskBoard.js';
import type { ITaskBoardIntakeItem, TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import { GitHubClient, GitHubError } from './github.js';

/*
 * GitHub との同期（読むだけ。フェーズ 2 では GitHub へ書き込まない）。
 * - 取り込み: 5 分ごと（と「今すぐ同期」）に、担当が自分の未着手を Projects か Issue 検索から読む
 * - PR: Issue を閉じる PR（closedByPullRequestsReferences）をタスクに結び付け、
 *   工程が外部待ち（wait 工程・マージ待ち）のタスクの PR だけを 60 秒ごとに読み直す。ほかの進行中のタスクの PR は取り込みのときに読む
 * - GraphQL が上限で止まっている間は、60 秒ごとの見張りを黙って見送る
 * - 詳細（Issue の本文・経過、PR のチェック・レビュー・ファイル）は画面が開いたときだけ読み、30 秒覚える
 */

const INTAKE_INTERVAL = 5 * 60 * 1000;
const PR_INTERVAL = 60 * 1000;
const DETAIL_TTL = 30 * 1000;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const PR_LITE = `
fragment PrLite on PullRequest {
	number url title state isDraft merged reviewDecision
	repository { owner { login } name }
	latestReviews(first: 10) { nodes { state author { login } } }
	commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { totalCount nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }
}`;

const ISSUE_LITE = `
fragment IssueLite on Issue {
	number title url state
	repository { owner { login } name }
	assignees(first: 10) { nodes { login avatarUrl(size: 48) } }
	labels(first: 20) { nodes { name color } }
	closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { ...PrLite } }
}`;

const RATE = 'rateLimit { remaining limit resetAt cost }';

interface IGqlRate { remaining: number; limit: number; resetAt: string; cost: number }
interface IGqlPrLite {
	number: number; url: string; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; merged: boolean; reviewDecision: string | null;
	repository: { owner: { login: string }; name: string };
	latestReviews: { nodes: { state: string; author: { login: string } | null }[] };
	commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { totalCount: number; nodes: { __typename: string; status?: string; conclusion?: string | null; state?: string }[] } } | null } }[] };
}
interface IGqlIssueLite {
	number: number; title: string; url: string; state: string;
	repository: { owner: { login: string }; name: string };
	assignees: { nodes: { login: string; avatarUrl?: string }[] };
	labels: { nodes: { name: string; color: string }[] };
	closedByPullRequestsReferences: { nodes: IGqlPrLite[] } | null;
}
interface IGqlFieldValue { __typename: string; name?: string; date?: string; text?: string; number?: number; title?: string; field?: { name?: string } }

export interface IRepoSlug {
	readonly owner: string;
	readonly repo: string;
}

/** `git remote get-url origin` の値から owner/repo を取り出す。 */
export function parseRemote(url: string | undefined): IRepoSlug | undefined {
	const m = url?.trim().match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/);
	return m?.groups ? { owner: m.groups.owner, repo: m.groups.repo } : undefined;
}

export function mapPr(pr: IGqlPrLite): ITaskBoardPrRef {
	const state: TaskBoardPrState = pr.merged || pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
	const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
	let checks: ITaskBoardPrRef['checks'] = 'none';
	let passed: number | undefined;
	let total: number | undefined;
	if (rollup) {
		checks = rollup.state === 'SUCCESS' ? 'success' : rollup.state === 'FAILURE' || rollup.state === 'ERROR' ? 'failure' : 'pending';
		total = rollup.contexts.totalCount;
		passed = rollup.contexts.nodes.filter(n => n.__typename === 'CheckRun' ? ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(n.conclusion ?? '') : n.state === 'SUCCESS').length;
	}
	const reviews = pr.latestReviews.nodes.map(r => r.state);
	const review: ITaskBoardPrRef['review'] = pr.reviewDecision === 'APPROVED' ? 'approved'
		: pr.reviewDecision === 'CHANGES_REQUESTED' || reviews.includes('CHANGES_REQUESTED') ? 'changes'
			: reviews.includes('APPROVED') ? 'approved'
				: reviews.length ? 'commented' : 'none';
	return { owner: pr.repository.owner.login, repo: pr.repository.name, number: pr.number, url: pr.url, title: pr.title, state, checks, checksPassed: passed, checksTotal: total, review };
}

/** Issue を閉じる PR のうち、開いている新しいもの → マージ済みの順に 1 つ選ぶ。 */
export function pickPr(prs: readonly IGqlPrLite[]): ITaskBoardPrRef | undefined {
	const mapped = prs.map(mapPr).sort((a, b) => b.number - a.number);
	return mapped.find(p => p.state === 'open' || p.state === 'draft') ?? mapped.find(p => p.state === 'merged');
}

function mapIssue(issue: IGqlIssueLite, extra: Partial<ITaskBoardIntakeItem> = {}): ITaskBoardIntakeItem & { pr?: ITaskBoardPrRef } {
	return {
		issue: { owner: issue.repository.owner.login, repo: issue.repository.name, number: issue.number, url: issue.url },
		title: issue.title,
		labels: issue.labels.nodes.map(l => ({ name: l.name, color: l.color })),
		assignees: issue.assignees.nodes.map(a => a.login),
		avatars: Object.fromEntries(issue.assignees.nodes.filter(a => a.avatarUrl).map(a => [a.login, a.avatarUrl!])),
		...extra,
		pr: pickPr(issue.closedByPullRequestsReferences?.nodes ?? []),
	};
}

/** Projects の 1 項目のフィールドから、ステータス・締切・優先度を読む。 */
export function readProjectFields(values: readonly IGqlFieldValue[], flow: ITaskBoardFlow): { status?: string; due?: string; priority?: string; stage?: string } {
	const statusField = (flow.intake.statusField ?? 'Status').toLowerCase();
	const named = (v: IGqlFieldValue) => (v.field?.name ?? '').toLowerCase();
	const status = values.find(v => v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && named(v) === statusField)?.name;
	const dates = values.filter(v => v.__typename === 'ProjectV2ItemFieldDateValue');
	const due = (flow.intake.dueField ? dates.find(v => named(v) === flow.intake.dueField!.toLowerCase()) : dates[0])?.date;
	const priority = values.find(v => v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && (flow.intake.priorityField ? named(v) === flow.intake.priorityField.toLowerCase() : /priority|優先/i.test(v.field?.name ?? '')))?.name;
	const stageField = flow.intake.stageField?.toLowerCase();
	const stage = stageField ? values.find(v => v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && named(v) === stageField)?.name : undefined;
	return { status, due: due ?? undefined, priority, stage };
}

function rate(r: IGqlRate | undefined) {
	return r ? { remaining: r.remaining, limit: r.limit, resetAt: Date.parse(r.resetAt) } : undefined;
}

export interface IGitHubSyncOptions {
	readonly client: GitHubClient;
	readonly engine: TaskBoardEngine;
	readonly repo: IRepoSlug | undefined;
	readonly onState: () => void;
	readonly onSynced?: (result: { added: number; updated: number; removed: number }) => void;
	readonly intervalMs?: number;
	readonly prIntervalMs?: number;
}

export class GitHubSync {
	private state: { -readonly [K in keyof ITaskBoardGitHubState]: ITaskBoardGitHubState[K] } = { mode: 'off' };
	private intakeTimer: NodeJS.Timeout | undefined;
	private prTimer: NodeJS.Timeout | undefined;
	private syncing: Promise<void> | undefined;
	private readonly detailCache = new Map<string, { at: number; value: unknown }>();
	private disposed = false;

	constructor(private readonly options: IGitHubSyncOptions) {
		// gh でアカウントが切り替わったら、前のアカウントで読んだ詳細を見せない
		options.client.onDidChangeAccount(() => {
			this.detailCache.clear();
			this.projectMeta.clear();
		});
	}

	getState(): ITaskBoardGitHubState {
		const c = this.options.client;
		const pausedUntil = c.pausedUntil();
		return { ...this.state, rest: c.rest, graphql: c.graphqlLimit ?? this.state.graphql, requestCount: c.requestCount, login: c.login, avatarUrl: c.avatarUrl, pausedUntil: pausedUntil || undefined };
	}

	get login(): string | undefined {
		return this.options.client.login;
	}

	private set(patch: Partial<ITaskBoardGitHubState>): void {
		Object.assign(this.state, patch);
		this.options.onState();
	}

	async start(): Promise<void> {
		// PR の見張りは、最初の接続に失敗しても動かしておく（後の同期でつながったら効き始める）
		this.prTimer = setInterval(() => {
			if (!this.options.client.blockedUntil('graphql')) {
				void this.refreshPullRequests([], true).catch(err => this.fail(err));
			}
		}, this.options.prIntervalMs ?? PR_INTERVAL);
		this.set({ mode: 'connecting', error: undefined });
		try {
			await this.options.client.init();
			this.set({ mode: 'ok' });
		} catch (err) {
			this.set({ mode: 'error', error: (err as Error).message });
			this.schedule();
			return;
		}
		await this.syncNow();
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.intakeTimer);
		clearInterval(this.prTimer);
		clearTimeout(this.writeTimer);
		this.writeTimer = undefined;
	}

	private fail(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		this.set({ mode: err instanceof GitHubError && err.kind === 'auth' ? 'error' : this.state.mode === 'connecting' ? 'error' : this.state.mode, error: message });
	}

	private schedule(): void {
		clearTimeout(this.intakeTimer);
		if (this.disposed) {
			return;
		}
		const interval = this.options.intervalMs ?? INTAKE_INTERVAL;
		this.state.nextSyncAt = Date.now() + interval;
		this.intakeTimer = setTimeout(() => void this.syncNow(), interval);
	}

	/** 取り込みを今すぐ行う。実行中なら同じ処理を待つ。 */
	syncNow(): Promise<void> {
		if (this.syncing) {
			return this.syncing;
		}
		this.set({ syncing: true });
		this.syncing = this.doSync().finally(() => {
			this.syncing = undefined;
			this.set({ syncing: false });
			this.schedule();
		});
		return this.syncing;
	}

	private async doSync(): Promise<void> {
		if (this.state.mode !== 'ok' && this.state.mode !== 'error') {
			return;
		}
		const engine = this.options.engine;
		const flow = engine.getActiveFlow();
		try {
			// 取り込みは担当（ログイン名）で絞るので、先にアカウントの切り替えを確かめてからログイン名を読む
			await this.options.client.refreshAccount();
			const { items, label, complete } = await this.fetchIntake(flow);
			const result = engine.syncIntake(items, complete);
			for (const item of items) {
				if (item.pr) {
					engine.reportPullRequest(`gh:${item.issue.owner}/${item.issue.repo}#${item.issue.number}`.toLowerCase(), item.pr);
				}
			}
			this.set({ mode: 'ok', error: undefined, lastSyncAt: Date.now(), sourceLabel: label });
			this.options.onSynced?.(result);
			await this.refreshPullRequests();
		} catch (err) {
			this.fail(err);
		}
	}

	private intakeRepo(flow: ITaskBoardFlow): IRepoSlug | undefined {
		const owner = flow.intake.owner ?? this.options.repo?.owner;
		const repo = flow.intake.repo ?? this.options.repo?.repo;
		return owner && repo && NAME_RE.test(owner) && NAME_RE.test(repo) ? { owner, repo } : undefined;
	}

	private async fetchIntake(flow: ITaskBoardFlow): Promise<{ items: (ITaskBoardIntakeItem & { pr?: ITaskBoardPrRef })[]; label: string; complete: boolean }> {
		const login = this.options.client.login!;
		const intake = flow.intake;
		if (intake.source === 'none') {
			return { items: [], label: '', complete: true };
		}
		if (intake.source === 'github-project') {
			const owner = intake.owner ?? this.options.repo?.owner;
			if (!owner || !intake.project) {
				throw new GitHubError('Projects の取り込みには owner と project（番号）が要ります');
			}
			const project = await this.fetchProject(owner, intake.project, flow, login);
			return { items: project.items, complete: project.complete, label: `${owner} / Projects #${intake.project}` };
		}
		const slug = this.intakeRepo(flow);
		if (!slug) {
			throw new GitHubError('取り込むリポジトリが分かりません（--repo の origin か、フローの intake.owner / intake.repo を設定してください）');
		}
		const data = await this.options.client.graphql<{ search: { issueCount: number; nodes: (IGqlIssueLite & { __typename: string })[] }; rateLimit: IGqlRate }>(
			`${PR_LITE}${ISSUE_LITE}
			query($q: String!) { search(query: $q, type: ISSUE, first: 100) { issueCount nodes { __typename ... on Issue { ...IssueLite } } } ${RATE} }`,
			{ q: `repo:${slug.owner}/${slug.repo} is:issue is:open assignee:${login} archived:false` },
		);
		this.state.graphql = rate(data.rateLimit);
		return {
			items: data.search.nodes.filter(n => n.__typename === 'Issue').map(n => mapIssue(n)),
			label: `${slug.owner}/${slug.repo} の Issue`,
			// 100 件で打ち切ったときは、一覧に無い未着手を台帳から外さない
			complete: data.search.issueCount <= data.search.nodes.length,
		};
	}

	private async fetchProject(owner: string, number: number, flow: ITaskBoardFlow, login: string): Promise<{ items: (ITaskBoardIntakeItem & { pr?: ITaskBoardPrRef })[]; complete: boolean }> {
		const todo = (flow.intake.todoValues ?? ['Todo']).map(v => v.trim().toLowerCase());
		const items: (ITaskBoardIntakeItem & { pr?: ITaskBoardPrRef })[] = [];
		let after: string | null = null;
		let complete = false;
		for (let page = 0; page < 5; page++) {
			type Page = { repositoryOwner: { projectV2: { id: string; title: string; items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; isArchived: boolean; fieldValues: { nodes: IGqlFieldValue[] }; content: (IGqlIssueLite & { __typename: string }) | null }[] } } | null } | null; rateLimit: IGqlRate };
			const data: Page = await this.options.client.graphql<Page>(
				`${PR_LITE}${ISSUE_LITE}
				query($owner: String!, $number: Int!, $after: String) {
					repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id title items(first: 100, after: $after) {
						pageInfo { hasNextPage endCursor }
						nodes { id isArchived
							fieldValues(first: 30) { nodes { __typename
								... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
								... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
								... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
							} }
							content { __typename ... on Issue { ...IssueLite } }
						}
					} } } }
					${RATE}
				}`,
				{ owner, number, after },
			);
			this.state.graphql = rate(data.rateLimit);
			const project = data.repositoryOwner?.projectV2;
			if (!project) {
				throw new GitHubError(`Projects #${number} が ${owner} に見つかりません（権限 read:project も確認してください）`);
			}
			for (const node of project.items.nodes) {
				const issue = node.content;
				if (node.isArchived || !issue || issue.__typename !== 'Issue' || issue.state !== 'OPEN') {
					continue;
				}
				if (!issue.assignees.nodes.some(a => a.login.toLowerCase() === login.toLowerCase())) {
					continue;
				}
				const fields = readProjectFields(node.fieldValues.nodes, flow);
				const id = `gh:${issue.repository.owner.login}/${issue.repository.name}#${issue.number}`.toLowerCase();
				const tracked = this.options.engine.getTask(id);
				const isTodo = todo.includes((fields.status ?? '').trim().toLowerCase());
				if (!isTodo && !tracked) {
					continue;
				}
				items.push(mapIssue(issue, { due: fields.due, priority: fields.priority, projectStatus: fields.status, projectItemId: node.id, projectStage: fields.stage }));
			}
			if (!project.items.pageInfo.hasNextPage) {
				complete = true;
				break;
			}
			after = project.items.pageInfo.endCursor;
		}
		return { items, complete };
	}

	/** 工程が進行中で、本物の PR があるタスクの PR を読み直す。watchOnly なら外部待ちの工程にいるものだけ。 */
	async refreshPullRequests(extraTaskIds: readonly string[] = [], watchOnly = false): Promise<void> {
		if (this.state.mode !== 'ok') {
			return;
		}
		const engine = this.options.engine;
		// 名前の形がおかしいものは最初から外す（1 件で問い合わせ全体が失敗しないように）
		// 60 秒ごとに見るのは、外部待ちの工程にいるものと、このタスクの PR（マージ・クローズで完了にする判定は
		// どの工程でも効くので、e2e などの途中でマージ・クローズされても 60 秒以内に気付けるように）
		const waiting = (t: ITaskBoardTask) => {
			if (t.prOwned) {
				return true;
			}
			const step = engine.flowOf(t).steps.find(s => s.id === t.step);
			return step?.kind === 'wait' || step?.kind === 'human' && step.gate === 'merge';
		};
		const tasks = engine.getTasks().filter(t => t.pr && !t.pr.simulated && NAME_RE.test(t.pr.owner) && NAME_RE.test(t.pr.repo) && (t.step !== TASK_BOARD_TODO && t.step !== TASK_BOARD_DONE && (!watchOnly || waiting(t)) || extraTaskIds.includes(t.id)) && t.pr.state !== 'merged' && t.pr.state !== 'closed').slice(0, 40);
		if (!tasks.length) {
			return;
		}
		const vars: Record<string, unknown> = {};
		const parts: string[] = [];
		tasks.forEach((t, i) => {
			vars[`o${i}`] = t.pr!.owner;
			vars[`r${i}`] = t.pr!.repo;
			vars[`n${i}`] = t.pr!.number;
			parts.push(`p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ...PrLite } }`);
		});
		const decl = tasks.map((_, i) => `$o${i}: String!, $r${i}: String!, $n${i}: Int!`).join(', ');
		const data = await this.options.client.graphql<Record<string, { pullRequest: IGqlPrLite | null } | IGqlRate>>(
			`${PR_LITE}
			query(${decl}) { ${parts.join('\n')} ${RATE} }`,
			vars,
		);
		this.state.graphql = rate(data.rateLimit as IGqlRate);
		tasks.forEach((t, i) => {
			const node = (data[`p${i}`] as { pullRequest: IGqlPrLite | null } | undefined)?.pullRequest;
			if (node) {
				engine.reportPullRequest(t.id, mapPr(node));
			}
		});
		this.options.onState();
	}

	private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
		const hit = this.detailCache.get(key);
		if (hit && Date.now() - hit.at < DETAIL_TTL) {
			return hit.value as T;
		}
		const value = await load();
		this.detailCache.set(key, { at: Date.now(), value });
		if (this.detailCache.size > 200) {
			this.detailCache.delete(this.detailCache.keys().next().value!);
		}
		return value;
	}

	/** 詳細の覚えを捨てる（コメントした後など）。 */
	invalidate(task: ITaskBoardTask): void {
		this.detailCache.delete(`issue:${task.id}`);
		if (task.pr) {
			this.detailCache.delete(`pr:${task.pr.owner}/${task.pr.repo}#${task.pr.number}`);
		}
	}

	issueDetail(task: ITaskBoardTask): Promise<ITaskBoardIssueDetail | undefined> {
		const issue = task.issue;
		if (!issue || this.state.mode !== 'ok') {
			return Promise.resolve(undefined);
		}
		return this.cached(`issue:${task.id}`, async () => {
			type Actor = { login: string; avatarUrl?: string; __typename?: string } | null;
			type R = { repository: { issue: {
				id: string; title: string; body: string; bodyHTML: string; url: string; state: string; createdAt: string; locked: boolean; author: Actor;
				comments: { nodes: { id: string; body: string; bodyHTML: string; createdAt: string; author: Actor }[] };
				timelineItems: { nodes: ({ __typename: string; createdAt?: string; actor?: Actor; label?: { name: string; color: string }; assignee?: { login?: string } | null; source?: { __typename: string; number?: number; title?: string; url?: string; state?: string; isDraft?: boolean; merged?: boolean } } | null)[] };
				closedByPullRequestsReferences: { nodes: IGqlPrLite[] } | null;
			} | null } | null; rateLimit: IGqlRate };
			const data = await this.options.client.graphql<R>(`${PR_LITE}
				query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { issue(number: $n) {
					id title body bodyHTML url state createdAt locked author { login avatarUrl(size: 80) }
					comments(last: 40) { nodes { id body bodyHTML createdAt author { login avatarUrl(size: 80) __typename } } }
					timelineItems(last: 40, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, CROSS_REFERENCED_EVENT, CLOSED_EVENT, REOPENED_EVENT, RENAMED_TITLE_EVENT]) { nodes { __typename
						... on LabeledEvent { createdAt actor { login avatarUrl(size: 40) } label { name color } }
						... on UnlabeledEvent { createdAt actor { login avatarUrl(size: 40) } label { name color } }
						... on AssignedEvent { createdAt actor { login avatarUrl(size: 40) } assignee { ... on User { login } } }
						... on CrossReferencedEvent { createdAt actor { login avatarUrl(size: 40) } source { __typename ... on PullRequest { number title url state isDraft merged } } }
						... on ClosedEvent { createdAt actor { login avatarUrl(size: 40) } }
						... on ReopenedEvent { createdAt actor { login avatarUrl(size: 40) } }
						... on RenamedTitleEvent { createdAt actor { login avatarUrl(size: 40) } }
					} }
					closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { ...PrLite } }
				} } ${RATE} }`, { o: issue.owner, r: issue.repo, n: issue.number });
			this.state.graphql = rate(data.rateLimit);
			const i = data.repository?.issue;
			if (!i) {
				return undefined;
			}
			const kinds: Record<string, TaskBoardIssueEventKind> = { LabeledEvent: 'labeled', UnlabeledEvent: 'unlabeled', AssignedEvent: 'assigned', CrossReferencedEvent: 'referenced', ClosedEvent: 'closed', ReopenedEvent: 'reopened', RenamedTitleEvent: 'renamed' };
			const events: ITaskBoardIssueEvent[] = [];
			for (const n of i.timelineItems.nodes) {
				const kind = n && kinds[n.__typename];
				if (!n?.createdAt || !kind || (kind === 'referenced' && n.source?.__typename !== 'PullRequest')) {
					continue;
				}
				events.push({
					kind, actor: n.actor?.login ?? 'ghost', actorAvatar: n.actor?.avatarUrl, at: n.createdAt,
					label: n.label ? { name: n.label.name, color: n.label.color } : undefined,
					assignee: n.assignee?.login,
					pr: n.source?.__typename === 'PullRequest' ? { number: n.source.number!, title: n.source.title!, url: n.source.url!, state: n.source.merged ? 'merged' : n.source.state === 'CLOSED' ? 'closed' : n.source.isDraft ? 'draft' : 'open' } : undefined,
				});
			}
			return {
				id: i.id, title: i.title, body: i.body, bodyHTML: i.bodyHTML, url: i.url, state: i.state === 'CLOSED' ? 'closed' : 'open', locked: i.locked,
				author: i.author?.login ?? 'ghost', authorAvatar: i.author?.avatarUrl, createdAt: i.createdAt,
				comments: i.comments.nodes.map(c => ({ id: c.id, author: c.author?.login ?? 'ghost', authorAvatar: c.author?.avatarUrl, body: c.body, bodyHTML: c.bodyHTML, createdAt: c.createdAt, isBot: c.author?.__typename === 'Bot' })),
				events,
				linkedPrs: (i.closedByPullRequestsReferences?.nodes ?? []).map(p => { const m = mapPr(p); return { number: m.number, title: p.title, url: m.url, state: m.state }; }),
			} satisfies ITaskBoardIssueDetail;
		});
	}

	pullDetail(task: ITaskBoardTask): Promise<ITaskBoardPullDetail | undefined> {
		const pr = task.pr;
		if (!pr || pr.simulated || this.state.mode !== 'ok') {
			return Promise.resolve(undefined);
		}
		return this.cached(`pr:${pr.owner}/${pr.repo}#${pr.number}`, async () => {
			type Actor = { login: string; avatarUrl?: string; __typename?: string } | null;
			type R = { repository: { pullRequest: {
				id: string; number: number; title: string; url: string; state: string; isDraft: boolean; merged: boolean; body: string; bodyHTML: string; createdAt: string;
				author: Actor; baseRefName: string; headRefName: string; additions: number; deletions: number;
				mergeable: string; reviewDecision: string | null;
				comments: { nodes: { id: string; body: string; bodyHTML: string; createdAt: string; author: Actor }[] };
				commits: { nodes: { commit: { oid: string; messageHeadline: string; committedDate: string; author: { name: string; avatarUrl?: string; user: { login: string } | null } | null } }[] };
				reviews: { nodes: { state: string; body: string; bodyHTML: string; submittedAt: string | null; author: Actor }[] };
				reviewThreads: { nodes: { isResolved: boolean; path: string; line: number | null; comments: { nodes: { body: string; bodyHTML: string; diffHunk: string; author: Actor }[] } }[] };
				files: { nodes: { path: string; additions: number; deletions: number; changeType: string }[] } | null;
				last: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: { __typename: string; name?: string; status?: string; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; detailsUrl?: string | null; checkSuite?: { workflowRun?: { workflow?: { name: string } } | null } | null; context?: string; state?: string; description?: string | null; targetUrl?: string | null }[] } } | null } }[] };
			} | null } | null; rateLimit: IGqlRate };
			const data = await this.options.client.graphql<R>(`
				query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { pullRequest(number: $n) {
					id number title url state isDraft merged body bodyHTML createdAt author { login avatarUrl(size: 80) } baseRefName headRefName additions deletions mergeable reviewDecision
					comments(last: 40) { nodes { id body bodyHTML createdAt author { login avatarUrl(size: 80) __typename } } }
					commits(last: 30) { nodes { commit { oid messageHeadline committedDate author { name avatarUrl(size: 40) user { login } } } } }
					reviews(last: 30) { nodes { state body bodyHTML submittedAt author { login avatarUrl(size: 80) __typename } } }
					reviewThreads(first: 40) { nodes { isResolved path line comments(first: 1) { nodes { body bodyHTML diffHunk author { login avatarUrl(size: 80) } } } } }
					files(first: 100) { nodes { path additions deletions changeType } }
					last: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 60) { nodes { __typename
						... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
						... on StatusContext { context state description targetUrl }
					} } } } } }
				} } ${RATE} }`, { o: pr.owner, r: pr.repo, n: pr.number });
			this.state.graphql = rate(data.rateLimit);
			const p = data.repository?.pullRequest;
			if (!p) {
				return undefined;
			}
			const checks: ITaskBoardCheck[] = (p.last.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(n => {
				if (n.__typename === 'CheckRun') {
					const state: TaskBoardCheckState = n.status !== 'COMPLETED' ? (n.status === 'QUEUED' || n.status === 'WAITING' || n.status === 'PENDING' ? 'queued' : 'pending')
						: n.conclusion === 'SUCCESS' ? 'success' : n.conclusion === 'SKIPPED' ? 'skipped' : n.conclusion === 'NEUTRAL' ? 'neutral' : n.conclusion === 'CANCELLED' ? 'cancelled' : 'failure';
					const dur = n.startedAt && n.completedAt ? Math.round((Date.parse(n.completedAt) - Date.parse(n.startedAt)) / 1000) : undefined;
					return { name: n.name ?? 'check', state, detail: n.checkSuite?.workflowRun?.workflow?.name, durationSec: dur, url: n.detailsUrl ?? undefined };
				}
				const state: TaskBoardCheckState = n.state === 'SUCCESS' ? 'success' : n.state === 'PENDING' || n.state === 'EXPECTED' ? 'pending' : 'failure';
				return { name: n.context ?? 'status', state, detail: n.description ?? undefined, url: n.targetUrl ?? undefined };
			});
			const reviewState = (st: string): ITaskBoardPullDetail['reviews'][number]['state'] => st === 'APPROVED' ? 'approved' : st === 'CHANGES_REQUESTED' ? 'changes' : st === 'DISMISSED' ? 'dismissed' : st === 'PENDING' ? 'pending' : 'commented';
			const changeType = (c: string): ITaskBoardPullDetail['files'][number]['status'] => c === 'ADDED' ? 'added' : c === 'DELETED' ? 'removed' : c === 'RENAMED' ? 'renamed' : c === 'MODIFIED' ? 'modified' : 'changed';
			const isBot = (a: Actor) => a?.__typename === 'Bot' || /\[bot\]$/.test(a?.login ?? '');
			return {
				id: p.id, number: p.number, title: p.title, url: p.url,
				state: p.merged ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open',
				author: p.author?.login ?? 'ghost', authorAvatar: p.author?.avatarUrl, body: p.body, bodyHTML: p.bodyHTML, base: p.baseRefName, head: p.headRefName, additions: p.additions, deletions: p.deletions, createdAt: p.createdAt,
				mergeable: p.mergeable === 'MERGEABLE' ? 'mergeable' : p.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
				reviewDecision: p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : p.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'none',
				comments: p.comments.nodes.map(c => ({ id: c.id, author: c.author?.login ?? 'ghost', authorAvatar: c.author?.avatarUrl, body: c.body, bodyHTML: c.bodyHTML, createdAt: c.createdAt, isBot: isBot(c.author) })),
				commits: p.commits.nodes.map(c => ({ sha: c.commit.oid.slice(0, 7), message: c.commit.messageHeadline, author: c.commit.author?.user?.login ?? c.commit.author?.name ?? 'unknown', authorAvatar: c.commit.author?.avatarUrl, at: c.commit.committedDate })),
				checks,
				reviews: p.reviews.nodes.filter(r => r.state !== 'PENDING').map(r => ({ author: r.author?.login ?? 'ghost', authorAvatar: r.author?.avatarUrl, state: reviewState(r.state), body: r.body, bodyHTML: r.bodyHTML, at: r.submittedAt ?? p.createdAt, isBot: isBot(r.author) })),
				threads: p.reviewThreads.nodes.filter(t => t.comments.nodes.length).map(t => ({ path: t.path, line: t.line ?? undefined, resolved: t.isResolved, author: t.comments.nodes[0].author?.login ?? 'ghost', authorAvatar: t.comments.nodes[0].author?.avatarUrl, body: t.comments.nodes[0].body, bodyHTML: t.comments.nodes[0].bodyHTML, diffHunk: t.comments.nodes[0].diffHunk })),
				files: (p.files?.nodes ?? []).map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions, status: changeType(f.changeType) })),
			} satisfies ITaskBoardPullDetail;
		});
	}

	async pullFilePatch(task: ITaskBoardTask, file: string): Promise<string | undefined> {
		const pr = task.pr;
		if (!pr || pr.simulated || this.state.mode !== 'ok' || !NAME_RE.test(pr.owner) || !NAME_RE.test(pr.repo)) {
			return undefined;
		}
		const files = await this.options.client.get<{ filename: string; patch?: string }[]>(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100`);
		return files.find(f => f.filename === file)?.patch;
	}

	/** Issue か PR にコメントする。投稿先のノード id は詳細から取る。 */
	async addComment(task: ITaskBoardTask, target: 'issue' | 'pr', body: string): Promise<ITaskBoardComment> {
		const detail = target === 'pr' ? await this.pullDetail(task) : await this.issueDetail(task);
		if (!detail?.id) {
			throw new GitHubError(target === 'pr' ? 'PR が見つかりません' : 'Issue が見つかりません');
		}
		type R = { addComment: { commentEdge: { node: { id: string; body: string; bodyHTML: string; createdAt: string; author: { login: string; avatarUrl: string } | null } } } };
		const data = await this.options.client.graphql<R>(`mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { id body bodyHTML createdAt author { login avatarUrl(size: 80) } } } } }`, { id: detail.id, body });
		this.invalidate(task);
		const node = data.addComment.commentEdge.node;
		return { id: node.id, author: node.author?.login ?? 'ghost', authorAvatar: node.author?.avatarUrl, body: node.body, bodyHTML: node.bodyHTML, createdAt: node.createdAt };
	}

	/** GitHub の書式（メンションや #番号のリンクを含む）で HTML にする。 */
	async renderMarkdown(task: ITaskBoardTask, text: string): Promise<string | undefined> {
		const repo = task.issue ?? task.pr;
		if (this.state.mode !== 'ok') {
			return undefined;
		}
		return this.options.client.postText('/markdown', { text, mode: 'gfm', context: repo ? `${repo.owner}/${repo.repo}` : undefined });
	}

	/** 本文の画像を、トークンを付けて取ってくる（非公開リポジトリの画像はブラウザから直接読めないため）。 */
	fetchImage(url: string): Promise<{ type: string; body: Buffer } | undefined> {
		return this.options.client.fetchImage(url);
	}

	/* ---------------- Projects の欄（軸） ---------------- */

	private readonly projectMeta = new Map<string, { projectId: string; fields: ITaskBoardProjectField[] }>();

	private async loadProject(owner: string, number: number, force = false): Promise<{ projectId: string; fields: ITaskBoardProjectField[] }> {
		const key = `${owner}#${number}`;
		const hit = this.projectMeta.get(key);
		if (hit && !force) {
			return hit;
		}
		if (!NAME_RE.test(owner)) {
			throw new GitHubError('owner の形が不正です');
		}
		type R = { repositoryOwner: { projectV2: { id: string; fields: { nodes: ({ __typename: string; id: string; name: string; options?: { id: string; name: string; color: TaskBoardProjectColor; description: string }[] } | null)[] } } | null } | null };
		const data = await this.options.client.graphql<R>(`query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id fields(first: 50) { nodes { __typename
			... on ProjectV2SingleSelectField { id name options { id name color description } }
		} } } } } }`, { owner, number });
		const project = data.repositoryOwner?.projectV2;
		if (!project) {
			throw new GitHubError(`Projects #${number} が ${owner} に見つかりません`);
		}
		const meta = {
			projectId: project.id,
			fields: project.fields.nodes.filter((f): f is NonNullable<typeof f> & { options: ITaskBoardProjectOption[] } => Boolean(f && f.__typename === 'ProjectV2SingleSelectField' && f.options)).map(f => ({ id: f.id, name: f.name, options: f.options })),
		};
		this.projectMeta.set(key, meta);
		return meta;
	}

	async projectFields(owner: string, number: number): Promise<readonly ITaskBoardProjectField[]> {
		if (this.state.mode !== 'ok') {
			throw new GitHubError('GitHub につながっていません');
		}
		return (await this.loadProject(owner, number, true)).fields;
	}

	/** 軸の欄に選択肢を足す。既存の選択肢は id を付けて送り直すので、項目の値は消えない。欄が無ければ作る。 */
	async addProjectOptions(owner: string, number: number, fieldName: string, options: readonly ITaskBoardProjectOptionInput[]): Promise<{ created: boolean; added: string[] }> {
		const meta = await this.loadProject(owner, number, true);
		const field = meta.fields.find(f => f.name === fieldName);
		if (!field) {
			await this.options.client.graphql(`mutation($project: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { createProjectV2Field(input: { projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
				{ project: meta.projectId, name: fieldName, options: options.map(o => ({ name: o.name, color: o.color, description: o.description })) });
			await this.loadProject(owner, number, true);
			return { created: true, added: options.map(o => o.name) };
		}
		const existing = new Set(field.options.map(o => o.name.toLowerCase()));
		const fresh = options.filter(o => !existing.has(o.name.toLowerCase()));
		if (!fresh.length) {
			return { created: false, added: [] };
		}
		await this.options.client.graphql(`mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
			{ field: field.id, options: [...field.options.map(o => ({ id: o.id, name: o.name, color: o.color, description: o.description })), ...fresh.map(o => ({ name: o.name, color: o.color, description: o.description }))] });
		await this.loadProject(owner, number, true);
		return { created: false, added: fresh.map(o => o.name) };
	}

	private readonly lastWritten = new Map<string, string>();
	private writeTimer: NodeJS.Timeout | undefined;

	/** 工程の変化を、少しまとめてから軸の欄へ書き戻す。 */
	scheduleWriteBack(): void {
		if (this.disposed || this.writeTimer || this.state.mode !== 'ok') {
			return;
		}
		this.writeTimer = setTimeout(() => {
			this.writeTimer = undefined;
			void this.writeBack().catch(err => this.fail(err));
		}, 1500);
	}

	private async writeBack(): Promise<void> {
		const engine = this.options.engine;
		for (const task of engine.getTasks()) {
			const flow = engine.flowOf(task);
			const intake = flow.intake;
			if (intake.source !== 'github-project' || !intake.stageField || intake.writeBack === false || !task.projectItemId || task.step === TASK_BOARD_TODO) {
				continue;
			}
			const desired = engine.desiredProjectStage(task);
			if (!desired || desired === task.projectStage || this.lastWritten.get(task.id) === desired) {
				continue;
			}
			const owner = intake.owner ?? this.options.repo?.owner;
			if (!owner || !intake.project) {
				continue;
			}
			const meta = await this.loadProject(owner, intake.project);
			const field = meta.fields.find(f => f.name.toLowerCase() === intake.stageField!.toLowerCase());
			const option = field?.options.find(o => o.name === desired);
			if (!field || !option) {
				continue;
			}
			this.lastWritten.set(task.id, desired);
			await this.options.client.graphql(`mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
				{ project: meta.projectId, item: task.projectItemId, field: field.id, option: option.id });
			engine.setProjectStage(task.id, desired);
		}
	}
}
