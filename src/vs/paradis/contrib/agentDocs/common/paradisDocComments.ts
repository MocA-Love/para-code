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
// 1 件のコメントは「スレッド」で持つ（回答と追記を同じ場所に足すため）。届け方の状態（delivery）と、エージェントの回答・
// 回答に結び付けた本文の書き込み（edits）も同じスレッドに持つ。
// 本文はユーザーがワークベンチの欄に打ったものだけで、プレビューのページからは受け取らない
// （ページのスクリプトが書いた文がユーザーのコメントとして届かないようにするため。paradisDocCommentLayer.ts の冒頭）。

import { IParadisDocAnchor } from './paradisDocCommentAnchor.js';
import { paradisDocKind, paradisIsDocCommentId, paradisNormalizeDocPath } from './paradisAgentDocs.js';

/** ウィンドウから shared process のコメントの保存係へ頼むチャネル。 */
export const PARADIS_DOC_COMMENTS_CHANNEL = 'paradisDocComments';
/** 資料のコメントを読む。引数は `[hostId, path]`。 */
export const PARADIS_DOC_COMMENTS_GET_METHOD = 'get';
/** コメントを足す。引数は `[hostId, path, IParadisDocCommentDraft]`。足したスレッドを返す。 */
export const PARADIS_DOC_COMMENTS_ADD_METHOD = 'add';
/** プレビューが当て直した結果を書く。引数は `[hostId, path, Record<id, place>]`。 */
export const PARADIS_DOC_COMMENTS_SET_PLACES_METHOD = 'setPlaces';
/**
 * ユーザーがカードで操作する。引数は `[hostId, path, id, ParadisDocCommentUserAction, text?]`。
 * `deliverNow` は、入力欄の中身を確かめられないペインへ、次のターンの終わりを待たずに届ける頼み。
 */
export const PARADIS_DOC_COMMENTS_ACT_METHOD = 'act';
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
/** 1 つの回答に結び付ける本文の書き込みの上限。 */
export const PARADIS_DOC_COMMENT_MAX_EDITS = 50;
/** エージェントの回答の上限（文字）。 */
export const PARADIS_DOC_COMMENT_REPLY_MAX = 4_000;

/**
 * 当て直しの結果。`found`: 引用がそのまま 1 か所に見つかった。`changed`: 引用は書き換わっているが場所は決められた。
 * `ambiguous`: 同じ文が複数あり決めきれなかった（先頭に付けている）。`lost`: 位置が分からない。
 */
export type ParadisDocCommentPlace = 'found' | 'changed' | 'ambiguous' | 'lost';
const PLACES: ReadonlySet<string> = new Set<ParadisDocCommentPlace>(['found', 'changed', 'ambiguous', 'lost']);

/**
 * スレッドの状態。`queued`: 届け待ち（貼った後、届いた知らせを待っている間も含む）、`delivered`: 届いた（エージェントが
 * 入力を受け取った）、`answered`: 回答あり、`resolved`: 解決済み、`undeliverable`: 今は届けられない（持ち主がいない・終了・
 * 状態が分からない。持ち主のペインが動けば届け待ちに戻る）。
 */
export type ParadisDocCommentState = 'queued' | 'delivered' | 'answered' | 'resolved' | 'undeliverable';
const STATES: ReadonlySet<string> = new Set<ParadisDocCommentState>(['queued', 'delivered', 'answered', 'resolved', 'undeliverable']);

/**
 * 届けられない・待っている理由。
 * 待つもの: `working` 作業中、`permission` 許可待ち、`question` 質問待ち、`draft` 入力欄に書きかけがある、
 * `draftUnknown` 入力欄の中身を確かめられない（次のターンの終わりの直後に届ける）、`sending` 同じペインへ前の分を届けている、
 * `screen` ペインの画面に確認が出ている（画面を読めないときも）、`notRunning` ペインの前面でエージェントが動いていない、
 * `waking` 終了した持ち主の会話をユーザーが起こした（CLI の起動を待っている）。
 * 届けられないもの（状態は `undeliverable`）: `noOwner` 持ち主がいない、`ended` 持ち主の会話が終わった、`unknown` 持ち主の
 * 会話が動いているか分からない、`noHooks` 持ち主のペインから状態の知らせが一度も来ていない。
 */
