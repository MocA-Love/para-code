/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の作業項目（item）の台帳の形と、I/O もタイマーも持たない更新の関数。
//
// 項目は「Bot が持ち主のために今していること・持ち主に決めてほしいこと」。状態は 5 つで、Bot は指示文に従って
// 自分で項目を「Needs you」にし、問いと選択肢を付ける。持ち主が答えると項目は作業中へ戻る。
//
// 台帳は shared process が `<userData>/paradis/bots/items.json` に持つ。Bot の専用フォルダには置かない
// （Bot のエージェントが自由に書ける場所なので、状態と「持ち主の答え」を偽れてしまう）。
//
// 知らない状態の項目（新しい Para Code が足した状態）は捨てず、読んだ値のまま持って読み取り専用にする
// （{@link IParadisBotItem.preserved}）。書き戻すときも読んだ値をそのまま書く。

import { isRecord } from '../../../common/paradisGuards.js';
import { paradisBotHomeRelativePath } from './paradisBots.js';

export const PARADIS_BOT_ITEMS_VERSION = 1;

/**
 * 項目の状態。`waiting` は外の何か（CI・レビュー・相手の返事）を待っている状態で、人を待つ `needs_you` と違い
 * 「あなたの番」に数えない。待っているものは見回り（定期実行）が見に行く。
 */
export const PARADIS_BOT_ITEM_STATUSES = ['planned', 'working', 'waiting', 'needs_you', 'done', 'canceled'] as const;
export type ParadisBotItemStatus = typeof PARADIS_BOT_ITEM_STATUSES[number];

/** 長い文は断る（切らない）。詳しい報告はファイルかリンクに置かせる。 */
/**
 * 項目の台帳（`items.json`）の大きさの上限（バイト）。超える Bot の書き込みは断る。持ち主の操作（閉じる・コメントなど）
 * と Bot が項目を閉じる書き込みは通す。読み込みは上限を超えたファイルも読む（壊さない）。件数の上限の掛け算だけでは
 * 最悪で数 GB になるため。
 */
export const PARADIS_BOT_ITEMS_BYTE_LIMIT = 32 * 1024 * 1024;

export const PARADIS_BOT_ITEM_LIMITS = Object.freeze({
	title: 200,
	description: 20_000,
	doneMeans: 2_000,
	/** コメント・問いの前置き・閉じるときのひとこと。 */
	text: 8_000,
	/** 1 回に聞ける問い。 */
	questions: 5,
	/** 1 問の選択肢。 */
	options: 8,
	prompt: 500,
	label: 150,
	detail: 500,
	links: 100,
	ref: 2_000,
	/** 1 項目のイベント。 */
	events: 500,
	/** 1 つの Bot の開いている項目。 */
	openPerBot: 200,
	/** 台帳全体。超えたら閉じた古い項目から落とす。 */
	items: 2_000,
});

export type ParadisBotItemActor = 'bot' | 'owner' | 'system';
const ACTORS: readonly ParadisBotItemActor[] = ['bot', 'owner', 'system'];

/**
 * 項目に起きたこと 1 件。種類は `made`・`edited`・`status`・`commented`・`linked`・`snoozed`
 * （知らない種類も捨てずに持つ）。
 */
export interface IParadisBotItemEvent {
	/** その項目の中の連番。 */
	readonly id: number;
	readonly kind: string;
	readonly actor: ParadisBotItemActor;
	readonly at: number;
	/** コメントの本文。 */
	readonly text?: string;
	/** 状態の移り変わり。 */
	readonly from?: string;
	readonly to?: string;
	/** 閉じた理由・ひとこと。 */
	readonly note?: string;
	/** 持ち主のコメントが答えた問い（問いのイベントの id）。 */
	readonly answers?: number;
	/** 持ち主が答えずに飛ばした。 */
	readonly skipped?: boolean;
	/** 変えた欄の名前。 */
	readonly fields?: readonly string[];
	/** 足したリンク。 */
	readonly refs?: readonly string[];
	/** 後回しにした期限（`snoozed`）。解いたときは持たない。 */
	readonly until?: number;
	/** Bot へまだ届けていない（持ち主の書き込みに付く）。届けたら外す。 */
	readonly toBot?: boolean;
}

export interface IParadisBotItemOption {
	readonly label: string;
	readonly detail?: string;
}

export interface IParadisBotItemQuestion {
	/** 問いの 1 行。 */
	readonly prompt: string;
	readonly options: readonly IParadisBotItemOption[];
	/** おすすめの選択肢（`options` の添字）。 */
	readonly recommended?: number;
	/** 複数選べる。 */
	readonly multi?: boolean;
}

/** 今、持ち主を待っている問い。聞き直すと丸ごと置き換わる。 */
export interface IParadisBotItemAsk {
	/** 問いを書いたイベントの id（聞き直すたびに変わる。「聞く・答える」の台帳の id に使う）。 */
	readonly eventId: number;
	/** 問いの前置き（なぜ聞くか）。 */
	readonly context?: string;
	/** 空なら「見てほしい」だけ（文で答える）。 */
	readonly questions: readonly IParadisBotItemQuestion[];
}

