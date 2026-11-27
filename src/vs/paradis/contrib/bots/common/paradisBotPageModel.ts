/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページ（paradisBotPage.ts）の、DOM を持たない決まり。項目の群の分け方、状態の名前、問いへの答えの組み立てを
// ここに集め、単体テストで値を確かめる。

import { localize } from '../../../../nls.js';
import type { IParadisAgentChatHeaderState } from '../../agentChat/common/paradisAgentChatHeader.js';
import type { IParadisBotSummary } from './paradisBotsApi.js';
import type { IParadisBotGithubView } from './paradisBotGithub.js';
import { paradisBotStatusLine } from './paradisBotsBandModel.js';
import type { ParadisHumanAskAnswer } from '../../humanAsk/common/paradisHumanAsk.js';
import { IParadisBotItem, IParadisBotItemAsk, paradisBotItemStatus, paradisBotItemWaitsForOwner, paradisIsBotItemClosed, paradisIsBotItemSnoozed } from './paradisBotItems.js';

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

/** 問いのカードで選んだもの。`options` は問いごとの選んだ選択肢の添字、`texts` は自分で書いた文。 */
export interface IParadisBotAskSelection {
	readonly options: readonly (readonly number[])[];
	readonly texts: readonly string[];
}

/**
 * 選んだものを「聞く・答える」の台帳の答えにする（受信箱と同じ形。問いの id は `q1`…、選択肢は `o1`…）。
 * 問いが無い（見てほしいだけ）ときは 1 つ目の文を答えにする。何も選ばず何も書いていなければ undefined。
 */
export function paradisBotAskAnswer(ask: Pick<IParadisBotItemAsk, 'questions'>, selection: IParadisBotAskSelection): ParadisHumanAskAnswer | undefined {
	const count = Math.max(1, ask.questions.length);
	const answers = [];
	for (let index = 0; index < count; index++) {
		const optionIds = (selection.options[index] ?? []).filter(option => option >= 0 && option < (ask.questions[index]?.options.length ?? 0)).map(option => `o${option + 1}`);
		const text = selection.texts[index]?.trim() ?? '';
		if (optionIds.length > 0 || text.length > 0) {
			answers.push({ questionId: `q${index + 1}`, ...(optionIds.length > 0 ? { optionIds } : {}), ...(text.length > 0 ? { text } : {}) });
		}
	}
	return answers.length > 0 ? { type: 'answers', answers } : undefined;
}

/** 問いのカードで選択肢を押したときの、次の選び方（1 つだけの問いは置き換え、複数選べる問いは足す・外す）。 */
export function paradisBotAskToggle(current: readonly number[], option: number, multi: boolean): number[] {
	if (!multi) {
		return current.length === 1 && current[0] === option ? [] : [option];
	}
	return current.includes(option) ? current.filter(value => value !== option) : [...current, option].sort((a, b) => a - b);
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

/**
 * 設定のタブの「GitHub を見張る」の下に出す様子（止まっている理由）。見張っていない Bot には出さない。`time` は再開の時刻を
 * 文にする（テストで固定するため渡す）。`attention` は止まっていて人の手が要るもの。
 */
export function paradisBotGithubStatusText(bot: Pick<IParadisBotSummary, 'watchGithub' | 'paused'>, view: IParadisBotGithubView | undefined, time: (at: number) => string): { readonly text: string; readonly attention: boolean } | undefined {
	if (bot.watchGithub !== true) {
		return undefined;
	}
	if (bot.paused) {
		return { text: localize('paradis.botPage.github.paused', "一時停止中は見張りません。"), attention: false };
	}
	const status = view?.status;
	switch (status?.state) {
		case 'ok': return { text: localize('paradis.botPage.github.ok', "5 分ごとに確かめています。"), attention: false };
		case 'no-gh': return { text: localize('paradis.botPage.github.noGh', "gh が見つからないため止まっています。gh を入れてから、見張りを入れ直すか Para Code を再起動してください。"), attention: true };
		case 'auth': return { text: localize('paradis.botPage.github.auth', "gh にログインしていないため止まっています。ターミナルで gh auth login を実行してから、見張りを入れ直してください。"), attention: true };
		case 'rate-limited': return { text: localize('paradis.botPage.github.rateLimited', "GitHub の枠を使い切ったため、{0} まで止まっています。", time(status.retryAt)), attention: true };
		case 'failed': return { text: localize('paradis.botPage.github.failed', "読めませんでした。{0} に読み直します。", time(status.retryAt)), attention: true };
		default: return { text: localize('paradis.botPage.github.starting', "見張りを始めています。"), attention: false };
	}
}
