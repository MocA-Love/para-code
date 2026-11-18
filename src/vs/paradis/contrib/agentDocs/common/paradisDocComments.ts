/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメント（サイドカー）の形と、ウィンドウ ⇄ shared process のチャネルの決まり。
//
// サイドカーは `<利用者データ>/paradis-docs/comments/<台帳のキーの SHA-256>.json`。書くのは shared process の
// コメントの保存係だけで、ウィンドウはチャネルで頼む。キーは台帳と同じ（接続先の印＋正規化した絶対パス、
// {@link paradisDocKey}）なので、資料のツールは台帳の 1 件からそのままコメントへ辿れる。
//
// 1 件のコメントは「スレッド」で持つ（回答と追記を同じ場所に足すため。届け方と回答は後の段で足す）。
// 本文はユーザーがワークベンチの欄に打ったものだけで、プレビューのページからは受け取らない
// （ページのスクリプトが書いた文がユーザーのコメントとして届かないようにするため。paradisDocCommentLayer.ts の冒頭）。

import { IParadisDocAnchor } from './paradisDocCommentAnchor.js';
import { paradisDocKind, paradisNormalizeDocPath } from './paradisAgentDocs.js';

/** ウィンドウから shared process のコメントの保存係へ頼むチャネル。 */
export const PARADIS_DOC_COMMENTS_CHANNEL = 'paradisDocComments';
/** 資料のコメントを読む。引数は `[hostId, path]`。 */
export const PARADIS_DOC_COMMENTS_GET_METHOD = 'get';
/** コメントを足す。引数は `[hostId, path, IParadisDocCommentDraft]`。足したスレッドを返す。 */
export const PARADIS_DOC_COMMENTS_ADD_METHOD = 'add';
/** プレビューが当て直した結果を書く。引数は `[hostId, path, Record<id, place>]`。 */
export const PARADIS_DOC_COMMENTS_SET_PLACES_METHOD = 'setPlaces';
/** コメントが変わった資料の知らせ（`{ hostId, path }`）。 */
export const PARADIS_DOC_COMMENTS_CHANGED_EVENT = 'onDidChange';

/** 1 件の本文の上限（文字）。 */
export const PARADIS_DOC_COMMENT_TEXT_MAX = 20_000;
/** 引用の上限（文字）。 */
export const PARADIS_DOC_COMMENT_QUOTE_MAX = 4_000;
/** 前後の文脈・見出しの上限（文字）。 */
const CONTEXT_MAX = 200;
const SELECTOR_MAX = 2_000;
/** 1 つの資料のスレッドの上限。 */
export const PARADIS_DOC_COMMENT_MAX_THREADS = 500;
/** 1 つのスレッドの書き込みの上限。 */
const MAX_MESSAGES = 200;

/**
 * 当て直しの結果。`found`: 引用がそのまま 1 か所に見つかった。`changed`: 引用は書き換わっているが場所は決められた。
 * `ambiguous`: 同じ文が複数あり決めきれなかった（先頭に付けている）。`lost`: 位置が分からない。
 */
export type ParadisDocCommentPlace = 'found' | 'changed' | 'ambiguous' | 'lost';
const PLACES: ReadonlySet<string> = new Set<ParadisDocCommentPlace>(['found', 'changed', 'ambiguous', 'lost']);

/** スレッドの状態。この段で作るのは `queued`（届け待ち）だけ。残りは届け方の段で使う。 */
export type ParadisDocCommentState = 'queued' | 'delivered' | 'answered' | 'resolved' | 'undeliverable';
const STATES: ReadonlySet<string> = new Set<ParadisDocCommentState>(['queued', 'delivered', 'answered', 'resolved', 'undeliverable']);

/** スレッドの位置（当て直しの結果つき）。 */
export interface IParadisDocCommentAnchor extends IParadisDocAnchor {
	readonly place?: ParadisDocCommentPlace;
}

export interface IParadisDocCommentMessage {
	readonly by: 'user' | 'agent';
	readonly text: string;
	readonly at: number;
}

export interface IParadisDocCommentThread {
	/** 全資料で一意（`c-` で始まる）。 */
	readonly id: string;
	readonly startedBy: 'user' | 'agent';
	readonly anchor: IParadisDocCommentAnchor;
	readonly state: ParadisDocCommentState;
	readonly messages: readonly IParadisDocCommentMessage[];
	readonly createdAt: number;
}

/** サイドカー 1 つの中身。 */
export interface IParadisDocCommentSidecar {
	readonly hostId: string;
	readonly path: string;
	readonly threads: readonly IParadisDocCommentThread[];
}

/** ウィンドウが頼む、新しいコメント。 */
export interface IParadisDocCommentDraft {
	readonly anchor: IParadisDocAnchor;
	readonly text: string;
}

/** コメントが変わった資料。 */
export interface IParadisDocCommentsChange {
	readonly hostId: string;
	readonly path: string;
}

const HOST_ID_PATTERN = /^[A-Za-z0-9._-]{0,64}$/;
const THREAD_ID_PATTERN = /^c-[a-z0-9]{6,32}$/;

