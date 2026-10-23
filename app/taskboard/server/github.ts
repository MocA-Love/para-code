// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFile } from 'node:child_process';
import { commandPath } from './executables.js';
import type { ITaskBoardRateLimit } from '@engine/paradisTaskBoard.js';

/*
 * GitHub の API を呼ぶ口（Q348 A）。ボードのサーバーからの GitHub の呼び出しは、すべてここを通す。
 * - トークンは `gh auth token` で受け取り、メモリにだけ持つ（ファイルにもログにも画面にも出さない）。
 *   5 分ごとと 401 のときに受け取り直し、gh のアカウントの切り替えに追従する（変わったら覚えたものを捨てる）
 * - 呼び出しは同時実行と 1 分あたりの回数を絞り、数える。読むだけの同じ要求が重なったら 1 回にまとめる
 * - REST は ETag を覚え、変化が無い応答（304）は残量を消費しない
 * - 上限は本体（src/vs/platform/github/common/githubRateLimitCoordinator.ts）と同じ考え方で扱う:
 *   secondary limit はアカウントごと、primary limit は x-ratelimit-resource の枠ごとに、retry-after かリセットまで止める。
 *   手がかりが無い・過ぎているときは 60 秒止める。GraphQL の RATE_LIMITED（200 で返る）も止める
 * - 書き込み（mutation・POST）はまとめず、やり直さない（401 でトークンを取り直したときの 1 回だけ）
 */

const HOST = 'github.com';
const API = 'https://api.github.com';
const MAX_CONCURRENT = 4;
const PER_MINUTE = 90;
const LOW_WATER = 150;
const TIMEOUT_MS = 20000;
/** トークンを gh から受け取り直す間隔（アカウントの切り替えに追従するため）。 */
const TOKEN_RECHECK_MS = 5 * 60 * 1000;
/** GitHub が待つ時間を示さなかった上限の拒否で、最低限待つ時間（本体と同じ）。 */
const UNHINTED_COOLDOWN_MS = 60 * 1000;

export class GitHubError extends Error {
	constructor(message: string, readonly status?: number, readonly kind: 'auth' | 'budget' | 'network' | 'api' | 'graphql' = 'api') {
		super(redactGitHubSecrets(message));
		this.name = 'GitHubError';
	}
}

/** GitHub のトークンの形をした文字列を伏せる（ログやエラーの文に紛れ込んだときのため）。 */
export function redactGitHubSecrets(text: string, known: readonly string[] = []): string {
	let out = text;
	for (const secret of known) {
		if (secret.length >= 8) {
			out = out.split(secret).join('***');
		}
	}
	return out.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '***');
}

export type TokenProvider = () => Promise<string>;

/** gh CLI から github.com のトークンを受け取る。gh が無い・未ログインなら失敗する。 */
export function ghTokenProvider(): TokenProvider {
	// GH_HOST が GitHub Enterprise を指していても、api.github.com へ送るのは github.com のトークンだけにする
	return () => new Promise((resolve, reject) => {
		execFile(commandPath('gh'), ['auth', 'token', '--hostname', HOST], { timeout: 10000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout) => {
			const token = stdout?.trim();
			if (err || !token) {
				reject(new GitHubError('gh auth token failed. Run `gh auth login` (scope: repo, read:project).', undefined, 'auth'));
				return;
			}
			resolve(token);
		});
	});
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'follow' }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }>;

type Headers = { get(name: string): string | null };

/** そのまま取ってよい画像の置き場（トークンは付けない）。 */
const PUBLIC_IMAGE_HOSTS = new Set(['private-user-images.githubusercontent.com', 'user-images.githubusercontent.com', 'avatars.githubusercontent.com', 'camo.githubusercontent.com', 'objects.githubusercontent.com']);
const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_CACHE_BYTES = 80 * 1024 * 1024;

interface ICached {
	readonly etag: string;
	readonly body: unknown;
}

/** 上限の枠（core・search・graphql など）ごとの残量と、止めている期限。 */
interface IBucket {
	remaining?: number;
	limit?: number;
	resetAt?: number;
	blockedUntil?: number;
}

interface IResponse {
	readonly status: number;
	readonly text: string;
	readonly binary?: Buffer;
	readonly headers: Headers;
}

/** ボードが扱う PR の要点（REST の pulls の応答から）。 */
export interface IGitHubPullSummary {
	readonly number: number;
	readonly url: string;
	readonly title: string;
	readonly draft: boolean;
}