export type ParadisDocDeliveryBlock = 'working' | 'permission' | 'question' | 'draft' | 'draftUnknown' | 'sending' | 'screen' | 'notRunning' | 'waking' | 'noOwner' | 'ended' | 'unknown' | 'noHooks';
const BLOCKS: ReadonlySet<string> = new Set<ParadisDocDeliveryBlock>(['working', 'permission', 'question', 'draft', 'draftUnknown', 'sending', 'screen', 'notRunning', 'waking', 'noOwner', 'ended', 'unknown', 'noHooks']);
const UNDELIVERABLE_BLOCKS: ReadonlySet<ParadisDocDeliveryBlock> = new Set<ParadisDocDeliveryBlock>(['noOwner', 'ended', 'unknown', 'noHooks']);

/** 届けられない理由（待てば届くものではない）か。 */
export function paradisIsDocDeliveryUndeliverable(block: ParadisDocDeliveryBlock | undefined): boolean {
	return block !== undefined && UNDELIVERABLE_BLOCKS.has(block);
}

/** 届け方の記録。 */
export interface IParadisDocCommentDelivery {
	/** ペインへ貼った回数。 */
	readonly attempts: number;
	/** いま待っている・届けられない理由。 */
	readonly blockedBy?: ParadisDocDeliveryBlock;
	/** ペインへ貼った時刻。貼った後は二度と貼らない（追記・開き直しで消える）。 */
	readonly typedAt?: number;
	/** 貼った後に Enter も送ったか。送っていなければ、ユーザーがターミナルで送るのを待つ。 */
	readonly entered?: boolean;
	/** 届いた（エージェントが入力を受け取った）時刻。 */
	readonly deliveredAt?: number;
}

/** 回答に結び付けた、資料への書き込み 1 回。 */
export interface IParadisDocCommentEdit {
	readonly at: number;
	readonly tool: string;
	readonly toolUseId?: string;
}

/** スレッドの位置（当て直しの結果つき）。 */
export interface IParadisDocCommentAnchor extends IParadisDocAnchor {
	readonly place?: ParadisDocCommentPlace;
}

export interface IParadisDocCommentMessage {
	readonly by: 'user' | 'agent';
	readonly text: string;
	readonly at: number;
	/** エージェントの回答のとき、前の回答（無ければ届いた時刻）からこの回答までの資料への書き込み。 */
	readonly edits?: readonly IParadisDocCommentEdit[];
}

export interface IParadisDocCommentThread {
	/** 全資料で一意（`c-` で始まる）。 */
	readonly id: string;
	readonly startedBy: 'user' | 'agent';
	readonly anchor: IParadisDocCommentAnchor;
	readonly state: ParadisDocCommentState;
	readonly messages: readonly IParadisDocCommentMessage[];
	readonly createdAt: number;
	readonly delivery?: IParadisDocCommentDelivery;
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
		if (paradisIsDocCommentId(id) && typeof place === 'string' && PLACES.has(place)) {
			places.set(id, place as ParadisDocCommentPlace);
		}
	}
	return places;
}

function parseEdit(value: unknown): IParadisDocCommentEdit | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const edit = value as Record<string, unknown>;
	const tool = readText(edit.tool, 64);
	if (!isTime(edit.at) || tool === undefined) {
		return undefined;
	}
	const toolUseId = readText(edit.toolUseId, 200);
	return { at: edit.at, tool, ...(toolUseId !== undefined ? { toolUseId } : {}) };
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
	const edits = message.by === 'agent' && Array.isArray(message.edits)
		? message.edits.slice(0, PARADIS_DOC_COMMENT_MAX_EDITS).map(parseEdit).filter((edit): edit is IParadisDocCommentEdit => edit !== undefined)
		: undefined;
	return { by: message.by, text, at: message.at, ...(edits !== undefined ? { edits } : {}) };
}