export type ParadisBotItemLinkKind = 'pr' | 'url' | 'file';

export interface IParadisBotItemLink {
	readonly kind: ParadisBotItemLinkKind;
	/** `pr`: `owner/repo#123`、`url`: http(s) の URL、`file`: 専用フォルダの中の相対パス。 */
	readonly ref: string;
}

export interface IParadisBotItem {
	readonly uid: string;
	/** 全部の Bot を通した連番（`#35`）。 */
	readonly number: number;
	readonly botId: string;
	readonly title: string;
	readonly description?: string;
	/** 何をもって完了とするか。 */
	readonly doneMeans?: string;
	/** {@link PARADIS_BOT_ITEM_STATUSES} のどれか。知らない値のときは {@link preserved} を持つ。 */
	readonly status: string;
	readonly ask?: IParadisBotItemAsk;
	readonly closeNote?: string;
	readonly links: readonly IParadisBotItemLink[];
	readonly events: readonly IParadisBotItemEvent[];
	readonly lastEventId: number;
	/** この時刻まで一覧の群から隠す（状態は変えない）。 */
	readonly snoozedUntil?: number;
	readonly lastActivityAt: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly closedAt?: number;
	/**
	 * 知らない状態の項目の、読んだままの値。これがある項目は読み取り専用で、保存するときはこの値をそのまま書く
	 * （新しい Para Code が足した欄を落とさない）。
	 */
	readonly preserved?: Readonly<Record<string, unknown>>;
}

export interface IParadisBotItemsState {
	readonly version: number;
	readonly nextNumber: number;
	readonly items: readonly IParadisBotItem[];
}

export const EMPTY_PARADIS_BOT_ITEMS_STATE: IParadisBotItemsState = Object.freeze({ version: PARADIS_BOT_ITEMS_VERSION, nextNumber: 1, items: Object.freeze([]) });

export type ParadisBotItemErrorCode = 'not_found' | 'item_closed' | 'not_owner' | 'invalid_argument' | 'limit' | 'read_only' | 'item_changed';

export type ParadisBotItemsResult =
	| { readonly ok: true; readonly state: IParadisBotItemsState; readonly item: IParadisBotItem; readonly eventId?: number; readonly unchanged?: boolean }
	| { readonly ok: false; readonly code: ParadisBotItemErrorCode; readonly message: string };

type Refusal = { readonly ok: false; readonly code: ParadisBotItemErrorCode; readonly message: string };

function refuse(code: ParadisBotItemErrorCode, message: string): Refusal {
	return { ok: false, code, message };
}

// ---- 読む ---------------------------------------------------------------------------------------

/** 項目の状態。知らない値なら undefined（その項目は読み取り専用）。 */
export function paradisBotItemStatus(item: Pick<IParadisBotItem, 'status'>): ParadisBotItemStatus | undefined {
	return PARADIS_BOT_ITEM_STATUSES.find(status => status === item.status);
}

export function paradisIsBotItemClosed(item: Pick<IParadisBotItem, 'status'>): boolean {
	return item.status === 'done' || item.status === 'canceled';
}

/** 読み取り専用か（知らない状態の項目）。 */
export function paradisIsBotItemLocked(item: Pick<IParadisBotItem, 'status' | 'preserved'>): boolean {
	return item.preserved !== undefined || paradisBotItemStatus(item) === undefined;
}

/** 後回し中か（状態ではなく、開いている項目の期限から決まる）。 */
export function paradisIsBotItemSnoozed(item: Pick<IParadisBotItem, 'status' | 'snoozedUntil'>, now: number): boolean {
	return !paradisIsBotItemClosed(item) && item.snoozedUntil !== undefined && item.snoozedUntil > now;
}

/** Bot の項目（動きの新しい順）。`open` を付けると開いているもの・閉じたものだけ。 */
export function paradisBotItemsOf(state: IParadisBotItemsState, filter: { readonly botId?: string; readonly open?: boolean } = {}): IParadisBotItem[] {
	return state.items
		.filter(item => (filter.botId === undefined || item.botId === filter.botId) && (filter.open === undefined || paradisIsBotItemClosed(item) !== filter.open))
		.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.number - a.number);
}

/**
 * 「あなたの番」に数えるか。Needs you で問いがあり、後回し中でないもの。「聞く・答える」の台帳へ出すものと
 * 同じ式（持ち主が自分で Needs you にした項目は問いが無いので、どちらにも出さない）。一時停止中の Bot は
 * 呼ぶ側が外す。
 */
export function paradisBotItemWaitsForOwner(item: Pick<IParadisBotItem, 'status' | 'ask' | 'snoozedUntil'>, now: number): boolean {
	return item.status === 'needs_you' && item.ask !== undefined && !paradisIsBotItemSnoozed(item, now);
}

/** Bot ごとの数。`needsYou` は {@link paradisBotItemWaitsForOwner} の数（「あなたの番」の件数）。 */
export interface IParadisBotItemCounts {
	readonly open: number;
	readonly needsYou: number;
	/** 項目が最後に動いた時刻。項目が無ければ 0。 */
	readonly lastActivityAt: number;
}