export interface IGitHubClientOptions {
	readonly token: TokenProvider;
	readonly fetch?: FetchLike;
	readonly now?: () => number;
}

export class GitHubClient {
	private token: string | undefined;
	private tokenAt = 0;
	private tokenLoading: Promise<string> | undefined;
	/** 401 で断られたトークン。gh が同じものを返す間は、送らずに失敗にする。 */
	private rejectedToken: string | undefined;
	/** 伏せ字にする、これまでに受け取ったトークン（直近のいくつか）。 */
	private readonly secrets: string[] = [];
	/** アカウントが変わるたびに増やす。まとめる・覚えるときの鍵に入れる。 */
	private generation = 0;
	private readonly etags = new Map<string, ICached>();
	private readonly inflight = new Map<string, Promise<unknown>>();
	private readonly buckets = new Map<string, IBucket>();
	/** secondary limit（短時間に呼びすぎ）でアカウントごと止めている期限。 */
	private accountBlockedUntil = 0;
	private initPromise: Promise<string> | undefined;
	private readonly accountListeners: (() => void)[] = [];
	private active = 0;
	private readonly waiters: (() => void)[] = [];
	private readonly recent: number[] = [];
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly images = new Map<string, { type: string; body: Buffer }>();
	private imageBytes = 0;
	/** GitHub へ実際に送った回数。 */
	requestCount = 0;
	/** 重なった同じ要求を、送らずにまとめた回数。 */
	dedupedCount = 0;
	/** 変化が無い（304）と返った回数。 */
	notModifiedCount = 0;
	login: string | undefined;
	avatarUrl: string | undefined;

	constructor(private readonly options: IGitHubClientOptions) {
		this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
		this.now = options.now ?? Date.now;
	}

	/** REST（core）の残量。 */
	get rest(): ITaskBoardRateLimit | undefined {
		return this.limitOf('core');
	}

	/** GraphQL の残量。 */
	get graphqlLimit(): ITaskBoardRateLimit | undefined {
		return this.limitOf('graphql');
	}

	private limitOf(resource: string): ITaskBoardRateLimit | undefined {
		const b = this.buckets.get(resource);
		return b?.remaining !== undefined && b.limit !== undefined && b.resetAt !== undefined ? { remaining: b.remaining, limit: b.limit, resetAt: b.resetAt } : undefined;
	}

	/** その枠を止めている期限（止めていなければ 0）。見張りが黙って見送るのに使う。 */
	blockedUntil(resource: 'core' | 'graphql' | 'search'): number {
		const t = this.now();
		const b = this.buckets.get(resource);
		const until = Math.max(this.accountBlockedUntil, b?.blockedUntil ?? 0, b?.remaining !== undefined && b.remaining < LOW_WATER && (b.resetAt ?? 0) > t ? b.resetAt! : 0);
		return until > t ? until : 0;
	}

	/** gh のアカウントが変わったときに呼ぶ（覚えた詳細を捨てるため）。 */
	onDidChangeAccount(listener: () => void): void {
		this.accountListeners.push(listener);
	}

	/** 自分のログイン名を読む。同時に呼ばれたら 1 回にまとめ、分かっていれば読み直さない。 */
	init(): Promise<string> {
		if (this.login) {
			return Promise.resolve(this.login);
		}
		this.initPromise ??= (async () => {
			const data = await this.graphql<{ viewer: { login: string; avatarUrl?: string } }>('query { viewer { login avatarUrl } }');
			this.login = data.viewer.login;
			this.avatarUrl = data.viewer.avatarUrl;
			return this.login;
		})().finally(() => this.initPromise = undefined);
		return this.initPromise;
	}

	/** gh のアカウントの切り替えを確かめ（5 分ごと）、自分のログイン名を返す。変わっていれば読み直す。 */
	async refreshAccount(): Promise<string> {
		await this.currentToken();
		return this.init();
	}

	private async currentToken(force = false): Promise<string> {
		if (!force && this.token && this.now() - this.tokenAt < TOKEN_RECHECK_MS) {
			if (this.token === this.rejectedToken) {
				throw new GitHubError('GitHub rejected the token (401). Run `gh auth login` again.', 401, 'auth');
			}
			return this.token;
		}
		this.tokenLoading ??= this.options.token().then(token => {
			if (this.token !== undefined && token !== this.token) {
				this.resetAccount();
			}
			this.token = token;
			this.tokenAt = this.now();
			if (!this.secrets.includes(token)) {
				this.secrets.push(token);
				this.secrets.splice(0, Math.max(0, this.secrets.length - 4));
			}
			if (token !== this.rejectedToken) {
				this.rejectedToken = undefined;
			}
			return token;
		}).finally(() => this.tokenLoading = undefined);
		const token = await this.tokenLoading;
		if (token === this.rejectedToken) {
			throw new GitHubError('GitHub rejected the token (401). Run `gh auth login` again.', 401, 'auth');
		}
		return token;
	}