function parseDelivery(value: unknown): IParadisDocCommentDelivery | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const delivery = value as Record<string, unknown>;
	const attempts = typeof delivery.attempts === 'number' && Number.isSafeInteger(delivery.attempts) && delivery.attempts >= 0 ? delivery.attempts : 0;
	const blockedBy = typeof delivery.blockedBy === 'string' && BLOCKS.has(delivery.blockedBy) ? delivery.blockedBy as ParadisDocDeliveryBlock : undefined;
	return {
		attempts,
		...(blockedBy !== undefined ? { blockedBy } : {}),
		...(isTime(delivery.typedAt) ? { typedAt: delivery.typedAt } : {}),
		...(delivery.entered === true ? { entered: true } : {}),
		...(isTime(delivery.deliveredAt) ? { deliveredAt: delivery.deliveredAt } : {}),
	};
}

function parseThread(value: unknown): IParadisDocCommentThread | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const thread = value as Record<string, unknown>;
	const anchor = paradisReadDocAnchor(thread.anchor);
	const messages = Array.isArray(thread.messages) ? thread.messages.slice(0, MAX_MESSAGES).map(parseMessage).filter((message): message is IParadisDocCommentMessage => message !== undefined) : [];
	if (!paradisIsDocCommentId(thread.id) || (thread.startedBy !== 'user' && thread.startedBy !== 'agent')
		|| anchor === undefined || typeof thread.state !== 'string' || !STATES.has(thread.state) || !isTime(thread.createdAt) || messages.length === 0) {
		return undefined;
	}
	const delivery = parseDelivery(thread.delivery);
	return { id: thread.id, startedBy: thread.startedBy, anchor, state: thread.state as ParadisDocCommentState, messages, createdAt: thread.createdAt, ...(delivery !== undefined ? { delivery } : {}) };
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

// --- 届け方と回答の状態の移り変わり（純関数。変わらなければ同じものを返す） ---------------------------

/** 未回答（届け待ち・届いた・届けられない）か。「資料」の一覧の数・アイコンのバッジ・list_docs の数はこれで数える。 */
export function paradisIsDocCommentOpen(thread: IParadisDocCommentThread): boolean {
	return thread.state === 'queued' || thread.state === 'delivered' || thread.state === 'undeliverable';
}

/** 未回答の数。 */
export function paradisCountOpenDocComments(threads: readonly IParadisDocCommentThread[]): number {
	return threads.filter(paradisIsDocCommentOpen).length;
}

/** まだペインへ貼っていない届け待ちか（届け方が拾う対象）。 */
export function paradisDocCommentAwaitsDelivery(thread: IParadisDocCommentThread): boolean {
	return (thread.state === 'queued' || thread.state === 'undeliverable') && thread.delivery?.typedAt === undefined;
}

/** 待っている・届けられない理由を書く（undefined で外す）。貼る前の届け待ちだけが対象。 */
export function paradisWithDocCommentBlocked(thread: IParadisDocCommentThread, block: ParadisDocDeliveryBlock | undefined): IParadisDocCommentThread {
	if (!paradisDocCommentAwaitsDelivery(thread)) {
		return thread;
	}
	const state: ParadisDocCommentState = paradisIsDocDeliveryUndeliverable(block) ? 'undeliverable' : 'queued';
	if (thread.state === state && thread.delivery?.blockedBy === block) {
		return thread;
	}
	const { blockedBy: _blockedBy, ...rest } = thread.delivery ?? { attempts: 0 };
	return { ...thread, state, delivery: { ...rest, ...(block !== undefined ? { blockedBy: block } : {}) } };
}

/** ペインへ貼った。`entered` は Enter も送ったか。 */
export function paradisWithDocCommentTyped(thread: IParadisDocCommentThread, at: number, entered: boolean): IParadisDocCommentThread {
	if (!paradisDocCommentAwaitsDelivery(thread)) {
		return thread;
	}
	return { ...thread, state: 'queued', delivery: { attempts: (thread.delivery?.attempts ?? 0) + 1, typedAt: at, ...(entered ? { entered: true } : {}) } };
}

/**
 * 届いた（エージェントが入力を受け取った・持ち主の会話が read_doc_comments で読んだ）。届け待ちのときだけ移る。
 * 貼る前に読まれたものも、貼った時刻を埋めて二度と貼らない。
 */