export function paradisBotItemCounts(state: IParadisBotItemsState, botId: string, now: number): IParadisBotItemCounts {
	let open = 0;
	let needsYou = 0;
	let lastActivityAt = 0;
	for (const item of state.items) {
		if (item.botId !== botId) {
			continue;
		}
		lastActivityAt = Math.max(lastActivityAt, item.lastActivityAt);
		if (!paradisIsBotItemClosed(item)) {
			open++;
			if (paradisBotItemWaitsForOwner(item, now)) {
				needsYou++;
			}
		}
	}
	return { open, needsYou, lastActivityAt };
}

/**
 * Bot へまだ届けていないイベント。読み取り専用の項目（知らない状態）は印を外せないので、数えも配りもしない
 * （出すと、新しい版が書いた項目が古い版で開くたびに「未配達」に出続ける）。
 */
export function paradisBotItemUndelivered(item: IParadisBotItem): IParadisBotItemEvent[] {
	return paradisIsBotItemLocked(item) ? [] : item.events.filter(event => event.toBot === true);
}

/** Bot へまだ届けていないイベントのある項目と、そのイベント。新しい版の台帳（書けない）では何も出さない。 */
export function paradisBotItemsPendingMail(state: IParadisBotItemsState, botId: string): { readonly item: IParadisBotItem; readonly events: readonly IParadisBotItemEvent[] }[] {
	const pending: { item: IParadisBotItem; events: IParadisBotItemEvent[] }[] = [];
	if (state.version !== PARADIS_BOT_ITEMS_VERSION) {
		return pending;
	}
	for (const item of state.items) {
		const events = item.botId === botId ? paradisBotItemUndelivered(item) : [];
		if (events.length > 0) {
			pending.push({ item, events });
		}
	}
	return pending;
}

// ---- 入力の検め ---------------------------------------------------------------------------------

function textError(name: string, value: string | undefined, limit: number, required = false): string | undefined {
	if (value === undefined) {
		return required ? `${name} is required.` : undefined;
	}
	if (typeof value !== 'string' || value.includes('\0')) {
		return `${name} must be text.`;
	}
	if (required && value.trim().length === 0) {
		return `${name} is required.`;
	}
	return value.length > limit ? `${name} is longer than ${limit} characters. Put the details in a file or a link.` : undefined;
}

/**
 * 問いを検める。上限を超えるものは切らずに断る（選べない選択肢のある問いを作らない）。
 * 通れば問いの配列、通らなければ理由の文。
 */
export function paradisSanitizeBotItemQuestions(value: unknown): IParadisBotItemQuestion[] | string {
	const L = PARADIS_BOT_ITEM_LIMITS;
	if (!Array.isArray(value) || value.length > L.questions) {
		return `An ask takes up to ${L.questions} questions.`;
	}
	const questions: IParadisBotItemQuestion[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || typeof candidate.prompt !== 'string') {
			return 'Each question needs its text.';
		}
		const prompt = candidate.prompt.trim();
		const rawOptions = candidate.options ?? [];
		if (prompt.length === 0 || prompt.length > L.prompt || /[\r\n\0]/.test(prompt)) {
			return `A question is one line of up to ${L.prompt} characters.`;
		}
		if (!Array.isArray(rawOptions) || rawOptions.length > L.options) {
			return `A question takes up to ${L.options} options.`;
		}
		const options: IParadisBotItemOption[] = [];
		for (const raw of rawOptions) {
			const label = isRecord(raw) && typeof raw.label === 'string' ? raw.label.trim() : '';
			const detail = isRecord(raw) && typeof raw.detail === 'string' ? raw.detail.trim() : '';
			if (label.length === 0 || label.length > L.label || detail.length > L.detail || /[\r\n\0]/.test(label) || options.some(option => option.label === label)) {
				return `Each option needs its own one-line label of up to ${L.label} characters (detail up to ${L.detail}).`;
			}
			options.push({ label, ...(detail.length > 0 ? { detail } : {}) });
		}
		const recommended = candidate.recommended;
		if (recommended !== undefined && (typeof recommended !== 'number' || !Number.isInteger(recommended) || recommended < 0 || recommended >= options.length)) {
			return 'The recommended option is not one of the options (it is a 0-based index).';
		}
		if (questions.some(question => question.prompt === prompt)) {
			return 'Each question needs its own text.';
		}
		questions.push({ prompt, options, ...(typeof recommended === 'number' ? { recommended } : {}), ...(candidate.multi === true ? { multi: true } : {}) });
	}
	return questions;
}