	/** アカウントが変わった。前のアカウントで覚えたもの（ETag・画像・残量・ログイン名）を捨てる。 */
	private resetAccount(): void {
		this.generation++;
		this.etags.clear();
		this.inflight.clear();
		this.images.clear();
		this.imageBytes = 0;
		this.buckets.clear();
		this.accountBlockedUntil = 0;
		this.login = undefined;
		this.avatarUrl = undefined;
		for (const listener of this.accountListeners) {
			listener();
		}
	}

	private async acquire(): Promise<void> {
		for (; ;) {
			const t = this.now();
			while (this.recent.length && t - this.recent[0] > 60000) {
				this.recent.shift();
			}
			if (this.active < MAX_CONCURRENT && this.recent.length < PER_MINUTE) {
				this.active++;
				this.recent.push(t);
				return;
			}
			if (this.active >= MAX_CONCURRENT) {
				await new Promise<void>(resolve => this.waiters.push(resolve));
			} else {
				await new Promise(resolve => setTimeout(resolve, Math.max(50, 60000 - (t - this.recent[0]))));
			}
		}
	}

	private release(): void {
		this.active--;
		this.waiters.shift()?.();
	}

	/** 止めている枠なら、送らずに失敗にする。 */
	private checkBudget(resource: string): void {
		const t = this.now();
		if (t < this.accountBlockedUntil) {
			throw new GitHubError(`GitHub asked us to slow down (secondary rate limit); waiting until ${new Date(this.accountBlockedUntil).toISOString()}`, undefined, 'budget');
		}
		const b = this.buckets.get(resource);
		if (b?.blockedUntil !== undefined && t < b.blockedUntil) {
			throw new GitHubError(`GitHub ${resource} rate limit; waiting until ${new Date(b.blockedUntil).toISOString()}`, undefined, 'budget');
		}
		if (b?.remaining !== undefined && b.remaining < LOW_WATER && b.resetAt !== undefined && t < b.resetAt) {
			throw new GitHubError(`GitHub ${resource} API budget is low (${b.remaining} left); waiting until ${new Date(b.resetAt).toISOString()}`, undefined, 'budget');
		}
	}

	/** 応答の上限のヘッダーを覚え、上限での拒否なら止める期限を決めて返す。 */
	private updateFromResponse(fallback: string, res: { status: number; headers: Headers }, body: string): number | undefined {
		const resource = res.headers.get('x-ratelimit-resource') ?? fallback;
		const t = this.now();
		const remaining = headerNumber(res.headers.get('x-ratelimit-remaining'));
		const reset = headerNumber(res.headers.get('x-ratelimit-reset'));
		const retryAfter = headerNumber(res.headers.get('retry-after'));
		const previous = this.buckets.get(resource) ?? {};
		const bucket: IBucket = {
			remaining: remaining ?? previous.remaining,
			limit: headerNumber(res.headers.get('x-ratelimit-limit')) ?? previous.limit,
			resetAt: reset !== undefined ? reset * 1000 : previous.resetAt,
			blockedUntil: previous.blockedUntil !== undefined && previous.blockedUntil > t ? previous.blockedUntil : undefined,
		};
		this.buckets.set(resource, bucket);
		const limited = classifyRateLimit(res, body);
		if (!limited) {
			return undefined;
		}
		const hinted = retryAfter !== undefined ? t + retryAfter * 1000 : remaining === 0 && reset !== undefined ? reset * 1000 : undefined;
		// 過ぎた手がかりで、すぐにやり直さない
		const until = hinted !== undefined && hinted > t ? hinted : t + UNHINTED_COOLDOWN_MS;
		if (limited === 'secondary') {
			this.accountBlockedUntil = Math.max(this.accountBlockedUntil, until);
		} else {
			bucket.blockedUntil = Math.max(bucket.blockedUntil ?? 0, until);
		}
		return until;
	}

