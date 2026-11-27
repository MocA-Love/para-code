/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の提案（見回りで見つけた「やってもよいこと」）の台帳の純関数。保存は `<userData>/paradis/bots/suggestions.json`。
//
// - 提案は Bot のホームの節にだけ出し、「あなたの番」にもベルにも数えない（Q677 の 8 = 案 A）
// - 1 回の見回りで 5 件まで。その Bot の最初の見回りは 3 件まで
// - 「見送る」と、同じ題（大文字小文字・空白の違いは同じとみなす）を 30 日出さない
// - 「始める」は、依頼の文を返すだけ（会話の入力欄へ未送信で入れるのは画面の側）

import { isRecord } from '../../../common/paradisGuards.js';

export const PARADIS_BOT_SUGGESTIONS_VERSION = 1;

export const PARADIS_BOT_SUGGESTION_LIMITS = Object.freeze({
	/** 1 回の見回りで出せる数。 */
	perRun: 5,
	/** その Bot の最初の見回りで出せる数。 */
	firstRun: 3,
	/** 見送った題を出さない日数。 */
	dismissDays: 30,
	title: 200,
	/** 依頼の文（始めると会話の入力欄へ入る）。 */
	request: 4000,
	/** 1 Bot が残す、決めた（始めた・見送った）提案の数。 */
	keepDecided: 50,
	/** 1 Bot が持てる、まだ決めていない提案の数。 */
	open: 20,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export type ParadisBotSuggestionState = 'open' | 'started' | 'dismissed';

export interface IParadisBotSuggestion {
	readonly id: string;
	readonly botId: string;
	readonly title: string;
	/** 始めると Bot の会話の入力欄へ入る依頼の文（持ち主の言葉で）。 */
	readonly request: string;
	/** どの見回りで出したか（見回りのペインのトークンのハッシュ）。1 回の数を数える。 */
	readonly run: string;
	readonly state: ParadisBotSuggestionState;
	readonly createdAt: number;
	readonly decidedAt?: number;
}

export interface IParadisBotSuggestionsState {
	readonly version: number;
	readonly suggestions: readonly IParadisBotSuggestion[];
	/** 見送った題（正規化した題）と、それを出さない期限。 */
	readonly dismissed: readonly { readonly botId: string; readonly key: string; readonly until: number }[];
	/** 一度でも提案を出した Bot（最初の見回りかを決める）。 */
	readonly seenBots: readonly string[];
}

export const EMPTY_PARADIS_BOT_SUGGESTIONS_STATE: IParadisBotSuggestionsState = Object.freeze({ version: PARADIS_BOT_SUGGESTIONS_VERSION, suggestions: Object.freeze([]), dismissed: Object.freeze([]), seenBots: Object.freeze([]) });

export type ParadisBotSuggestionsResult<T> =
	| { readonly ok: true; readonly state: IParadisBotSuggestionsState; readonly value: T }
	| { readonly ok: false; readonly code: 'invalid_argument' | 'limit' | 'dismissed' | 'duplicate' | 'not_found' | 'decided' | 'read_only'; readonly message: string };

/** 題を比べる鍵（大文字小文字・前後と連続の空白・全角半角の違いは同じとみなす）。 */
export function paradisBotSuggestionKey(title: string): string {
	return title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function writable(state: IParadisBotSuggestionsState): boolean {
	return state.version === PARADIS_BOT_SUGGESTIONS_VERSION;
}

const READ_ONLY = { ok: false, code: 'read_only', message: 'The suggestion list was written by a newer Para Code, so this version does not change it.' } as const;

/** その Bot の、まだ決めていない提案（新しい順）。 */
export function paradisBotOpenSuggestions(state: IParadisBotSuggestionsState, botId: string): IParadisBotSuggestion[] {
	return state.suggestions.filter(suggestion => suggestion.botId === botId && suggestion.state === 'open').sort((a, b) => b.createdAt - a.createdAt);
}

/** 見回りが提案を足す。 */
export function paradisBotSuggestionAdd(state: IParadisBotSuggestionsState, input: { readonly id: string; readonly botId: string; readonly run: string; readonly title: unknown; readonly request: unknown }, now: number): ParadisBotSuggestionsResult<IParadisBotSuggestion> {
	if (!writable(state)) {
		return READ_ONLY;
	}
	const L = PARADIS_BOT_SUGGESTION_LIMITS;
	if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > L.title || typeof input.request !== 'string' || input.request.trim().length === 0 || input.request.length > L.request) {
		return { ok: false, code: 'invalid_argument', message: `A suggestion needs a title (up to ${L.title} characters) and the request your owner would send you (up to ${L.request} characters).` };
	}
	const title = input.title.trim();
	const key = paradisBotSuggestionKey(title);
	if (state.dismissed.some(entry => entry.botId === input.botId && entry.key === key && entry.until > now)) {
		return { ok: false, code: 'dismissed', message: 'Your owner dismissed this suggestion recently. Do not offer it again for now.' };
	}
	if (state.suggestions.some(suggestion => suggestion.botId === input.botId && suggestion.state === 'open' && paradisBotSuggestionKey(suggestion.title) === key)) {
		return { ok: false, code: 'duplicate', message: 'The same suggestion already waits for your owner.' };
	}
	// 最初の見回り: その Bot がまだ一度も見回りを終えておらず、ほかの見回りの提案も無い
	const firstRun = !state.seenBots.includes(input.botId) && !state.suggestions.some(suggestion => suggestion.botId === input.botId && suggestion.run !== input.run);
	const inRun = state.suggestions.filter(suggestion => suggestion.botId === input.botId && suggestion.run === input.run).length;
	const limit = firstRun ? L.firstRun : L.perRun;
	if (inRun >= limit) {
		return { ok: false, code: 'limit', message: `You offered ${limit} suggestions in this look-around, which is the most. Stop here.` };
	}
	if (paradisBotOpenSuggestions(state, input.botId).length >= L.open) {
		return { ok: false, code: 'limit', message: `${L.open} suggestions already wait for your owner. Stop here.` };
	}
	const suggestion: IParadisBotSuggestion = { id: input.id, botId: input.botId, title, request: input.request, run: input.run, state: 'open', createdAt: now };
	return {
		ok: true,
		state: { ...state, suggestions: [...state.suggestions, suggestion] },
		value: suggestion,
	};
}

/** 見回りが終わった（その Bot はもう最初の見回りではない）。 */
export function paradisBotSuggestionsRunEnded(state: IParadisBotSuggestionsState, botId: string): IParadisBotSuggestionsState {
	return !writable(state) || state.seenBots.includes(botId) ? state : { ...state, seenBots: [...state.seenBots, botId] };
}

function decide(state: IParadisBotSuggestionsState, id: string, to: 'started' | 'dismissed', now: number): ParadisBotSuggestionsResult<IParadisBotSuggestion> {
	if (!writable(state)) {
		return READ_ONLY;
	}
	const current = state.suggestions.find(suggestion => suggestion.id === id);
	if (current === undefined) {
		return { ok: false, code: 'not_found', message: 'There is no such suggestion.' };
	}
	if (current.state !== 'open') {
		return { ok: false, code: 'decided', message: 'The suggestion was already started or dismissed.' };
	}
	const decided: IParadisBotSuggestion = { ...current, state: to, decidedAt: now };
	// 決めた提案は Bot ごとに新しい方から残す（古いものから落とす）
	const others = state.suggestions.filter(suggestion => suggestion.id !== id);
	const decidedOfBot = [decided, ...others.filter(suggestion => suggestion.botId === current.botId && suggestion.state !== 'open').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))].slice(0, PARADIS_BOT_SUGGESTION_LIMITS.keepDecided);
	const kept = new Set(decidedOfBot.map(suggestion => suggestion.id));
	const suggestions = [...others.filter(suggestion => suggestion.botId !== current.botId || suggestion.state === 'open' || kept.has(suggestion.id)), decided];
	const key = paradisBotSuggestionKey(current.title);
	const dismissed = to === 'dismissed'
		? [...state.dismissed.filter(entry => entry.until > now && !(entry.botId === current.botId && entry.key === key)), { botId: current.botId, key, until: now + PARADIS_BOT_SUGGESTION_LIMITS.dismissDays * DAY_MS }]
		: state.dismissed.filter(entry => entry.until > now);
	return { ok: true, state: { ...state, suggestions, dismissed }, value: decided };
}

