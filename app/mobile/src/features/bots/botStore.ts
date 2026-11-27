// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Bot のページが PC から取ったもの（項目の一覧・提案・項目のページ・ファイル）と、PC へ送る口。
 *
 * 一覧は State の Bot の行（数・最後に動いた時刻）が変わったときに画面が取り直す（{@link useBotPageSync}）。
 * 取れなければ前の値のまま。見本のデータ（開発ビルドの `__paraDev.demo()`）はここへ直接入れる。
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { sendPcRequest } from '../../appState.js';
import { PcReplyError } from '../../store.js';
import {
	botFileReadRequest,
	botFileWriteRequest,
	botItemActRequest,
	botItemRequest,
	botItemsRequest,
	botOpenRequest,
	botSuggestionActRequest,
	type BotSuggestionAction,
	botSuggestionsRequest,
	botUpdateRequest,
	newBotOpId,
	parseBotFileReply,
	parseBotItemActReply,
	parseBotItemReply,
	parseBotItemsReply,
	parseBotSuggestionActReply,
	parseBotSuggestionsReply,
	parseBotUpdateReply,
	type BotChanges,
	type BotFile,
	type BotItemAction,
	type BotItemPage,
	type BotItemRow,
	type BotSuggestion,
	type BotUpdateOutcome,
	type MobileBot,
} from './bots.js';

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;

/** 送った結果。断られたら `code`（PC の要求の断り）。 */
export type BotResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string | undefined };

interface BotPageState {
	/** `pcId\0botId` ごとの項目の一覧と提案。 */
	readonly items: Readonly<Record<string, readonly BotItemRow[]>>;
	readonly suggestions: Readonly<Record<string, readonly BotSuggestion[]>>;
	/** `pcId\0uid` ごとの項目のページ。 */
	readonly pages: Readonly<Record<string, BotItemPage>>;
	/** `pcId\0botId\0path` ごとのファイルの中身。 */
	readonly files: Readonly<Record<string, string>>;
	/** `pcId\0botId` ごとの、項目の一覧を最後に取りに行って取れなかった印（取れたら外す）。 */
	readonly failed: Readonly<Record<string, true>>;
}

export const useBotPages = create<BotPageState>(() => ({ items: {}, suggestions: {}, pages: {}, files: {}, failed: {} }));

export function botKey(pcId: string, botId: string): string {
	return `${pcId}\u0000${botId}`;
}

export function botFileKey(pcId: string, botId: string, path: BotFile): string {
	return `${pcId}\u0000${botId}\u0000${path}`;
}

function put<K extends keyof BotPageState>(slot: K, key: string, value: BotPageState[K][string]): void {
	useBotPages.setState(state => ({ [slot]: { ...state[slot], [key]: value } }) as Partial<BotPageState>);
}

async function call<T>(pcId: string, body: { readonly t: string; readonly [key: string]: unknown }, timeoutMs: number, parse: (reply: unknown) => T | undefined): Promise<BotResult<T>> {
	try {
		const value = parse(await sendPcRequest(pcId, 'fs', body, { timeoutMs }));
		return value !== undefined ? { ok: true, value } : { ok: false, code: 'invalid' };
	} catch (error) {
		return { ok: false, code: error instanceof PcReplyError ? error.code : undefined };
	}
}

/** 項目の一覧と提案を取り直す。 */
export async function refreshBotPage(pcId: string, botId: string): Promise<void> {
	const key = botKey(pcId, botId);
	const [items, suggestions] = await Promise.all([
		call(pcId, botItemsRequest(botId), READ_TIMEOUT_MS, parseBotItemsReply),
		call(pcId, botSuggestionsRequest(botId), READ_TIMEOUT_MS, parseBotSuggestionsReply),
	]);
	if (items.ok) {
		put('items', key, items.value);
	}
	useBotPages.setState(state => {
		if (items.ok === !(key in state.failed)) {
			return state;
		}
		const { [key]: _removed, ...rest } = state.failed;
		return { failed: items.ok ? rest : { ...rest, [key]: true } };
	});
	if (suggestions.ok) {
		put('suggestions', key, suggestions.value);
	}
}

/** 項目のページを取り直す。 */
export async function refreshBotItem(pcId: string, uid: string): Promise<BotResult<BotItemPage>> {
	const result = await call(pcId, botItemRequest(uid), READ_TIMEOUT_MS, parseBotItemReply);
	if (result.ok) {
		put('pages', botKey(pcId, uid), result.value);
	}
	return result;
}