	private async send(method: string, url: string, body: string | undefined, resource: string, extra: Record<string, string> = {}, binary = false): Promise<IResponse> {
		this.checkBudget(resource);
		const token = await this.currentToken();
		const res = await this.sendOnce(method, url, body, resource, token, extra, binary);
		if (res.status !== 401) {
			return res;
		}
		// 401: トークンが失効したか、gh でアカウントを切り替えた。取り直して、変わっていれば 1 回だけ送り直す
		this.rejectedToken = token;
		const fresh = await this.currentToken(true).catch(() => undefined);
		if (fresh && fresh !== token) {
			// 別のアカウントになったので、前のアカウントで覚えた ETag は付けない
			const { 'if-none-match': _etag, ...rest } = extra;
			const again = await this.sendOnce(method, url, body, resource, fresh, rest, binary);
			if (again.status !== 401) {
				return again;
			}
			this.rejectedToken = fresh;
		}
		throw new GitHubError('GitHub rejected the token (401). Run `gh auth login` again.', 401, 'auth');
	}

	private async sendOnce(method: string, url: string, body: string | undefined, resource: string, token: string, extra: Record<string, string>, binary: boolean): Promise<IResponse> {
		await this.acquire();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			this.requestCount++;
			const res = await this.fetchImpl(url, {
				method,
				headers: {
					'authorization': `Bearer ${token}`,
					'accept': 'application/vnd.github+json',
					'x-github-api-version': '2022-11-28',
					'user-agent': 'para-code-taskboard',
					...(body ? { 'content-type': 'application/json' } : {}),
					...extra,
				},
				body,
				signal: controller.signal,
				...(binary ? { redirect: 'follow' as const } : {}),
			});
			if (res.status === 304) {
				this.notModifiedCount++;
			}
			const buffer = binary && res.status === 200 && res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : undefined;
			const text = res.status === 304 || buffer ? '' : await res.text();
			const until = this.updateFromResponse(resource, res, text);
			if (until !== undefined) {
				throw new GitHubError(`GitHub rate limit (${res.status}); waiting until ${new Date(until).toISOString()}`, res.status, 'budget');
			}
			return { status: res.status, text, binary: buffer, headers: res.headers };
		} catch (err) {
			if (err instanceof GitHubError) {
				throw err;
			}
			throw new GitHubError(redactGitHubSecrets(`GitHub request failed: ${(err as Error).message}`, this.secrets), undefined, 'network');
		} finally {
			clearTimeout(timer);
			this.release();
		}
	}

	/** 読むだけの要求を、同じものが走っている間は 1 回にまとめる。 */
	private shared<T>(key: string, load: () => Promise<T>): Promise<T> {
		const full = `${this.generation}|${key}`;
		const running = this.inflight.get(full);
		if (running) {
			this.dedupedCount++;
			return running as Promise<T>;
		}
		const p = load().finally(() => {
			if (this.inflight.get(full) === p) {
				this.inflight.delete(full);
			}
		});
		this.inflight.set(full, p);
		return p;
	}

	graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
		if (isMutation(query)) {
			return this.graphqlOnce<T>(query, variables);
		}
		return this.shared(`gql|${query}|${JSON.stringify(variables)}`, () => this.graphqlOnce<T>(query, variables));
	}

	private async graphqlOnce<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const res = await this.send('POST', `${API}/graphql`, JSON.stringify({ query, variables }), 'graphql');
		let json: { data?: T; errors?: { message: string; type?: string }[] };
		try {
			json = JSON.parse(res.text);
		} catch {
			throw new GitHubError(`GitHub GraphQL returned ${res.status}`, res.status);
		}
		if (json.errors?.some(e => e.type === 'RATE_LIMITED')) {
			// GraphQL の残量切れは 200 で返る。リセットまで GraphQL を止める
			const t = this.now();
			const bucket = this.buckets.get('graphql') ?? {};
			const retryAfter = headerNumber(res.headers.get('retry-after'));
			const hinted = retryAfter !== undefined ? t + retryAfter * 1000 : bucket.resetAt;
			bucket.remaining = 0;
			bucket.blockedUntil = Math.max(bucket.blockedUntil ?? 0, hinted !== undefined && hinted > t ? hinted : t + UNHINTED_COOLDOWN_MS);
			this.buckets.set('graphql', bucket);
			throw new GitHubError(`GitHub GraphQL rate limit; waiting until ${new Date(bucket.blockedUntil).toISOString()}`, res.status, 'budget');
		}
		if (res.status >= 400 && !json.data) {
			throw new GitHubError(`GitHub GraphQL ${res.status}: ${json.errors?.[0]?.message ?? res.text.slice(0, 200)}`, res.status);
		}
		if (json.errors?.length && !json.data) {
			throw new GitHubError(json.errors.map(e => e.message).join('; '), res.status, 'graphql');
		}
		if (json.errors?.length) {
			// 部分的な失敗（権限の無い項目など）はデータを返し、理由は警告として残す
			console.warn('[taskboard] GraphQL partial errors:', redactGitHubSecrets(json.errors.map(e => e.message).join('; '), this.secrets));
		}
		return json.data as T;
	}

	/** REST の POST で、本文を文字列のまま返す（/markdown など）。 */
	async postText(pathAndQuery: string, body: unknown): Promise<string> {
		const res = await this.send('POST', `${API}${pathAndQuery}`, JSON.stringify(body), restResource(pathAndQuery));
		if (res.status >= 400) {
			throw restError(res);
		}
		return res.text;
	}

	/** REST の POST（JSON）。 */
	async post<T>(pathAndQuery: string, body: unknown): Promise<T> {
		return JSON.parse(await this.postText(pathAndQuery, body)) as T;
	}

	/**
	 * Issue や PR の本文にある画像を取ってくる。リポジトリの中の画像（github.com/o/r/raw/… など）は
	 * contents API にトークンを付けて読み、GitHub の画像置き場はそのまま読む。それ以外の場所は読まない。
	 */
	async fetchImage(raw: string): Promise<{ type: string; body: Buffer } | undefined> {
		const hit = this.images.get(raw);
		if (hit) {
			return hit;
		}
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return undefined;
		}
		if (url.protocol !== 'https:') {
			return undefined;
		}
		let result: { type: string; body: Buffer } | undefined;
		const inRepo = url.hostname === 'github.com' ? url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/) : url.hostname === 'raw.githubusercontent.com' ? url.pathname.match(/^\/([^/]+)\/([^/]+)\/(.+)$/) : null;
		if (inRepo) {
			const [, owner, repo, rest] = inRepo;
			const segments = rest.split('/').map(decodeURIComponent);
			const ext = segments[segments.length - 1].split('.').pop()?.toLowerCase() ?? '';
			const type = IMAGE_EXT[ext];
			if (!type || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
				return undefined;
			}
			// ブランチ名に / が入ることがあるので、ref と path の切れ目を前から順に試す
			for (let cut = 1; cut < Math.min(segments.length, 4) && !result; cut++) {
				const ref = segments.slice(0, cut).join('/');
				const file = segments.slice(cut).map(encodeURIComponent).join('/');
				const contentsUrl = `${API}/repos/${owner}/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`;
				const body = await this.shared(`img|${contentsUrl}`, () => this.send('GET', contentsUrl, undefined, 'core', { 'accept': 'application/vnd.github.raw' }, true)).then(r => r.binary, () => undefined);
				if (body && body.length <= MAX_IMAGE_BYTES) {
					result = { type, body };
				}
			}
		} else if (PUBLIC_IMAGE_HOSTS.has(url.hostname)) {
			const res = await this.fetchImpl(url.toString(), { method: 'GET', headers: { 'user-agent': 'para-code-taskboard' }, redirect: 'follow' });
			const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
			if (res.status === 200 && type.startsWith('image/') && res.arrayBuffer) {
				const body = Buffer.from(await res.arrayBuffer());
				if (body.length <= MAX_IMAGE_BYTES) {
					result = { type, body };
				}
			}
		}
		if (result) {
			this.images.set(raw, result);
			this.imageBytes += result.body.length;
			while (this.imageBytes > IMAGE_CACHE_BYTES && this.images.size) {
				const [key, value] = this.images.entries().next().value!;
				this.images.delete(key);
				this.imageBytes -= value.body.length;
			}
		}
		return result;
	}

	/** REST の GET。ETag が一致したら覚えた本文を返す。同じ GET が走っていれば、その結果を待つ。 */
	get<T>(pathAndQuery: string): Promise<T> {
		const url = `${API}${pathAndQuery}`;
		return this.shared(`get|${url}`, async () => {
			// 先にトークンを確かめる（アカウントが変わっていれば、ここで前のアカウントの ETag が消える）
			this.checkBudget(restResource(pathAndQuery));
			await this.currentToken();
			const generation = this.generation;
			const cached = this.etags.get(url);
			const res = await this.send('GET', url, undefined, restResource(pathAndQuery), cached ? { 'if-none-match': cached.etag } : {});
			if (res.status === 304 && cached) {
				return cached.body as T;
			}
			if (res.status >= 400) {
				throw restError(res);
			}
			const body = JSON.parse(res.text) as T;
			const etag = res.headers.get('etag');
			// 送っている間にアカウントが変わったら、前のアカウントの応答は覚えない
			if (etag && generation === this.generation) {
				this.etags.set(url, { etag, body });
				if (this.etags.size > 500) {
					this.etags.delete(this.etags.keys().next().value!);
				}
			}
			return body;
		});
	}

	/* ---------------- PR（ボードの自動の工程が使う） ---------------- */

	/** ブランチ（同じリポジトリの）から開いている PR を探す。 */
	async findOpenPullRequest(owner: string, repo: string, branch: string): Promise<IGitHubPullSummary | undefined> {
		// head は「持ち主:ブランチ」で渡す（持ち主を付けないと GitHub は条件を無視して全部返す）
		const list = await this.get<IRestPull[]>(`/repos/${seg(owner)}/${seg(repo)}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=5`);
		const pull = list.find(p => p.head?.ref === branch && (p.head?.repo?.owner?.login ?? owner).toLowerCase() === owner.toLowerCase());
		return pull ? summary(pull) : undefined;
	}

	/** ドラフト PR を作る。向け先はリポジトリの既定のブランチ（gh pr create と同じ）。同じブランチの PR が既にあれば、それを返す。 */
	async createDraftPullRequest(owner: string, repo: string, head: string, title: string, body: string): Promise<IGitHubPullSummary & { existed?: boolean }> {
		const info = await this.get<{ default_branch: string }>(`/repos/${seg(owner)}/${seg(repo)}`);
		try {
			return summary(await this.post<IRestPull>(`/repos/${seg(owner)}/${seg(repo)}/pulls`, { title, head, base: info.default_branch, body, draft: true }));
		} catch (err) {
			if (err instanceof GitHubError && err.status === 422) {
				const existing = await this.findOpenPullRequest(owner, repo, head).catch(() => undefined);
				if (existing) {
					return { ...existing, existed: true };
				}
			}
			throw err;
		}
	}

	/** ドラフトの PR をレビュー可能にする（REST には無いので GraphQL で）。 */
	async markPullRequestReady(owner: string, repo: string, number: number): Promise<void> {
		const data = await this.graphql<{ repository: { pullRequest: { id: string } | null } | null }>('query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }', { owner, repo, number });
		const id = data.repository?.pullRequest?.id;
		if (!id) {
			throw new GitHubError(`PR ${owner}/${repo}#${number} was not found`, 404);
		}
		await this.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }', { id });
	}
}

