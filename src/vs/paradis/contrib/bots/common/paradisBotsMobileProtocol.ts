/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホの Bot の画面（設計の PR 16、`bots.page.v1`）の fs の要求の形。要求の検め・応答に載せる形をここに集め、
// 単体テストで値を確かめる（モバイルは信用しない相手として扱う）。処理は electron-browser/paradisBotsMobileRequests.ts。

import { isPlainRecord } from '../../../common/paradisGuards.js';
import { IParadisBotItem, paradisBotItemWaitsForOwner } from './paradisBotItems.js';
import { IParadisBotUpdateArgs, paradisParseBotUpdateArgs } from './paradisBotManageTools.js';
import type { IParadisBotSuggestion } from './paradisBotSuggestions.js';

export const PARADIS_MOBILE_BOT_KINDS = Object.freeze({
	items: 'botItems',
	item: 'botItem',
	itemAct: 'botItemAct',
	suggestions: 'botSuggestions',
	suggestionAct: 'botSuggestionAct',
	file: 'botFile',
	update: 'botUpdate',
	open: 'botOpen',
});

export const PARADIS_MOBILE_BOT_LIMITS = Object.freeze({
	/** 一覧で返す項目の数（台帳の 1 Bot の開いている項目の上限と同じ）。 */
	items: 200,
	/** 項目のページで返す記録の数（新しい方から）。 */
	events: 100,
	/** 送る opId の長さ。 */
	opId: 100,
});

/** スマホで読み書きできる専用フォルダのファイル（SOUL.md は読むだけ。役割の書き換えは botUpdate で確かめてから）。 */
export const PARADIS_MOBILE_BOT_FILES: Readonly<Record<string, { readonly writable: boolean }>> = Object.freeze({
	'SOUL.md': { writable: false },
	'MEMORY.md': { writable: true },
});

function text(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') ? value : undefined;
}

/** id・opId のような短い文字列。 */
export function paradisMobileBotId(value: unknown): string | undefined {
	return text(value, 200);
}

export function paradisMobileBotOpId(value: unknown): string | undefined {
	return text(value, PARADIS_MOBILE_BOT_LIMITS.opId);
}

/** 一覧の 1 行（項目のページは botItem で取る）。 */
export interface IParadisMobileBotItemRow {
	readonly uid: string;
	readonly number: number;
	readonly title: string;
	readonly status: string;
	/** あなたの番（Bot の問いが待っている）。答えは PR 6 の「聞く・答える」の経路で送る。 */
	readonly waits: boolean;
	readonly snoozedUntil?: number;
	readonly lastActivityAt: number;
	readonly closedAt?: number;
}

export function paradisMobileBotItemRow(item: IParadisBotItem, now: number): IParadisMobileBotItemRow {
	return {
		uid: item.uid,
		number: item.number,
		title: item.title,
		status: item.status,
		waits: paradisBotItemWaitsForOwner(item, now),
		...(item.snoozedUntil !== undefined ? { snoozedUntil: item.snoozedUntil } : {}),
		lastActivityAt: item.lastActivityAt,
		...(item.closedAt !== undefined ? { closedAt: item.closedAt } : {}),
	};
}

/** 項目のページに送る形（読んだままの値 `preserved` は送らない。記録は新しい方から上限まで）。 */
export function paradisMobileBotItemPage(item: IParadisBotItem): Omit<IParadisBotItem, 'preserved'> & { readonly locked?: true } {
	const { preserved, events, ...rest } = item;
	return {
		...rest,
		events: events.slice(-PARADIS_MOBILE_BOT_LIMITS.events),
		...(preserved !== undefined ? { locked: true } : {}),
	};
}

/** 提案の 1 行（見回りのペインのハッシュ `run` は送らない）。 */
export function paradisMobileBotSuggestion(suggestion: IParadisBotSuggestion): { readonly id: string; readonly title: string; readonly request: string; readonly state: string; readonly createdAt: number } {
	return { id: suggestion.id, title: suggestion.title, request: suggestion.request, state: suggestion.state, createdAt: suggestion.createdAt };
}

export type ParadisMobileBotItemAction =
	| { readonly action: 'comment'; readonly text: string }
	| { readonly action: 'done' | 'cancel' }
	| { readonly action: 'snooze'; readonly until: number }
	| { readonly action: 'unsnooze' };

/** botItemAct の要求。コメントは問いへの答えにしない（答えは「聞く・答える」の台帳の経路）。 */
export function paradisParseMobileBotItemAct(request: Record<string, unknown>, now: number): { readonly opId: string; readonly uid: string; readonly act: ParadisMobileBotItemAction } | undefined {
	const opId = paradisMobileBotOpId(request.opId);
	const uid = paradisMobileBotId(request.uid);
	if (opId === undefined || uid === undefined) {
		return undefined;
	}
	switch (request.action) {
		case 'comment': {
			const body = text(request.text, 8_000);
			return body !== undefined && body.trim().length > 0 ? { opId, uid, act: { action: 'comment', text: body } } : undefined;
		}
		case 'done':
		case 'cancel':
			return { opId, uid, act: { action: request.action } };
		case 'snooze':
			return typeof request.until === 'number' && Number.isFinite(request.until) && request.until > now ? { opId, uid, act: { action: 'snooze', until: request.until } } : undefined;
		case 'unsnooze':
			return { opId, uid, act: { action: 'unsnooze' } };
		default:
			return undefined;
	}
}

/**
 * botUpdate の要求を、管理の道具 update_bot と同じ変更にする（同じ検め・同じ「確かめる」規則）。`changes` の欄の名前も
 * update_bot と同じ（name・agent・permission・role・model・effort・face_color・face_shape・pinned・paused）。
 */
export function paradisParseMobileBotUpdate(request: Record<string, unknown>): { readonly ok: true; readonly args: IParadisBotUpdateArgs; readonly confirmed: boolean; readonly opId?: string } | { readonly ok: false; readonly message: string } {
	const botId = paradisMobileBotId(request.botId);
	if (botId === undefined || !isPlainRecord(request.changes) || request.changes.bot !== undefined) {
		return { ok: false, message: 'botUpdate needs botId and changes.' };
	}
	const parsed = paradisParseBotUpdateArgs({ ...request.changes, bot: botId });
	if (!parsed.ok) {
		return { ok: false, message: parsed.message };
	}
	const opId = paradisMobileBotOpId(request.opId);
	return { ok: true, args: parsed.value, confirmed: request.confirmed === true, ...(opId !== undefined ? { opId } : {}) };
}