/** 「始める」。依頼の文を返す（会話の入力欄へ未送信で入れるのは画面の側）。 */
export function paradisBotSuggestionStart(state: IParadisBotSuggestionsState, id: string, now: number): ParadisBotSuggestionsResult<IParadisBotSuggestion> {
	return decide(state, id, 'started', now);
}

/** 「見送る」。同じ題を 30 日出さない。 */
export function paradisBotSuggestionDismiss(state: IParadisBotSuggestionsState, id: string, now: number): ParadisBotSuggestionsResult<IParadisBotSuggestion> {
	return decide(state, id, 'dismissed', now);
}

/** Bot を消したとき、その提案と見送りの記録を外す。 */
export function paradisBotSuggestionsRemoveBot(state: IParadisBotSuggestionsState, botId: string): IParadisBotSuggestionsState {
	if (!writable(state)) {
		return state;
	}
	return { ...state, suggestions: state.suggestions.filter(suggestion => suggestion.botId !== botId), dismissed: state.dismissed.filter(entry => entry.botId !== botId), seenBots: state.seenBots.filter(id => id !== botId) };
}

function storedSuggestion(value: unknown): IParadisBotSuggestion | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || typeof value.botId !== 'string' || typeof value.title !== 'string' || typeof value.request !== 'string'
		|| typeof value.run !== 'string' || (value.state !== 'open' && value.state !== 'started' && value.state !== 'dismissed') || typeof value.createdAt !== 'number') {
		return undefined;
	}
	return {
		id: value.id, botId: value.botId, title: value.title, request: value.request, run: value.run, state: value.state, createdAt: value.createdAt,
		...(typeof value.decidedAt === 'number' ? { decidedAt: value.decidedAt } : {}),
	};
}

/** 読んだ JSON を台帳の形へ直す。1 件だけ形が違えばその 1 件を捨てる。全体の形が違えば undefined。新しい版は読むだけ。 */
export function paradisParseBotSuggestionsState(value: unknown): IParadisBotSuggestionsState | undefined {
	if (!isRecord(value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.suggestions)) {
		return undefined;
	}
	if (value.version > PARADIS_BOT_SUGGESTIONS_VERSION) {
		return { version: value.version, suggestions: [], dismissed: [], seenBots: [] };
	}
	const suggestions = value.suggestions.map(storedSuggestion).filter((suggestion): suggestion is IParadisBotSuggestion => suggestion !== undefined);
	const dismissed = (Array.isArray(value.dismissed) ? value.dismissed : [])
		.filter((entry): entry is { botId: string; key: string; until: number } => isRecord(entry) && typeof entry.botId === 'string' && typeof entry.key === 'string' && typeof entry.until === 'number');
	const seenBots = (Array.isArray(value.seenBots) ? value.seenBots : []).filter((id): id is string => typeof id === 'string');
	return { version: PARADIS_BOT_SUGGESTIONS_VERSION, suggestions, dismissed: dismissed.map(entry => ({ botId: entry.botId, key: entry.key, until: entry.until })), seenBots };
}
