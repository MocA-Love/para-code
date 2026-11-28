/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペースを作った元の Issue・PR（q.html Q691）。作成の流れが既知のスペースの 1 件（knownWorktrees）に残し、
// Workspaces ビューの行が「作成元」のチップとして出す。保存した値は利用者が手で書き換えられる場所にあるので、
// 読むときは必ず paradisParseWorktreeOrigin を通す。

import { paradisCleanReferenceTitle } from './paradisWorktreeCreate.js';
import { paradisGithubReferenceKey, paradisParseGithubReferenceUrl, ParadisGithubReferenceKind } from '../../../common/paradisIssueDetection.js';

/** 題名の保存の上限（表示はホバーだけなので、長い題名をそのまま台帳へ書かない）。 */
const PARADIS_WORKTREE_ORIGIN_TITLE_MAX_CHARS = 200;

/** スペースの元になった Issue・PR。 */
export interface IParadisWorktreeOrigin {
	readonly kind: ParadisGithubReferenceKind;
	/** github.com の Issue・PR の URL（`paradisParseGithubReferenceUrl` が返す形）。 */
	readonly url: string;
	readonly number: number;
	/** 作ったときに取れていた題名（整形済み）。取れなかったときは無い。 */
	readonly title?: string;
}

/**
 * 保存した値・作成の流れから渡された値を、作成元として使える形にする。github.com の Issue・PR の URL でないもの、
 * 番号や種類が URL と食い違うものは捨てる（押すと外のブラウザで開くので、任意の URL を通さない）。
 */
export function paradisParseWorktreeOrigin(value: unknown): IParadisWorktreeOrigin | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as { kind?: unknown; url?: unknown; number?: unknown; title?: unknown };
	if (typeof candidate.url !== 'string') {
		return undefined;
	}
	const parsed = paradisParseGithubReferenceUrl(candidate.url);
	if (!parsed || (candidate.kind !== undefined && candidate.kind !== parsed.kind) || (candidate.number !== undefined && candidate.number !== parsed.number)) {
		return undefined;
	}
	const title = typeof candidate.title === 'string'
		? Array.from(paradisCleanReferenceTitle(candidate.title)).slice(0, PARADIS_WORKTREE_ORIGIN_TITLE_MAX_CHARS).join('')
		: '';
	return { kind: parsed.kind, url: parsed.url, number: parsed.number, ...(title ? { title } : {}) };
}

/**
 * 行に「作成元」のチップとして出す作成元。PR から作ったスペースで、ブランチから引いた PR のチップが同じ PR を
 * 出しているときは二重に出さない（`pullRequestNumber` は今の PR のチップの番号）。
 */
export function paradisWorktreeOriginToShow(origin: IParadisWorktreeOrigin | undefined, pullRequestNumber: number | undefined): IParadisWorktreeOrigin | undefined {
	if (!origin || (origin.kind === 'pr' && origin.number === pullRequestNumber)) {
		return undefined;
	}
	return origin;
}

/** 会話から拾った Issue の URL から、作成元と同じ Issue を除く（同じ Issue を「作成元」と「件数」で二度数えない）。 */
export function paradisIssueUrlsWithoutOrigin(issueUrls: readonly string[], origin: IParadisWorktreeOrigin | undefined): readonly string[] {
	const originReference = origin ? paradisParseGithubReferenceUrl(origin.url) : undefined;
	if (!originReference) {
		return issueUrls;
	}
	const originKey = paradisGithubReferenceKey(originReference);
	const filtered = issueUrls.filter(url => {
		const reference = paradisParseGithubReferenceUrl(url);
		return !reference || paradisGithubReferenceKey(reference) !== originKey;
	});
	return filtered.length === issueUrls.length ? issueUrls : filtered;
}