const PR_REF = /^(?<repo>[\w.-]+\/[\w.-]+)#(?<number>\d+)$/;
const PR_URL = /^https?:\/\/github\.com\/(?<repo>[\w.-]+\/[\w.-]+)\/pull\/(?<number>\d+)(?:[/?#].*)?$/i;

/** リンク 1 本を検めて揃える。PR の URL は `owner/repo#n` に直す。専用フォルダの外を指すファイルは断る。 */
export function paradisSanitizeBotItemLink(value: unknown): IParadisBotItemLink | undefined {
	if (!isRecord(value) || typeof value.ref !== 'string' || value.ref.length > PARADIS_BOT_ITEM_LIMITS.ref) {
		return undefined;
	}
	const ref = value.ref.trim();
	switch (value.kind) {
		case 'pr': {
			const groups = (PR_REF.exec(ref) ?? PR_URL.exec(ref))?.groups;
			return groups ? { kind: 'pr', ref: `${groups.repo}#${Number(groups.number)}` } : undefined;
		}
		case 'url':
			return /^https?:\/\/[^\s\0]+$/i.test(ref) ? { kind: 'url', ref } : undefined;
		case 'file': {
			const path = paradisBotHomeRelativePath(ref);
			return path !== undefined ? { kind: 'file', ref: path } : undefined;
		}
		default:
			return undefined;
	}
}

// ---- 書く（共通） -------------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface IDraft extends Mutable<Omit<IParadisBotItem, 'events' | 'links'>> {
	events: IParadisBotItemEvent[];
	links: IParadisBotItemLink[];
}

function draftOf(item: IParadisBotItem): IDraft {
	return { ...item, events: [...item.events], links: [...item.links] };
}

function append(draft: IDraft, kind: string, actor: ParadisBotItemActor, now: number, data: Partial<IParadisBotItemEvent> = {}): number {
	const id = draft.lastEventId + 1;
	draft.lastEventId = id;
	draft.events.push({ id, kind, actor, at: now, ...data });
	draft.updatedAt = now;
	draft.lastActivityAt = now;
	return id;
}

/** 状態を移す。Needs you を離れたら問いを外し、閉じたら時刻とひとことを残す。後回しは解ける。 */
function move(draft: IDraft, to: ParadisBotItemStatus, actor: ParadisBotItemActor, now: number, note: string | undefined, toBot: boolean): number {
	const from = draft.status;
	draft.status = to;
	if (to !== 'needs_you') {
		delete draft.ask;
	}
	if (to === 'done' || to === 'canceled') {
		draft.closedAt = now;
		if (note !== undefined) {
			draft.closeNote = note;
		} else {
			delete draft.closeNote;
		}
	} else {
		delete draft.closedAt;
		delete draft.closeNote;
	}
	delete draft.snoozedUntil;
	return append(draft, 'status', actor, now, { from, to, ...(note !== undefined ? { note } : {}), ...(toBot ? { toBot: true } : {}) });
}

/** イベントが上限を超えたら、最初の 1 件（作成）と今の問い以外の古いものから落とす。 */
function trimEvents(draft: IDraft): void {
	const over = draft.events.length - PARADIS_BOT_ITEM_LIMITS.events;
	if (over <= 0) {
		return;
	}
	const keep = new Set([draft.events[0].id, draft.ask?.eventId]);
	let dropped = 0;
	draft.events = draft.events.filter(event => keep.has(event.id) || dropped++ >= over);
}

function commit(state: IParadisBotItemsState, draft: IDraft, eventId: number | undefined): ParadisBotItemsResult {
	trimEvents(draft);
	const item: IParadisBotItem = draft;
	return { ok: true, state: { ...state, items: state.items.map(existing => existing.uid === item.uid ? item : existing) }, item, ...(eventId !== undefined ? { eventId } : {}) };
}

function readOnlyState(state: IParadisBotItemsState): Refusal | undefined {
	return state.version === PARADIS_BOT_ITEMS_VERSION ? undefined : refuse('read_only', 'The items were written by a newer Para Code, so this version does not change them.');
}

function lockedItem(item: IParadisBotItem): Refusal | undefined {
	return paradisIsBotItemLocked(item) ? refuse('read_only', `Item #${item.number} has a status this version of Para Code does not know, so it is read-only here.`) : undefined;
}

/** リンクを足す（重なりは足さない）。足したものの `ref`、上限を超えたら undefined。 */
function addLinks(draft: IDraft, links: readonly IParadisBotItemLink[]): string[] | undefined {
	const added: string[] = [];
	for (const link of links) {
		if (!draft.links.some(existing => existing.kind === link.kind && existing.ref === link.ref)) {
			draft.links.push(link);
			added.push(link.ref);
		}
	}
	return draft.links.length > PARADIS_BOT_ITEM_LIMITS.links ? undefined : added;
}

// ---- Bot が書く ---------------------------------------------------------------------------------

export interface IParadisBotItemAddInput {
	readonly uid: string;
	readonly botId: string;
	readonly title: string;
	readonly description?: string;
	readonly doneMeans?: string;
	/** 既定は `working`。 */
	readonly status?: 'planned' | 'working';
	readonly links?: readonly IParadisBotItemLink[];
}

export function paradisBotItemAdd(state: IParadisBotItemsState, input: IParadisBotItemAddInput, now: number): ParadisBotItemsResult {
	const L = PARADIS_BOT_ITEM_LIMITS;
	const error = readOnlyState(state)?.message
		?? textError('title', input.title, L.title, true)
		?? textError('description', input.description, L.description)
		?? textError('done_means', input.doneMeans, L.doneMeans);
	if (error !== undefined) {
		return refuse(state.version === PARADIS_BOT_ITEMS_VERSION ? 'invalid_argument' : 'read_only', error);
	}
	if (input.uid.length === 0 || input.botId.length === 0 || state.items.some(item => item.uid === input.uid)) {
		return refuse('invalid_argument', 'The item could not be added.');
	}
	if (state.items.filter(item => item.botId === input.botId && !paradisIsBotItemClosed(item)).length >= L.openPerBot) {
		return refuse('limit', `This bot already has ${L.openPerBot} open items. Close the ones that are done first.`);
	}
	let items = state.items;
	if (items.length >= L.items) {
		// 閉じた古い項目から落とす。読み取り専用の項目と開いている項目は落とさない
		const oldest = items.filter(item => paradisIsBotItemClosed(item) && !paradisIsBotItemLocked(item)).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))[0];
		if (oldest === undefined) {
			return refuse('limit', `The item list is full (${L.items}).`);
		}
		items = items.filter(item => item !== oldest);
	}
	const draft: IDraft = {
		uid: input.uid,
		number: state.nextNumber,
		botId: input.botId,
		title: input.title.trim(),
		...(input.description?.trim() ? { description: input.description } : {}),
		...(input.doneMeans?.trim() ? { doneMeans: input.doneMeans } : {}),
		status: input.status ?? 'working',
		links: [],
		events: [],
		lastEventId: 0,
		lastActivityAt: now,
		createdAt: now,
		updatedAt: now,
	};
	if (addLinks(draft, input.links ?? []) === undefined) {
		return refuse('limit', `An item takes up to ${L.links} links.`);
	}
	const eventId = append(draft, 'made', 'bot', now, { to: draft.status });
	const item: IParadisBotItem = draft;
	return { ok: true, state: { ...state, nextNumber: state.nextNumber + 1, items: [...items, item] }, item, eventId };
}

