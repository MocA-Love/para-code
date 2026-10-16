// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFile } from 'node:child_process';
import type { ITaskBoardRateLimit } from '@engine/paradisTaskBoard.js';

/*
 * GitHub の API を呼ぶ口（Q348 A）。
 * - トークンは `gh auth token` で 1 度だけ受け取り、メモリにだけ持つ（ファイルにもログにも書かない）
 * - 呼び出しはここ 1 か所に集め、同時実行と 1 分あたりの回数を絞る
 * - REST は ETag を覚え、変化が無い応答（304）は残量を消費しない
 * - 残量が少なくなったら、リセットまで呼ばずに待つ（エラーにする）
 */

const API = 'https://api.github.com';
const MAX_CONCURRENT = 4;
const PER_MINUTE = 90;
const LOW_WATER = 150;
const TIMEOUT_MS = 20000;

export class GitHubError extends Error {
	constructor(message: string, readonly status?: number, readonly kind: 'auth' | 'budget' | 'network' | 'api' | 'graphql' = 'api') {
		super(message);
		this.name = 'GitHubError';
	}
}

export type TokenProvider = () => Promise<string>;

/** gh CLI からトークンを受け取る。gh が無い・未ログインなら失敗する。 */
export function ghTokenProvider(): TokenProvider {
	return () => new Promise((resolve, reject) => {
		execFile('gh', ['auth', 'token'], { timeout: 10000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout) => {
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

/** そのまま取ってよい画像の置き場（トークンは付けない）。 */
const PUBLIC_IMAGE_HOSTS = new Set(['private-user-images.githubusercontent.com', 'user-images.githubusercontent.com', 'avatars.githubusercontent.com', 'camo.githubusercontent.com', 'objects.githubusercontent.com']);
const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_CACHE_BYTES = 80 * 1024 * 1024;

interface ICached {
	readonly etag: string;
	readonly body: unknown;
}

export interface IGitHubClientOptions {
	readonly token: TokenProvider;
	readonly fetch?: FetchLike;
	readonly now?: () => number;
}

export class GitHubClient {
	private token: string | undefined;
	private readonly etags = new Map<string, ICached>();
	private active = 0;
	private readonly waiters: (() => void)[] = [];
	private readonly recent: number[] = [];
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	rest: ITaskBoardRateLimit | undefined;
	private readonly images = new Map<string, { type: string; body: Buffer }>();
	private imageBytes = 0;
	/** 二次的な流量制限（短時間に呼びすぎ）で待つよう言われた時刻。 */
	private cooldownUntil = 0;
	graphqlLimit: ITaskBoardRateLimit | undefined;
	requestCount = 0;
	login: string | undefined;
	avatarUrl: string | undefined;

	constructor(private readonly options: IGitHubClientOptions) {
		this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
		this.now = options.now ?? Date.now;
	}

	async init(): Promise<string> {
		this.token = await this.options.token();
		const data = await this.graphql<{ viewer: { login: string; avatarUrl?: string } }>('query { viewer { login avatarUrl } }');
		this.login = data.viewer.login;
		this.avatarUrl = data.viewer.avatarUrl;
		return this.login;
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

	private checkBudget(limit: ITaskBoardRateLimit | undefined): void {
		if (this.now() < this.cooldownUntil) {
			throw new GitHubError(`GitHub asked us to slow down; waiting until ${new Date(this.cooldownUntil).toISOString()}`, undefined, 'budget');
		}
		if (limit && limit.remaining < LOW_WATER && this.now() < limit.resetAt) {
			throw new GitHubError(`GitHub API budget is low (${limit.remaining} left); waiting until ${new Date(limit.resetAt).toISOString()}`, undefined, 'budget');
		}
	}

	private readLimit(headers: { get(name: string): string | null }): ITaskBoardRateLimit | undefined {
		const remaining = Number(headers.get('x-ratelimit-remaining'));
		const limit = Number(headers.get('x-ratelimit-limit'));
		const reset = Number(headers.get('x-ratelimit-reset'));
		if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !headers.get('x-ratelimit-remaining')) {
			return undefined;
		}
		return { remaining, limit, resetAt: reset * 1000 };
	}

	private async send(method: string, url: string, body: string | undefined, extra: Record<string, string> = {}): Promise<{ status: number; text: string; headers: { get(name: string): string | null } }> {
		if (!this.token) {
			this.token = await this.options.token();
		}
		await this.acquire();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			this.requestCount++;
			const res = await this.fetchImpl(url, {
				method,
				headers: {
					'authorization': `Bearer ${this.token}`,
					'accept': 'application/vnd.github+json',
					'x-github-api-version': '2022-11-28',
					'user-agent': 'para-code-taskboard',
					...(body ? { 'content-type': 'application/json' } : {}),
					...extra,
				},
				body,
				signal: controller.signal,
			});
			const text = res.status === 304 ? '' : await res.text();
			if (res.status === 401) {
				this.token = undefined;
				throw new GitHubError('GitHub rejected the token (401). Run `gh auth login` again.', 401, 'auth');
			}
			if (res.status === 429 || (res.status === 403 && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0'))) {
				const retryAfter = Number(res.headers.get('retry-after'));
				const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
				this.cooldownUntil = Number.isFinite(retryAfter) && retryAfter > 0 ? this.now() + retryAfter * 1000 : Number.isFinite(reset) && reset > this.now() ? reset : this.now() + 60000;
				throw new GitHubError(`GitHub rate limit (${res.status}); waiting until ${new Date(this.cooldownUntil).toISOString()}`, res.status, 'budget');
			}
			return { status: res.status, text, headers: res.headers };
		} catch (err) {
			if (err instanceof GitHubError) {
				throw err;
			}
			throw new GitHubError(`GitHub request failed: ${(err as Error).message}`, undefined, 'network');
		} finally {
			clearTimeout(timer);
			this.release();
		}
	}

	async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
		this.checkBudget(this.graphqlLimit);
		const res = await this.send('POST', `${API}/graphql`, JSON.stringify({ query, variables }));
		const limit = this.readLimit(res.headers);
		if (limit) {
			this.graphqlLimit = limit;
		}
		let json: { data?: T; errors?: { message: string; type?: string }[] };
		try {
			json = JSON.parse(res.text);
		} catch {
			throw new GitHubError(`GitHub GraphQL returned ${res.status}`, res.status);
		}
		if (res.status >= 400 && !json.data) {
			throw new GitHubError(`GitHub GraphQL ${res.status}: ${json.errors?.[0]?.message ?? res.text.slice(0, 200)}`, res.status);
		}
		if (json.errors?.length && !json.data) {
			throw new GitHubError(json.errors.map(e => e.message).join('; '), res.status, 'graphql');
		}
		if (json.errors?.length) {
			// 部分的な失敗（権限の無い項目など）はデータを返し、理由は警告として残す
			console.warn('[taskboard] GraphQL partial errors:', json.errors.map(e => e.message).join('; '));
		}
		return json.data as T;
	}

	/** REST の POST で、本文を文字列のまま返す（/markdown など）。 */
	async postText(pathAndQuery: string, body: unknown): Promise<string> {
		this.checkBudget(this.rest);
		const res = await this.send('POST', `${API}${pathAndQuery}`, JSON.stringify(body));
		const limit = this.readLimit(res.headers);
		if (limit) {
			this.rest = limit;
		}
		if (res.status >= 400) {
			throw new GitHubError(`GitHub ${res.status}: ${res.text.slice(0, 200)}`, res.status);
		}
		return res.text;
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
				const body = await this.sendBinary(`${API}/repos/${owner}/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`, true).catch(() => undefined);
				if (body) {
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

	private async sendBinary(url: string, raw: boolean): Promise<Buffer | undefined> {
		this.checkBudget(this.rest);
		if (!this.token) {
			this.token = await this.options.token();
		}
		await this.acquire();
		try {
			this.requestCount++;
			const res = await this.fetchImpl(url, { method: 'GET', headers: { 'authorization': `Bearer ${this.token}`, 'accept': raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'para-code-taskboard' }, redirect: 'follow' });
			const limit = this.readLimit(res.headers);
			if (limit) {
				this.rest = limit;
			}
			if (res.status !== 200 || !res.arrayBuffer) {
				return undefined;
			}
			const body = Buffer.from(await res.arrayBuffer());
			return body.length <= MAX_IMAGE_BYTES ? body : undefined;
		} finally {
			this.release();
		}
	}

	/** REST の GET。ETag が一致したら覚えた本文を返す。 */
	async get<T>(pathAndQuery: string): Promise<T> {
		this.checkBudget(this.rest);
		const url = `${API}${pathAndQuery}`;
		const cached = this.etags.get(url);
		const res = await this.send('GET', url, undefined, cached ? { 'if-none-match': cached.etag } : {});
		const limit = this.readLimit(res.headers);
		if (limit) {
			this.rest = limit;
		}
		if (res.status === 304 && cached) {
			return cached.body as T;
		}
		if (res.status >= 400) {
			let message = res.text.slice(0, 200);
			try {
				message = JSON.parse(res.text).message ?? message;
			} catch { /* 本文が JSON でない */ }
			throw new GitHubError(`GitHub ${res.status}: ${message}`, res.status);
		}
		const body = JSON.parse(res.text) as T;
		const etag = res.headers.get('etag');
		if (etag) {
			this.etags.set(url, { etag, body });
			if (this.etags.size > 500) {
				this.etags.delete(this.etags.keys().next().value!);
			}
		}
		return body;
	}
}