interface IRestPull {
	number: number;
	html_url: string;
	title: string;
	draft?: boolean;
	head?: { ref?: string; repo?: { owner?: { login?: string } } | null };
}

function summary(pull: IRestPull): IGitHubPullSummary {
	return { number: pull.number, url: pull.html_url, title: pull.title, draft: !!pull.draft };
}

function seg(name: string): string {
	return encodeURIComponent(name);
}

function isMutation(query: string): boolean {
	return /(?:^|\})\s*mutation\b/.test(query.trim());
}

function restResource(pathAndQuery: string): string {
	return pathAndQuery.startsWith('/search/') ? 'search' : 'core';
}

function restError(res: IResponse): GitHubError {
	let message = res.text.slice(0, 200);
	try {
		message = JSON.parse(res.text).message ?? message;
	} catch { /* 本文が JSON でない */ }
	return new GitHubError(`GitHub ${res.status}: ${message}`, res.status);
}

function headerNumber(value: string | null): number | undefined {
	if (value === null || value.trim() === '') {
		return undefined;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * 上限による拒否かどうか（本体の classifyGitHubHttpRateLimit と同じ判定）。
 * 「Rate Limit Exceeded」の一般的な文言は、上限と関係の無い 403 にも付くので、それだけでは上限とみなさない。
 */
export function classifyRateLimit(res: { status: number; headers: Headers }, body: string): 'primary' | 'secondary' | undefined {
	if (res.status !== 403 && res.status !== 429) {
		return undefined;
	}
	if (res.headers.get('x-github-secondary-rate-limited')?.toLowerCase() === 'true' || /\bsecondary rate limit\b|\babuse detection mechanism\b/i.test(body)) {
		return 'secondary';
	}
	const remaining = headerNumber(res.headers.get('x-ratelimit-remaining'));
	if (res.status === 429 || remaining === 0 || headerNumber(res.headers.get('retry-after')) !== undefined || remaining === undefined && /\bAPI rate limit exceeded\b/i.test(body)) {
		return 'primary';
	}
	return undefined;
}