export interface IParadisBotItemChanges {
	readonly status?: ParadisBotItemStatus;
	readonly title?: string;
	/** 空文字で消す。 */
	readonly description?: string;
	readonly doneMeans?: string;
	readonly comment?: string;
	/** `needs_you` と一緒にだけ。前の問いは丸ごと置き換える。 */
	readonly questions?: readonly IParadisBotItemQuestion[];
	/** `canceled` の理由（必須）。 */
	readonly reason?: string;
	/** `done` に添えるひとこと。 */
	readonly note?: string;
	readonly links?: readonly IParadisBotItemLink[];
}

/**
 * Bot が自分の項目を書き換える（状態・欄・コメント・問い・リンク）。
 *
 * - ほかの Bot の項目は `not_owner`
 * - 閉じた項目は、開いている状態へ戻すとき以外は `item_closed`
 * - `needs_you` のまま、新しいコメントか問いを付けて書くと聞き直しになる（問いのイベントの id が変わる）
 * - 何も変わらなければ `unchanged`
 */
export function paradisBotItemUpdate(state: IParadisBotItemsState, botId: string, number: number, changes: IParadisBotItemChanges, now: number): ParadisBotItemsResult {
	const L = PARADIS_BOT_ITEM_LIMITS;
	const blocked = readOnlyState(state);
	if (blocked) {
		return blocked;
	}
	const current = state.items.find(item => item.number === number);
	if (current === undefined) {
		return refuse('not_found', `There is no item #${number}.`);
	}
	if (current.botId !== botId) {
		return refuse('not_owner', `Item #${number} belongs to another bot.`);
	}
	const locked = lockedItem(current);
	if (locked) {
		return locked;
	}
	const error = textError('title', changes.title, L.title)
		?? textError('description', changes.description, L.description)
		?? textError('done_means', changes.doneMeans, L.doneMeans)
		?? textError('comment', changes.comment, L.text)
		?? textError('reason', changes.reason, L.text)
		?? textError('note', changes.note, L.text);
	if (error !== undefined) {
		return refuse('invalid_argument', error);
	}
	if (changes.title !== undefined && changes.title.trim().length === 0) {
		return refuse('invalid_argument', 'An item needs a title.');
	}
	if (changes.status === 'canceled' && !changes.reason?.trim()) {
		return refuse('invalid_argument', 'Canceling needs a reason.');
	}
	if (changes.reason !== undefined && changes.status !== 'canceled') {
		return refuse('invalid_argument', 'reason goes with status "canceled".');
	}
	if (changes.questions !== undefined && changes.status !== 'needs_you') {
		return refuse('invalid_argument', 'questions go with status "needs_you".');
	}
	if (changes.status !== undefined && !PARADIS_BOT_ITEM_STATUSES.includes(changes.status)) {
		return refuse('invalid_argument', `status is one of: ${PARADIS_BOT_ITEM_STATUSES.join(', ')}.`);
	}
	const closing = changes.status === 'done' || changes.status === 'canceled';
	if (paradisIsBotItemClosed(current) && (changes.status === undefined || closing)) {
		return changes.status === current.status && Object.keys(changes).length === 1
			? { ok: true, state, item: current, unchanged: true }
			: refuse('item_closed', `Item #${number} is closed. Set its status to "working" to reopen it, or add a new item.`);
	}
	// 閉じる書き込みは上限でも通す（通さないと、いっぱいになった項目を Bot が閉じられない。古いイベントは commit が落とす）
	if (current.events.length >= L.events && !closing) {
		return refuse('limit', `Item #${number} has ${L.events} events. Close it and add a new item for what is left.`);
	}

	const draft = draftOf(current);
	const comment = changes.comment?.trim() ? changes.comment : undefined;
	const asking = changes.status === 'needs_you' && (comment !== undefined || changes.questions !== undefined);
	const status = changes.status !== undefined && (changes.status !== current.status || asking) ? changes.status : undefined;
	let eventId: number | undefined;

	// 開き直しは先に書く（その後の書き換えが、開いた項目への書き込みとして読める）
	const reopening = status !== undefined && paradisIsBotItemClosed(current);
	if (reopening) {
		eventId = move(draft, status, 'bot', now, undefined, false);
	}
	const fields: string[] = [];
	if (changes.title !== undefined && changes.title.trim() !== draft.title) {
		draft.title = changes.title.trim();
		fields.push('title');
	}
	for (const field of ['description', 'doneMeans'] as const) {
		const value = changes[field];
		if (value !== undefined && (value.trim().length > 0 ? value : undefined) !== draft[field]) {
			if (value.trim().length > 0) {
				draft[field] = value;
			} else {
				delete draft[field];
			}
			fields.push(field);
		}
	}
	if (fields.length > 0) {
		eventId = append(draft, 'edited', 'bot', now, { fields });
	}
	const added = addLinks(draft, changes.links ?? []);
	if (added === undefined) {
		return refuse('limit', `An item takes up to ${L.links} links.`);
	}
	if (added.length > 0) {
		eventId = append(draft, 'linked', 'bot', now, { refs: added });
	}
	if (comment !== undefined) {
		eventId = append(draft, 'commented', 'bot', now, { text: comment });
	}
	if (status !== undefined && !reopening) {
		const note = status === 'canceled' ? changes.reason : status === 'done' ? changes.note?.trim() ? changes.note : undefined : undefined;
		const askedIn = comment !== undefined ? eventId : undefined;
		eventId = move(draft, status, 'bot', now, note, false);
		if (status === 'needs_you') {
			draft.ask = { eventId: askedIn ?? eventId, ...(comment !== undefined ? { context: comment } : {}), questions: changes.questions ?? [] };
		}
	} else if (reopening && status === 'needs_you') {
		draft.ask = { eventId: eventId ?? draft.lastEventId, ...(comment !== undefined ? { context: comment } : {}), questions: changes.questions ?? [] };
	}
	if (eventId === undefined) {
		return { ok: true, state, item: current, unchanged: true };
	}
	return commit(state, draft, eventId);
}