function isTime(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readText(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length <= max ? value : undefined;
}

/** 資料の場所（接続先の印と絶対パス）を確かめる。資料（html・md）でなければ undefined。 */
export function paradisReadDocCommentTarget(hostId: unknown, path: unknown): IParadisDocCommentsChange | undefined {
	const normalized = paradisNormalizeDocPath(path);
	if (typeof hostId !== 'string' || !HOST_ID_PATTERN.test(hostId) || normalized === undefined || paradisDocKind(normalized) === undefined) {
		return undefined;
	}
	return { hostId, path: normalized };
}

/** 位置を確かめる。引用が無い・長すぎるものは undefined。 */
export function paradisReadDocAnchor(value: unknown): IParadisDocCommentAnchor | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const anchor = value as Record<string, unknown>;
	const quote = readText(anchor.quote, PARADIS_DOC_COMMENT_QUOTE_MAX);
	if (quote === undefined || quote.trim().length === 0) {
		return undefined;
	}
	const selector = readText(anchor.selector, SELECTOR_MAX);
	const heading = readText(anchor.heading, CONTEXT_MAX);
	const before = readText(anchor.before, CONTEXT_MAX);
	const after = readText(anchor.after, CONTEXT_MAX);
	const place = typeof anchor.place === 'string' && PLACES.has(anchor.place) ? anchor.place as ParadisDocCommentPlace : undefined;
	return {
		...(selector ? { selector } : {}),
		...(heading ? { heading } : {}),
		quote,
		...(before ? { before } : {}),
		...(after ? { after } : {}),
		...(place !== undefined ? { place } : {}),
	};
}

/** ウィンドウから届いた新しいコメントを確かめる。本文が空・長すぎるものは undefined。 */
export function paradisReadDocCommentDraft(value: unknown): IParadisDocCommentDraft | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const draft = value as Record<string, unknown>;
	const text = readText(draft.text, PARADIS_DOC_COMMENT_TEXT_MAX)?.trim();
	const anchor = paradisReadDocAnchor(draft.anchor);
	if (!text || anchor === undefined) {
		return undefined;
	}
	// 当て直しの結果はプレビューが後から書く
	const { place: _place, ...rest } = anchor;
	return { anchor: rest, text };
}

/** プレビューが書く当て直しの結果を確かめる（形の違う件は捨てる）。 */
export function paradisReadDocCommentPlaces(value: unknown): ReadonlyMap<string, ParadisDocCommentPlace> {
	const places = new Map<string, ParadisDocCommentPlace>();
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return places;
	}
	for (const [id, place] of Object.entries(value).slice(0, PARADIS_DOC_COMMENT_MAX_THREADS)) {
		if (THREAD_ID_PATTERN.test(id) && typeof place === 'string' && PLACES.has(place)) {
			places.set(id, place as ParadisDocCommentPlace);
		}
	}
	return places;
}

function parseMessage(value: unknown): IParadisDocCommentMessage | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const message = value as Record<string, unknown>;
	const text = readText(message.text, PARADIS_DOC_COMMENT_TEXT_MAX);
	if ((message.by !== 'user' && message.by !== 'agent') || text === undefined || !isTime(message.at)) {
		return undefined;
	}
	return { by: message.by, text, at: message.at };
}

function parseThread(value: unknown): IParadisDocCommentThread | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const thread = value as Record<string, unknown>;
	const anchor = paradisReadDocAnchor(thread.anchor);
	const messages = Array.isArray(thread.messages) ? thread.messages.slice(0, MAX_MESSAGES).map(parseMessage).filter((message): message is IParadisDocCommentMessage => message !== undefined) : [];
	if (typeof thread.id !== 'string' || !THREAD_ID_PATTERN.test(thread.id) || (thread.startedBy !== 'user' && thread.startedBy !== 'agent')
		|| anchor === undefined || typeof thread.state !== 'string' || !STATES.has(thread.state) || !isTime(thread.createdAt) || messages.length === 0) {
		return undefined;
	}
	return { id: thread.id, startedBy: thread.startedBy, anchor, state: thread.state as ParadisDocCommentState, messages, createdAt: thread.createdAt };
}

/** サイドカーの中身を読む。壊れた件は捨て、全体が読めない・別の資料のものなら空にする。 */
export function paradisParseDocCommentSidecar(text: string | undefined, hostId: string, path: string): IParadisDocCommentSidecar {
	const empty: IParadisDocCommentSidecar = { hostId, path, threads: [] };
	if (text === undefined) {
		return empty;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return empty;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return empty;
	}
	const file = parsed as Record<string, unknown>;
	// ファイル名は SHA-256 なので、別の資料のものが置かれていたら使わない
	if (file.hostId !== hostId || file.path !== path || !Array.isArray(file.threads)) {
		return empty;
	}
	const seen = new Set<string>();
	const threads: IParadisDocCommentThread[] = [];
	for (const item of file.threads.slice(0, PARADIS_DOC_COMMENT_MAX_THREADS)) {
		const thread = parseThread(item);
		if (thread !== undefined && !seen.has(thread.id)) {
			seen.add(thread.id);
			threads.push(thread);
		}
	}
	return { hostId, path, threads };
}

/** サイドカーへ書く中身。 */
export function paradisSerializeDocCommentSidecar(sidecar: IParadisDocCommentSidecar): string {
	return JSON.stringify({ version: 1, hostId: sidecar.hostId, path: sidecar.path, threads: sidecar.threads }, null, '\t');
}

/** 新しいスレッド（ユーザーが書いた 1 件）。 */
export function paradisNewDocCommentThread(id: string, draft: IParadisDocCommentDraft, now: number): IParadisDocCommentThread {
	return { id, startedBy: 'user', anchor: draft.anchor, state: 'queued', messages: [{ by: 'user', text: draft.text, at: now }], createdAt: now };
}

/** 当て直しの結果を反映する。変わらなければ同じものを返す。 */
export function paradisWithDocCommentPlaces(sidecar: IParadisDocCommentSidecar, places: ReadonlyMap<string, ParadisDocCommentPlace>): IParadisDocCommentSidecar {
	let changed = false;
	const threads = sidecar.threads.map(thread => {
		const place = places.get(thread.id);
		if (place === undefined || thread.anchor.place === place) {
			return thread;
		}
		changed = true;
		return { ...thread, anchor: { ...thread.anchor, place } };
	});
	return changed ? { ...sidecar, threads } : sidecar;
}
