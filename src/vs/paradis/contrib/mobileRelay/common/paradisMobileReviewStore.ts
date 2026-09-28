/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisMobileReviewMark } from './paradisMobileDiffReview.js';

/**
 * モバイルの差分レビューの記録を PC に保存する形（Orca W2-14）。スペースのメモと同じく、ウィンドウの
 * WORKSPACE ストレージに1つのキーで置く。キーはスペース（scm 要求の `ws`）。
 *
 * モバイルは信用しない相手なので、読むときも書くときも形と上限を確かめる（壊れた1件で全部を捨てない）。
 */

export const PARADIS_MOBILE_REVIEW_STORAGE_KEY = 'paradis.mobileRelay.diffReview.v1';

/** 保存するスペースの数の上限。超えたら、いちばん長く触っていないスペースから捨てる。 */
export const PARADIS_MOBILE_REVIEW_MAX_SPACES = 32;
/** 1スペースの確認済みの印の上限。超えたら古く確認したものから捨てる。 */
export const PARADIS_MOBILE_REVIEW_MAX_MARKS = 500;
/** 1回の要求で変えられる印の数。 */
export const PARADIS_MOBILE_REVIEW_MAX_MARKS_PER_REQUEST = 500;
const MAX_PATH_LENGTH = 1_024;
const MAX_KEY_LENGTH = 1_024;
const IDENTITY_PATTERN = /^[0-9a-f]{1,64}$/;
/** 全体の上限（JSON の文字数）。超えたら古いスペースから捨てる。 */
const MAX_STORAGE_LENGTH = 2_000_000;

/** 1スペースぶんの記録。 */
export interface IParadisMobileReviewSpace {
	readonly marks: Readonly<Record<string, IParadisMobileReviewMark>>;
	/** 最後に変えた時刻。スペースが多すぎるときに古いものから捨てるのに使う。 */
	readonly updatedAt: number;
}

export type ParadisMobileReviewStore = ReadonlyMap<string, IParadisMobileReviewSpace>;

const EMPTY_SPACE: IParadisMobileReviewSpace = { marks: {}, updatedAt: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTime(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 相対パスとして受け付けるか（空・長すぎる・NUL を含む・絶対パスは拒む）。 */
export function paradisIsReviewPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes('\0') && !value.startsWith('/');
}

function parseMark(value: unknown): IParadisMobileReviewMark | undefined {
	if (!isRecord(value) || typeof value.identity !== 'string' || !IDENTITY_PATTERN.test(value.identity)) {
		return undefined;
	}
	const reviewedAt = validTime(value.reviewedAt);
	return reviewedAt !== undefined ? { identity: value.identity, reviewedAt } : undefined;
}

function parseMarks(value: unknown): Record<string, IParadisMobileReviewMark> {
	const marks: Record<string, IParadisMobileReviewMark> = {};
	if (!isRecord(value)) {
		return marks;
	}
	let count = 0;
	for (const [path, raw] of Object.entries(value)) {
		const mark = paradisIsReviewPath(path) ? parseMark(raw) : undefined;
		if (mark !== undefined && count < PARADIS_MOBILE_REVIEW_MAX_MARKS) {
			marks[path] = mark;
			count++;
		}
	}
	return marks;
}

/** 保存された全体を読む。読めない値は空として扱う（スペース単位・印単位で壊れたものだけ飛ばす）。 */
export function paradisParseMobileReviewStore(raw: string | undefined): Map<string, IParadisMobileReviewSpace> {
	const store = new Map<string, IParadisMobileReviewSpace>();
	if (raw === undefined || raw.length > MAX_STORAGE_LENGTH) {
		return store;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return store;
	}
	if (!isRecord(value)) {
		return store;
	}
	for (const [ws, entry] of Object.entries(value)) {
		if (store.size >= PARADIS_MOBILE_REVIEW_MAX_SPACES) {
			break;
		}
		if (ws.length === 0 || ws.length > MAX_KEY_LENGTH || !isRecord(entry)) {
			continue;
		}
		store.set(ws, { marks: parseMarks(entry.marks), updatedAt: validTime(entry.updatedAt) ?? 0 });
	}
	return store;
}

/** 上限に収まるよう古いスペースから捨てて JSON にする。 */
export function paradisSerializeMobileReviewStore(store: ParadisMobileReviewStore): string {
	const spaces = [...store].filter(([, space]) => Object.keys(space.marks).length > 0)
		.sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
		.slice(0, PARADIS_MOBILE_REVIEW_MAX_SPACES);
	let serialized = JSON.stringify(Object.fromEntries(spaces));
	while (serialized.length > MAX_STORAGE_LENGTH && spaces.length > 0) {
		spaces.pop();
		serialized = JSON.stringify(Object.fromEntries(spaces));
	}
	return serialized;
}

export function paradisMobileReviewSpace(store: ParadisMobileReviewStore, ws: string): IParadisMobileReviewSpace {
	return store.get(ws) ?? EMPTY_SPACE;
}

/** 印を1件変える要求。`identity` が null なら外す。 */
export interface IParadisMobileReviewMarkChange {
	readonly path: string;
	readonly identity: string | null;
}

/** `reviewSet` の `marks` を読む。形が違えば undefined（要求ごと受け付けない）。 */
export function paradisParseMobileReviewMarkChanges(value: unknown): IParadisMobileReviewMarkChange[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > PARADIS_MOBILE_REVIEW_MAX_MARKS_PER_REQUEST) {
		return undefined;
	}
	const changes: IParadisMobileReviewMarkChange[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || !paradisIsReviewPath(candidate.path)) {
			return undefined;
		}
		if (candidate.identity === null) {
			changes.push({ path: candidate.path, identity: null });
		} else if (typeof candidate.identity === 'string' && IDENTITY_PATTERN.test(candidate.identity)) {
			changes.push({ path: candidate.path, identity: candidate.identity });
		} else {
			return undefined;
		}
	}
	return changes;
}

/** 印を変えたスペースを返す。上限を超えたら古く確認したものから捨てる。 */
export function paradisApplyMobileReviewMarkChanges(space: IParadisMobileReviewSpace, changes: readonly IParadisMobileReviewMarkChange[], now: number): IParadisMobileReviewSpace {
	const marks: Record<string, IParadisMobileReviewMark> = { ...space.marks };
	for (const change of changes) {
		if (change.identity === null) {
			delete marks[change.path];
		} else {
			marks[change.path] = { identity: change.identity, reviewedAt: now };
		}
	}
	const entries = Object.entries(marks);
	const kept = entries.length <= PARADIS_MOBILE_REVIEW_MAX_MARKS
		? marks
		: Object.fromEntries(entries.sort(([, a], [, b]) => b.reviewedAt - a.reviewedAt).slice(0, PARADIS_MOBILE_REVIEW_MAX_MARKS));
	return { marks: kept, updatedAt: now };
}

/**
 * いまの変更の一覧に無いパスの印を外す（コミット・破棄されたファイル）。変わらなければ同じものを返す。
 * `changedPaths` は status のパス（リネームは新しい側）。
 */
export function paradisPruneMobileReviewSpace(space: IParadisMobileReviewSpace, changedPaths: ReadonlySet<string>): IParadisMobileReviewSpace {
	const entries = Object.entries(space.marks);
	const kept = entries.filter(([path]) => changedPaths.has(path));
	return kept.length === entries.length ? space : { marks: Object.fromEntries(kept), updatedAt: space.updatedAt };
}
