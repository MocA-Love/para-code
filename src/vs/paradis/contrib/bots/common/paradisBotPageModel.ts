/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページ（paradisBotPage.ts）の、DOM を持たない決まり。項目の群の分け方、状態と記録の名前を
// ここに集め、単体テストで値を確かめる（問いのカードは受信箱のカードそのものを使う）。

import { localize } from '../../../../nls.js';
import type { IParadisAgentChatHeaderState } from '../../agentChat/common/paradisAgentChatHeader.js';
import type { IParadisBotSummary } from './paradisBotsApi.js';
import { paradisBotStatusLine } from './paradisBotsBandModel.js';
import { IParadisBotItem, paradisBotItemStatus, paradisBotItemWaitsForOwner, paradisIsBotItemClosed, paradisIsBotItemSnoozed } from './paradisBotItems.js';

/** ページの上のタブ。`chat` は下にある会話（チャット表示かターミナル）をそのまま見せる。 */
export type ParadisBotPageTab = 'chat' | 'items' | 'files' | 'settings';

export const PARADIS_BOT_PAGE_TABS: readonly ParadisBotPageTab[] = ['chat', 'items', 'files', 'settings'];

/** 項目の一覧の群（上から順に並べる）。 */
export interface IParadisBotItemGroups {
	/** あなたの番（Bot が問いを出して待っているもの）。 */
	readonly you: readonly IParadisBotItem[];
	/** 進行中（作業中・外の返事待ち・問いの無い Needs you）。 */
	readonly working: readonly IParadisBotItem[];
	readonly planned: readonly IParadisBotItem[];
	/** 後回し中（期限まで群から外す）。 */
	readonly snoozed: readonly IParadisBotItem[];
	/** 終了（完了と取りやめ）。 */
	readonly closed: readonly IParadisBotItem[];
}

/** 項目を群に分ける。どの群も動きの新しい順。 */
export function paradisBotItemGroups(items: readonly IParadisBotItem[], now: number): IParadisBotItemGroups {
	const sorted = [...items].sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.number - a.number);
	const you: IParadisBotItem[] = [];
	const working: IParadisBotItem[] = [];
	const planned: IParadisBotItem[] = [];
	const snoozed: IParadisBotItem[] = [];
	const closed: IParadisBotItem[] = [];
	for (const item of sorted) {
		if (paradisIsBotItemClosed(item)) {
			closed.push(item);
		} else if (paradisIsBotItemSnoozed(item, now)) {
			snoozed.push(item);
		} else if (paradisBotItemWaitsForOwner(item, now)) {
			you.push(item);
		} else if (item.status === 'planned') {
			planned.push(item);
		} else {
			working.push(item);
		}
	}
	return { you, working, planned, snoozed, closed };
}

/** 項目の状態の名前（知らない状態はそのまま）。 */
export function paradisBotItemStatusLabel(item: Pick<IParadisBotItem, 'status'>): string {
	switch (paradisBotItemStatus(item)) {
		case 'planned': return localize('paradis.botPage.status.planned', "予定");
		case 'working': return localize('paradis.botPage.status.working', "進行中");
		case 'waiting': return localize('paradis.botPage.status.waiting', "外の返事待ち");
		case 'needs_you': return localize('paradis.botPage.status.needsYou', "あなたの番");
		case 'done': return localize('paradis.botPage.status.done', "完了");
		case 'canceled': return localize('paradis.botPage.status.canceled', "取りやめ");
		default: return item.status;
	}
}

/** 記録の 1 行の文。Bot の書き込みは Bot の名前で書く。 */
export function paradisBotItemEventLabel(event: IParadisBotItem['events'][number], botName: string): string {
	const who = event.actor === 'owner' ? localize('paradis.botPage.event.owner', "あなた") : event.actor === 'bot' ? botName : localize('paradis.botPage.event.system', "Para Code");
	switch (event.kind) {
		case 'made': return localize('paradis.botPage.event.made', "{0}が作りました", who);
		case 'edited': return localize('paradis.botPage.event.edited', "{0}が書き換えました", who);
		case 'status': return localize('paradis.botPage.event.status', "{0}が「{1}」にしました", who, paradisBotItemStatusLabel({ status: event.to ?? '' }));
		case 'commented':
			if (event.skipped) {
				return localize('paradis.botPage.event.skipped', "{0}が問いを飛ばしました", who);
			}
			return event.answers !== undefined
				? localize('paradis.botPage.event.answered', "{0}が答えました: {1}", who, event.text ?? '')
				: localize('paradis.botPage.event.commented', "{0}: {1}", who, event.text ?? '');
		case 'linked': return localize('paradis.botPage.event.linked', "{0}がリンクを足しました", who);
		case 'snoozed': return event.until !== undefined
			? localize('paradis.botPage.event.snoozed', "{0}が後回しにしました", who)
			: localize('paradis.botPage.event.unsnoozed', "{0}が後回しを解きました", who);
		default: return localize('paradis.botPage.event.other', "{0}: {1}", who, event.kind);
	}
}

/**
 * 帯の状態・モデル。`header` はチャット表示の見出しの値（チャット表示を見ている間だけ渡す）。見出しの状態の文があれば
 * それ（許可待ち・質問待ちは attention）、無ければ Bot の台帳の 1 行。モデルは見出しの値だけ（台帳には実際のモデルが無い）。
 */
export function paradisBotStripHeader(bot: IParadisBotSummary, header: Pick<IParadisAgentChatHeaderState, 'status' | 'attention' | 'busy' | 'model'> | undefined): { readonly status: string; readonly attention: boolean; readonly busy: boolean; readonly model: string } {
	const line = paradisBotStatusLine(bot);
	if (header === undefined) {
		return { status: line, attention: false, busy: false, model: '' };
	}
	return { status: header.status || line, attention: header.attention, busy: header.busy && !header.attention, model: header.model };
}