/** 項目の操作（コメント・完了・取り消し・後回し）。当たったら一覧とページを取り直す。 */
export async function actOnBotItem(pcId: string, botId: string, uid: string, act: BotItemAction, opId: string = newBotOpId()): Promise<BotResult<true>> {
	const result = await call(pcId, botItemActRequest(opId, uid, act), WRITE_TIMEOUT_MS, parseBotItemActReply);
	if (result.ok) {
		// 当たった（再送の duplicate でも）。一覧とページを読み直して、今の値で確かめる
		void refreshBotPage(pcId, botId);
		void refreshBotItem(pcId, uid);
		return { ok: true, value: true };
	}
	return result;
}

/** 提案を始める・見送る。始めたら依頼の文を返す（会話の入力欄へ送らずに入れる）。 */
export async function actOnBotSuggestion(pcId: string, botId: string, id: string, action: BotSuggestionAction, opId: string = newBotOpId()): Promise<BotResult<string | undefined>> {
	const result = await call(pcId, botSuggestionActRequest(opId, id, action), WRITE_TIMEOUT_MS, parseBotSuggestionActReply);
	if (!result.ok) {
		return result;
	}
	// 再送の duplicate でも一覧を読み直して確かめる（中身の無い duplicate は古い PC。依頼の文は返らない）
	void refreshBotPage(pcId, botId);
	return { ok: true, value: result.value === 'duplicate' ? undefined : result.value.request };
}

/** ファイルを読む。 */
export async function readBotFile(pcId: string, botId: string, path: BotFile): Promise<BotResult<string>> {
	const result = await call(pcId, botFileReadRequest(botId, path), READ_TIMEOUT_MS, parseBotFileReply);
	if (!result.ok) {
		return result;
	}
	if (result.value === 'duplicate') {
		return { ok: false, code: 'invalid' };
	}
	put('files', botFileKey(pcId, botId, path), result.value.text);
	return { ok: true, value: result.value.text };
}

/** MEMORY.md を書く。ほかの場所が書き換えていたら書かずに `conflict`（今の中身は読み直して入れる）。 */
export async function writeBotFile(pcId: string, botId: string, path: BotFile, text: string, base: string, opId: string = newBotOpId()): Promise<BotResult<'written' | 'conflict'>> {
	const result = await call(pcId, botFileWriteRequest(opId, botId, path, text, base), WRITE_TIMEOUT_MS, parseBotFileReply);
	if (!result.ok) {
		return result;
	}
	if (result.value === 'duplicate') {
		// 前の送信の結果が分からない（古い PC）。読み直して、書いた中身になっていれば書けた、違えば書いていない
		const now = await readBotFile(pcId, botId, path);
		if (!now.ok) {
			return now;
		}
		return { ok: true, value: now.value === text ? 'written' : 'conflict' };
	}
	put('files', botFileKey(pcId, botId, path), result.value.text);
	return { ok: true, value: result.value.conflict ? 'conflict' : 'written' };
}

/**
 * 設定を変える。エージェント・権限は `confirmed: false` だと当てずに PC の確認の本文が返る（`confirm`）。確かめたら同じ
 * `opId` で `confirmed: true` を送り直す。
 */
export function updateBot(pcId: string, botId: string, changes: BotChanges, confirmed: boolean, opId: string): Promise<BotResult<BotUpdateOutcome>> {
	return call(pcId, botUpdateRequest(opId, botId, changes, confirmed), WRITE_TIMEOUT_MS, parseBotUpdateReply);
}

/** PC でその Bot のペインを前に出す（無ければ起動する）。 */
export function openBotOnPc(pcId: string, botId: string, opId: string = newBotOpId()): Promise<BotResult<true>> {
	return call(pcId, botOpenRequest(opId, botId), WRITE_TIMEOUT_MS, reply => {
		const input = reply as { ok?: unknown; duplicate?: unknown } | undefined;
		return input?.ok === true || input?.duplicate === true ? true : undefined;
	});
}

/**
 * Bot の数・最後に動いた時刻が変わったら、項目の一覧と提案を取り直す（開いている間だけ）。`bot` が無い（届いていない）
 * ときは何もしない。
 */
export function useBotPageSync(pcId: string | undefined, bot: MobileBot | undefined, connected: boolean): void {
	const signature = bot !== undefined ? `${bot.needsYou}:${bot.openItems}:${bot.openSuggestions}:${bot.lastActivityAt}:${bot.activity}` : undefined;
	const botId = bot?.id;
	useEffect(() => {
		if (pcId !== undefined && botId !== undefined && connected && signature !== undefined) {
			void refreshBotPage(pcId, botId);
		}
	}, [pcId, botId, connected, signature]);
}
