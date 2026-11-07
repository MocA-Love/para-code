/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面（GitHub の Issue・PR の一覧）の型と、検索の文字列の組み立て。環境に依存しない純粋な部分。
// 取得は shared process（node/paradisTasksGithub.sharedProcess.ts）が手元の gh で行い、画面
// （electron-browser/paradisTasksEditor.ts）はチャネル越しに結果だけを受け取る。トークンは画面へ渡さない。

import { paradisNormalizeRemoteUrl } from '../../agentActivity/common/paradisRepoIdentity.js';

export const PARADIS_TASKS_GITHUB_CHANNEL = 'paradisTasksGithub';

export type ParadisTasksMode = 'issue' | 'pr';

/** 一覧に並べる 1 件（Issue か PR）。GraphQL の応答から必要な欄だけを写したもの。 */
export interface IParadisTasksItem {
	readonly kind: ParadisTasksMode;
	/** `owner/name`（GitHub の表記のまま）。 */
	readonly repository: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
	/** Issue: OPEN / CLOSED、PR: OPEN / CLOSED / MERGED。 */
	readonly state: string;
	/** Issue を閉じた理由（COMPLETED / NOT_PLANNED / DUPLICATE）。 */
	readonly stateReason?: string;
	readonly isDraft?: boolean;
	/** PR のレビューの判定（APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED）。 */
	readonly reviewDecision?: string;
	readonly author?: string;
	readonly assignees: readonly IParadisTasksUser[];
	readonly labels: readonly IParadisTasksLabel[];
	/** ISO 8601。 */
	readonly updatedAt: string;
	readonly comments?: number;
}

export interface IParadisTasksUser {
	readonly login: string;
	readonly avatarUrl?: string;
}

export interface IParadisTasksLabel {
	readonly name: string;
	/** 16 進 6 桁（`#` なし）。 */
	readonly color: string;
}

export interface IParadisTasksSearchRequest {
	readonly mode: ParadisTasksMode;
	/** `owner/name` の並び。空なら検索しない。 */
	readonly repositories: readonly string[];
	/** 人が書いた検索の文字列（`is:issue is:open` など）。`repo:` は {@link repositories} で付け直す。 */
	readonly query: string;
	/** 続きを読むときのカーソル。 */
	readonly after?: string;
	/** キャッシュを使わずに読み直す（更新ボタン）。同じ要求が飛んでいる間は相乗りする。 */
	readonly force?: boolean;
}

export interface IParadisTasksSearchResult {
	readonly items: readonly IParadisTasksItem[];
	/** GitHub の検索が数えた全件（1,000 件で頭打ち）。 */
	readonly total: number;
	readonly endCursor?: string;
	readonly hasNextPage: boolean;
	/** 応答を GitHub から受け取った時刻（キャッシュから返したときもその時刻）。 */
	readonly fetchedAt: number;
	readonly rateLimit?: IParadisTasksRateLimit;
}

export interface IParadisTasksRateLimit {
	readonly remaining: number;
	readonly limit: number;
	/** ミリ秒エポック。 */
	readonly resetAt: number;
}

/** 取得に失敗した理由。画面はこれで案内の文を選ぶ。 */
export type ParadisTasksErrorKind = 'no-gh' | 'auth' | 'rate-limited' | 'timeout' | 'failed';

export interface IParadisTasksError {
	readonly kind: ParadisTasksErrorKind;
	readonly message: string;
	/** rate-limited のとき、再開する時刻（ミリ秒エポック）。 */
	readonly retryAt?: number;
}

/** 取得口の応答。失敗は例外にせず理由を返す（画面が案内の文を選べるように）。 */
export type ParadisTasksResponse<T> =
	| { readonly ok: true; readonly result: T }
	| { readonly ok: false; readonly error: IParadisTasksError };

export type ParadisTasksSearchResponse = ParadisTasksResponse<IParadisTasksSearchResult>;

/** Issue・PR の検索の口。プロジェクトの口を足したものは common/paradisTasksProjects.ts の IParadisTasksGithubService。 */
export interface IParadisTasksSearchService {
	search(request: IParadisTasksSearchRequest): Promise<ParadisTasksSearchResponse>;
}

/** プリセット（パネルの左上のボタン）。押すと検索の文字列をこの値に置き換える。 */
export interface IParadisTasksPreset {
	readonly id: string;
	readonly query: string;
}

/** Orca と同じ既定の検索（`shared/task-preset-query.ts`）。 */
export const PARADIS_TASKS_PRESETS: { readonly [mode in ParadisTasksMode]: readonly IParadisTasksPreset[] } = {
	issue: [
		{ id: 'open', query: 'is:issue is:open' },
		{ id: 'assigned', query: 'is:issue is:open assignee:@me' },
	],
	pr: [
		{ id: 'open', query: 'is:pr is:open' },
		{ id: 'mine', query: 'is:pr is:open author:@me' },
		{ id: 'review', query: 'is:pr is:open review-requested:@me' },
	],
};