// ---- 持ち主が書く -------------------------------------------------------------------------------

function isRefusal(value: IParadisBotItem | Refusal): value is Refusal {
	return (value as Partial<Refusal>).ok === false;
}

function ownedItem(state: IParadisBotItemsState, uid: string): IParadisBotItem | Refusal {
	const blocked = readOnlyState(state);
	if (blocked) {
		return blocked;
	}
	const item = state.items.find(candidate => candidate.uid === uid);
	if (item === undefined) {
		return refuse('not_found', 'There is no such item.');
	}
	return lockedItem(item) ?? item;
}

export interface IParadisBotItemOwnerComment {
	readonly text: string;
	/** 答えている問い（問いのイベントの id）。Bot がもう別の問いを出していたら `item_changed`。 */
	readonly askEventId?: number;
	/** ただのコメント。問いへの答えにしない（Needs you のまま待たせる）。 */
	readonly plain?: boolean;
	/** 答えずに飛ばす（本文は要らない）。 */
	readonly skipped?: boolean;
}

/**
 * 持ち主のコメント。Needs you の間のコメントは答えとして記録し、項目を作業中へ戻す
 * （`plain` のコメントは、問いが待っている間は戻さない）。Bot へ届ける印を付ける。
 */
export function paradisBotItemOwnerComment(state: IParadisBotItemsState, uid: string, input: IParadisBotItemOwnerComment, now: number): ParadisBotItemsResult {
	const current = ownedItem(state, uid);
	if (isRefusal(current)) {
		return current;
	}
	const error = textError('text', input.text, PARADIS_BOT_ITEM_LIMITS.text, input.skipped !== true);
	if (error !== undefined) {
		return refuse('invalid_argument', error);
	}
	const ask = current.status === 'needs_you' ? current.ask : undefined;
	if (input.askEventId !== undefined && input.askEventId !== ask?.eventId) {
		return refuse('item_changed', `Item #${current.number} has a new question, or no longer waits for an answer.`);
	}
	if (input.skipped === true && ask === undefined) {
		return refuse('item_changed', `Item #${current.number} no longer waits for an answer.`);
	}
	const answering = ask !== undefined && input.plain !== true;
	const draft = draftOf(current);
	delete draft.snoozedUntil;
	const text = input.text.trim().length > 0 ? input.text : undefined;
	const eventId = append(draft, 'commented', 'owner', now, {
		...(text !== undefined ? { text } : {}),
		...(answering ? { answers: ask.eventId } : {}),
		...(answering && input.skipped === true ? { skipped: true } : {}),
		toBot: true,
	});
	// 答え（または、問いの無い Needs you への返事）は項目を Bot へ返す
	if (current.status === 'needs_you' && !(ask !== undefined && input.plain === true)) {
		move(draft, 'working', 'owner', now, undefined, false);
	}
	return commit(state, draft, eventId);
}