export function paradisWithDocCommentDelivered(thread: IParadisDocCommentThread, at: number): IParadisDocCommentThread {
	if (thread.state !== 'queued' && thread.state !== 'undeliverable') {
		return thread;
	}
	const { blockedBy: _blockedBy, ...rest } = thread.delivery ?? { attempts: 0 };
	return { ...thread, state: 'delivered', delivery: { ...rest, typedAt: rest.typedAt ?? at, deliveredAt: at } };
}

/**
 * エージェントの回答を足す。答えたコメントは届いたものとし、届け待ちの理由を外して貼った・届いた時刻を埋める
 * （read_doc_comments で読んで答えた・貼る前に答えたコメントを、後から貼らない。開き直しても貼り直さない）。
 */
export function paradisWithDocCommentReply(thread: IParadisDocCommentThread, text: string, resolved: boolean, edits: readonly IParadisDocCommentEdit[], at: number): IParadisDocCommentThread {
	const message: IParadisDocCommentMessage = { by: 'agent', text, at, edits: edits.slice(0, PARADIS_DOC_COMMENT_MAX_EDITS) };
	const { blockedBy: _blockedBy, ...rest } = thread.delivery ?? { attempts: 0 };
	return {
		...thread,
		state: resolved ? 'resolved' : 'answered',
		messages: [...thread.messages, message].slice(-MAX_MESSAGES),
		delivery: { ...rest, typedAt: rest.typedAt ?? at, deliveredAt: rest.deliveredAt ?? at },
	};
}

/** ユーザーがカードで行う操作。 */
export type ParadisDocCommentUserAction = 'resolve' | 'reopen' | 'append' | 'deliverNow';

/** 新しく届け直すときの届け方の記録（貼った回数だけ残す）。 */
function freshDelivery(thread: IParadisDocCommentThread): IParadisDocCommentDelivery {
	return { attempts: thread.delivery?.attempts ?? 0 };
}

/**
 * ユーザーの操作を反映する。`resolve` 解決にする、`reopen` 開き直す（最後が回答なら回答ありへ、そうでなければ届け直す）、
 * `append` 追記する（届け直す）。`deliverNow` は状態を変えない（届け方の側で扱う）。
 */
export function paradisWithDocCommentUserAction(thread: IParadisDocCommentThread, action: ParadisDocCommentUserAction, text: string | undefined, at: number): IParadisDocCommentThread {
	switch (action) {
		case 'resolve':
			return thread.state === 'resolved' ? thread : { ...thread, state: 'resolved' };
		case 'reopen': {
			if (thread.state !== 'resolved') {
				return thread;
			}
			// 最後が回答なら回答ありへ。最後のユーザーの文を貼り終えていれば届いたものとして戻す（同じ文を二度貼らない）
			const last = thread.messages[thread.messages.length - 1];
			if (last?.by === 'agent') {
				return { ...thread, state: 'answered' };
			}
			return thread.delivery?.typedAt !== undefined ? { ...thread, state: 'delivered' } : { ...thread, state: 'queued', delivery: freshDelivery(thread) };
		}
		case 'append': {
			const trimmed = text?.trim();
			if (!trimmed) {
				return thread;
			}
			const message: IParadisDocCommentMessage = { by: 'user', text: trimmed.slice(0, PARADIS_DOC_COMMENT_TEXT_MAX), at };
			return { ...thread, state: 'queued', messages: [...thread.messages, message].slice(-MAX_MESSAGES), delivery: freshDelivery(thread) };
		}
		default:
			return thread;
	}
}

/** 回答に結び付ける書き込みの起点（前の回答、無ければ届いた・貼った・書いた時刻）。 */
export function paradisDocCommentReplySince(thread: IParadisDocCommentThread): number {
	for (let index = thread.messages.length - 1; index >= 0; index--) {
		if (thread.messages[index].by === 'agent') {
			return thread.messages[index].at;
		}
	}
	return thread.delivery?.deliveredAt ?? thread.delivery?.typedAt ?? thread.createdAt;
}

/** ユーザーの最後の書き込み（届けるときに先頭 1 行を貼る）。 */
export function paradisDocCommentLastUserText(thread: IParadisDocCommentThread): string {
	for (let index = thread.messages.length - 1; index >= 0; index--) {
		if (thread.messages[index].by === 'user') {
			return thread.messages[index].text;
		}
	}
	return '';
}