/** 1 回の検索で読む件数。GraphQL の検索の点数は件数にほぼ比例しないので、表 1 画面分を読む。 */
export const PARADIS_TASKS_PAGE_SIZE = 30;

/**
 * 1 回の検索に載せるリポジトリの上限。GitHub の検索の文字列は 256 文字までなので、`repo:owner/name` を
 * 並べても収まる数にする。リポジトリの数だけ要求を増やさず、いつも 1 回で読むための上限でもある。
 */
export const PARADIS_TASKS_MAX_REPOSITORIES = 5;

const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` の形か（検索の文字列へそのまま埋めるので、空白や引用符を含むものは断る）。 */
export function paradisTasksIsRepositoryName(value: string): boolean {
	return OWNER_REPO.test(value) && !value.endsWith('.git');
}

/**
 * git の remote の URL から github.com の `owner/name` を取る。github.com 以外（GitHub Enterprise・GitLab など）と
 * 読めない形は undefined。大文字小文字は remote に書いてあるまま残す（GitHub は区別しないが、画面ではこの表記を出す）。
 */
export function paradisTasksGithubRepositoryFromRemote(url: string): string | undefined {
	const normalized = paradisNormalizeRemoteUrl(url);
	if (!normalized || !normalized.startsWith('github.com/')) {
		return undefined;
	}
	// 正規化は小文字にするので、元の URL から同じ位置の表記を拾い直す
	const tail = normalized.slice('github.com/'.length);
	const original = /(?<path>[^/:]+\/[^/]+?)(?:\.git)?\/*$/.exec(url.trim().replace(/\\/g, '/'))?.groups?.path;
	const name = original && original.toLowerCase() === tail ? original : tail;
	return paradisTasksIsRepositoryName(name) ? name : undefined;
}

/**
 * 人が書いた検索の文字列に、モード（`is:issue` / `is:pr`）とリポジトリ（`repo:`）を付けて GitHub の検索へ渡す形にする。
 * 人が書いた `repo:` `org:` `user:` は外す（選んだリポジトリの外を読まない）。`is:issue` と `is:pr` の取り違えは
 * モードの側に揃える。
 */
export function paradisTasksBuildSearchQuery(mode: ParadisTasksMode, query: string, repositories: readonly string[]): string {
	const kept: string[] = [];
	for (const token of paradisTasksTokenize(query)) {
		const lower = token.toLowerCase();
		if (/^-?(repo|org|user):/.test(lower)) {
			continue;
		}
		if (lower === 'is:issue' || lower === 'is:pr' || lower === 'is:pull-request' || lower === 'type:issue' || lower === 'type:pr') {
			continue;
		}
		kept.push(token);
	}
	const repos = repositories.filter(paradisTasksIsRepositoryName).map(repo => `repo:${repo}`);
	return [mode === 'pr' ? 'is:pr' : 'is:issue', ...kept, ...repos, 'archived:false'].join(' ');
}

/** 空白で区切る。`"..."` で囲んだ語句は 1 つにまとめる（`label:"good first issue"` など）。 */
export function paradisTasksTokenize(query: string): string[] {
	const tokens: string[] = [];
	const pattern = /(?:[^\s"]+|"[^"]*")+/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(query)) !== null) {
		tokens.push(match[0]);
	}
	return tokens;
}

/** 検索の文字列に修飾子（`state:closed` など）があるか。フィルターのメニューの印に使う。 */
export function paradisTasksHasQualifier(query: string, qualifier: string): boolean {
	const wanted = qualifier.toLowerCase();
	return paradisTasksTokenize(query).some(token => token.toLowerCase() === wanted);
}

/**
 * 修飾子を足すか外す。`key:` が同じ修飾子（`is:open` と `is:closed` のように片方しか成り立たないもの）は
 * `exclusiveWith` に並べて渡すと、足すときに外す。
 */
export function paradisTasksToggleQualifier(query: string, qualifier: string, exclusiveWith: readonly string[] = []): string {
	const tokens = paradisTasksTokenize(query);
	const wanted = qualifier.toLowerCase();
	if (tokens.some(token => token.toLowerCase() === wanted)) {
		return tokens.filter(token => token.toLowerCase() !== wanted).join(' ');
	}
	const exclusive = new Set(exclusiveWith.map(value => value.toLowerCase()));
	return [...tokens.filter(token => !exclusive.has(token.toLowerCase())), qualifier].join(' ');
}