/** 持ち主が状態を変える（どれへでも）。Bot へ届ける印を付ける。 */
export function paradisBotItemOwnerStatus(state: IParadisBotItemsState, uid: string, to: ParadisBotItemStatus, note: string | undefined, now: number): ParadisBotItemsResult {
	const current = ownedItem(state, uid);
	if (isRefusal(current)) {
		return current;
	}
	const error = textError('note', note, PARADIS_BOT_ITEM_LIMITS.text);
	if (error !== undefined || !PARADIS_BOT_ITEM_STATUSES.includes(to)) {
		return refuse('invalid_argument', error ?? 'That is not a status.');
	}
	if (to === current.status) {
		return { ok: true, state, item: current, unchanged: true };
	}
	const draft = draftOf(current);
	return commit(state, draft, move(draft, to, 'owner', now, note?.trim() ? note : undefined, true));
}

/** 後回しにする・解く（`until` が undefined）。状態は変えず、Bot にも知らせない。 */
export function paradisBotItemOwnerSnooze(state: IParadisBotItemsState, uid: string, until: number | undefined, now: number): ParadisBotItemsResult {
	const current = ownedItem(state, uid);
	if (isRefusal(current)) {
		return current;
	}
	if (paradisIsBotItemClosed(current)) {
		return refuse('item_closed', `Item #${current.number} is closed.`);
	}
	if (until !== undefined && (!Number.isFinite(until) || until <= now)) {
		return refuse('invalid_argument', 'The snooze time is not in the future.');
	}
	if (until === current.snoozedUntil) {
		return { ok: true, state, item: current, unchanged: true };
	}
	const draft = draftOf(current);
	const lastActivityAt = draft.lastActivityAt;
	if (until !== undefined) {
		draft.snoozedUntil = until;
	} else {
		delete draft.snoozedUntil;
	}
	const eventId = append(draft, 'snoozed', 'owner', now, until !== undefined ? { until } : {});
	// 後回しは「動き」に数えない（並び順と、動きなしの判定を変えない）
	draft.lastActivityAt = lastActivityAt;
	return commit(state, draft, eventId);
}

// ---- 台帳の手入れ -------------------------------------------------------------------------------

/** Bot へ届けたイベントの印を外す。変わらなければ同じ台帳を返す。 */
export function paradisBotItemsMarkDelivered(state: IParadisBotItemsState, uid: string, eventIds: readonly number[]): IParadisBotItemsState {
	const item = state.items.find(candidate => candidate.uid === uid);
	if (state.version !== PARADIS_BOT_ITEMS_VERSION || item === undefined || paradisIsBotItemLocked(item) || !item.events.some(event => event.toBot === true && eventIds.includes(event.id))) {
		return state;
	}
	const events = item.events.map(event => {
		if (event.toBot !== true || !eventIds.includes(event.id)) {
			return event;
		}
		const { toBot: _delivered, ...rest } = event;
		return rest;
	});
	return { ...state, items: state.items.map(existing => existing === item ? { ...item, events } : existing) };
}

/** Bot を消したとき、その項目を台帳から外す。 */
export function paradisBotItemsRemoveBot(state: IParadisBotItemsState, botId: string): IParadisBotItemsState {
	return state.version !== PARADIS_BOT_ITEMS_VERSION || !state.items.some(item => item.botId === botId) ? state : { ...state, items: state.items.filter(item => item.botId !== botId) };
}

// ---- 保存した値の読み込みと書き出し ---------------------------------------------------------------

function time(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function shortText(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
}

function storedEvent(value: unknown): IParadisBotItemEvent | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const actor = ACTORS.find(candidate => candidate === value.actor);
	const at = time(value.at);
	const kind = shortText(value.kind, 40);
	if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1 || actor === undefined || at === undefined || kind === undefined) {
		return undefined;
	}
	const text = shortText(value.text, PARADIS_BOT_ITEM_LIMITS.text);
	const note = shortText(value.note, PARADIS_BOT_ITEM_LIMITS.text);
	const from = shortText(value.from, 40);
	const to = shortText(value.to, 40);
	const strings = (candidate: unknown) => Array.isArray(candidate) && candidate.every(entry => typeof entry === 'string') ? candidate as string[] : undefined;
	const fields = strings(value.fields);
	const refs = strings(value.refs);
	const until = time(value.until);
	return {
		id: value.id, kind, actor, at,
		...(text !== undefined ? { text } : {}),
		...(from !== undefined ? { from } : {}),
		...(to !== undefined ? { to } : {}),
		...(note !== undefined ? { note } : {}),
		...(typeof value.answers === 'number' && Number.isSafeInteger(value.answers) ? { answers: value.answers } : {}),
		...(value.skipped === true ? { skipped: true } : {}),
		...(fields !== undefined ? { fields } : {}),
		...(refs !== undefined ? { refs } : {}),
		...(until !== undefined ? { until } : {}),
		...(value.toBot === true ? { toBot: true } : {}),
	};
}

function storedAsk(value: unknown): IParadisBotItemAsk | undefined {
	if (!isRecord(value) || typeof value.eventId !== 'number' || !Number.isSafeInteger(value.eventId)) {
		return undefined;
	}
	const questions = paradisSanitizeBotItemQuestions(value.questions ?? []);
	const context = shortText(value.context, PARADIS_BOT_ITEM_LIMITS.text);
	return typeof questions === 'string' ? undefined : { eventId: value.eventId, ...(context !== undefined ? { context } : {}), questions };
}

function storedItem(value: unknown): IParadisBotItem | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const L = PARADIS_BOT_ITEM_LIMITS;
	const uid = shortText(value.uid, 200);
	const botId = shortText(value.botId, 200);
	const title = shortText(value.title, L.title);
	const status = shortText(value.status, 40);
	const createdAt = time(value.createdAt);
	const updatedAt = time(value.updatedAt);
	const lastActivityAt = time(value.lastActivityAt);
	if (uid === undefined || botId === undefined || title === undefined || status === undefined || createdAt === undefined || updatedAt === undefined || lastActivityAt === undefined
		|| typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number < 1) {
		return undefined;
	}
	const events = (Array.isArray(value.events) ? value.events : []).map(storedEvent).filter((event): event is IParadisBotItemEvent => event !== undefined).slice(-L.events);
	const links = (Array.isArray(value.links) ? value.links : []).map(paradisSanitizeBotItemLink).filter((link): link is IParadisBotItemLink => link !== undefined).slice(0, L.links);
	const description = shortText(value.description, L.description);
	const doneMeans = shortText(value.doneMeans, L.doneMeans);
	const closeNote = shortText(value.closeNote, L.text);
	const ask = status === 'needs_you' ? storedAsk(value.ask) : undefined;
	const snoozedUntil = time(value.snoozedUntil);
	const closedAt = time(value.closedAt);
	const known = PARADIS_BOT_ITEM_STATUSES.some(candidate => candidate === status);
	return {
		uid, number: value.number, botId, title,
		...(description !== undefined ? { description } : {}),
		...(doneMeans !== undefined ? { doneMeans } : {}),
		status,
		...(ask !== undefined ? { ask } : {}),
		...(closeNote !== undefined ? { closeNote } : {}),
		links, events,
		lastEventId: Math.max(0, typeof value.lastEventId === 'number' && Number.isSafeInteger(value.lastEventId) ? value.lastEventId : 0, ...events.map(event => event.id)),
		...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
		lastActivityAt, createdAt, updatedAt,
		...(closedAt !== undefined ? { closedAt } : {}),
		// 知らない状態の項目は、読んだ値をそのまま持って読み取り専用にする
		...(known ? {} : { preserved: value }),
	};
}

/**
 * 読んだ JSON を台帳の形へ直す。形の違う 1 件・uid や番号が重なる 1 件は捨てる。全体の形が違えば undefined
 * （呼び出し側が別名へ退避する）。今より新しい版は版の番号を保って返す（書き込みは全部断る）。
 */
export function paradisParseBotItemsState(value: unknown): IParadisBotItemsState | undefined {
	if (!isRecord(value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.items)) {
		return undefined;
	}
	const items: IParadisBotItem[] = [];
	const uids = new Set<string>();
	const numbers = new Set<number>();
	for (const candidate of value.items) {
		const item = storedItem(candidate);
		if (item !== undefined && !uids.has(item.uid) && !numbers.has(item.number)) {
			uids.add(item.uid);
			numbers.add(item.number);
			items.push(item);
		}
	}
	const stored = typeof value.nextNumber === 'number' && Number.isSafeInteger(value.nextNumber) ? value.nextNumber : 1;
	return { version: value.version, nextNumber: Math.max(1, stored, ...items.map(item => item.number + 1)), items };
}

/** 保存する形。読み取り専用の項目は、読んだ値をそのまま書く。 */
export function paradisBotItemsToStored(state: IParadisBotItemsState): { readonly version: number; readonly nextNumber: number; readonly items: readonly unknown[] } {
	return { version: state.version, nextNumber: state.nextNumber, items: state.items.map(item => item.preserved ?? item) };
}
