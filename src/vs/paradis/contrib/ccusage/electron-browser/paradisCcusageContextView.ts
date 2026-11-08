/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「AI コスト」の画面のコンテキストの内訳（Claude Code の `/context` と同じもの）を描く。
// - 右の列の先頭の、選んでいる期間で集計した内訳のカード（会話ごとの一番大きかった時点で集計）
// - 「最近のセッション」の行を押したときに開く、保存した最後の内訳
// 内訳は同梱の mod が応答の終わりごとに取り、shared process が会話ごとに最後の 1 件を保存している
// （src/vs/paradis/contrib/claudeMod/node/paradisClaudeContextStore.ts）。描くだけで、取りに行くのは呼び出し側。

import './media/paradisCcusage.css';
import * as dom from '../../../../base/browser/dom.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisClaudeContextBreakdown, IParadisClaudeContextPeriod, IParadisClaudeContextPeriodItem, IParadisClaudeContextRow } from '../../claudeMod/common/paradisClaudeContextBreakdown.js';
import { paradisFormatTokens } from '../common/paradisCcusageFormat.js';

const $ = dom.$;

/** 内訳の一覧ごとに出す行数（保存は 20 行まで）。 */
const SHOWN_ROWS = 5;

/** Claude Code のカテゴリの名前 → 帯の色（チャートの系列の色から選ぶ。知らない名前は灰色）。 */
const CATEGORY_COLOR_INDEX: Readonly<Record<string, number>> = {
	'Messages': 3,
	'Memory files': 5,
	'MCP tools': 1,
	'MCP server instructions': 7,
	'Skills': 2,
	'Custom agents': 0,
	'System prompt': -1,
	'System tools': -1,
};

export interface IParadisContextViewOptions {
	readonly palette: readonly string[];
	readonly otherColor: string;
	readonly disposables: DisposableStore;
}

function categoryColor(name: string, options: Pick<IParadisContextViewOptions, 'palette' | 'otherColor'>): string {
	const index = CATEGORY_COLOR_INDEX[name];
	return index !== undefined && index >= 0 ? options.palette[index % options.palette.length] : options.otherColor;
}

function percentText(tokens: number, window: number): string {
	return `${(tokens / Math.max(1, window) * 100).toFixed(1)}%`;
}

/** 期間の内訳のカードに渡す状態。`period` が undefined なら読み込み中。 */
export interface IParadisContextPeriodCardInput {
	/** カードの見出し（「コンテキストの内訳（直近30日間）」）。 */
	readonly title: string;
	readonly period: IParadisClaudeContextPeriod | undefined;
	readonly error: string | undefined;
	/** この期間の Claude Code の会話の数（ccusage の最近のセッションと同じ数え方）。母数がそろわない SSH の窓では undefined。 */
	readonly conversationsInRange: number | undefined;
}

/**
 * 「AI コスト」の右の列の先頭の、期間で集計したコンテキストの内訳（q.html Q576 案 A）。会話ごとの一番大きかった時点
 * （`/compact` の前の山）の内訳を集め、カテゴリごとの 1 会話あたり平均と最大、会話以外の「毎回かかる分」、
 * メモリファイル・MCP サーバー・スキル・エージェントごとに何会話で読まれたかと 1 会話あたりを出す。
 */
export function paradisRenderContextPeriodCard(card: HTMLElement, input: IParadisContextPeriodCardInput, options: IParadisContextViewOptions): void {
	card.classList.add('paradis-ccusage-context-card');
	dom.append(card, $('h3')).textContent = input.title;
	dom.append(card, $('.desc')).textContent = localize('paradis.ccusage.contextPeriod.desc', "会話ごとの一番大きかった時点で集計・行の値は 1 会話あたり");
	if (input.error !== undefined) {
		dom.append(card, $('.paradis-ccusage-note')).textContent = localize('paradis.ccusage.context.error', "内訳を読み込めませんでした: {0}", input.error);
		return;
	}
	const period = input.period;
	if (period === undefined) {
		dom.append(card, $('.paradis-ccusage-note')).textContent = localize('paradis.ccusage.context.loading', "読み込んでいます…");
		return;
	}
	const since = period.since !== undefined ? new Date(period.since) : undefined;
	const coverage = dom.append(card, $('.paradis-ccusage-context-coverage'));
	const inRange = input.conversationsInRange;
	if (inRange === undefined) {
		// SSH の窓: ccusage は接続先の会話だけを数えるので、手元の保存（どのマシンの会話も入る）と比べない
		coverage.textContent = since !== undefined
			? localize('paradis.ccusage.contextPeriod.coverageLocal', "この PC の Para Code で見た会話 {0} 件分（内訳の保存は {1}/{2} から）", period.conversations, since.getMonth() + 1, since.getDate())
			: localize('paradis.ccusage.contextPeriod.coverageLocalNone', "この PC の Para Code で見た会話の内訳はまだ保存されていません");
	} else {
		coverage.textContent = since !== undefined
			? localize('paradis.ccusage.contextPeriod.coverage', "この期間の Claude Code の会話 {0} 件のうち {1} 件分（内訳の保存は {2}/{3} から）", Math.max(inRange, period.conversations), period.conversations, since.getMonth() + 1, since.getDate())
			: localize('paradis.ccusage.contextPeriod.coverageNone', "この期間の Claude Code の会話 {0} 件のうち 0 件分（内訳はまだ保存されていません）", inRange);
	}
	if (period.conversations === 0) {
		dom.append(card, $('.paradis-ccusage-note')).textContent = localize('paradis.ccusage.contextPeriod.none', "この期間に内訳を保存した会話はありません。内訳は Para Code のターミナルの Claude Code で応答が終わるたびに残ります。");
		return;
	}

	const head = dom.append(card, $('.paradis-ccusage-context-head'));
	dom.append(head, $('span.total')).textContent = period.window !== undefined
		? localize('paradis.ccusage.contextPeriod.average', "平均 {0}%（{1} / {2}）", period.averagePercent, paradisFormatTokens(period.averageTokens), paradisFormatTokens(period.window))
		: localize('paradis.ccusage.contextPeriod.averageNoWindow', "平均 {0}%（{1}）", period.averagePercent, paradisFormatTokens(period.averageTokens));
	dom.append(head, $('span.at')).textContent = localize('paradis.ccusage.contextPeriod.max', "最大 {0}%", period.maxPercent);

	const stack = dom.append(card, $('.paradis-ccusage-context-stack'));
	for (const category of period.categories.filter(entry => entry.kind === 'used' && entry.average > 0)) {
		const part = dom.append(stack, $('span'));
		part.style.width = `${category.share}%`;
		part.style.background = categoryColor(category.name, options);
		part.title = `${category.name} ${paradisFormatTokens(category.average)}`;
	}

	const fixed = dom.append(card, $('.paradis-ccusage-context-fixed'));
	dom.append(fixed, $('span')).textContent = localize('paradis.ccusage.contextPeriod.fixed', "毎回かかる分（会話以外）");
	dom.append(fixed, $('span.tokens')).textContent = localize('paradis.ccusage.contextPeriod.fixedValue', "平均 {0}", paradisFormatTokens(period.fixedAverage));

	const list = dom.append(card, $('.paradis-ccusage-context-list'));
	const header = dom.append(list, $('.paradis-ccusage-context-cat.wide.heading'));
	dom.append(header, $('span.key'));
	dom.append(header, $('span.name')).textContent = localize('paradis.ccusage.contextPeriod.category', "カテゴリ");
	dom.append(header, $('span.tokens')).textContent = localize('paradis.ccusage.contextPeriod.averageColumn', "平均");
	dom.append(header, $('span.tokens')).textContent = localize('paradis.ccusage.contextPeriod.maxColumn', "最大");
	dom.append(header, $('span.share')).textContent = localize('paradis.ccusage.contextPeriod.shareColumn', "割合");
	for (const category of period.categories.filter(entry => entry.average > 0 || entry.max > 0)) {
		const used = category.kind === 'used';
		const row = dom.append(list, $(used ? '.paradis-ccusage-context-cat.wide' : '.paradis-ccusage-context-cat.wide.dim'));
		const key = dom.append(row, $('span.key'));
		if (used) {
			key.style.background = categoryColor(category.name, options);
		}
		dom.append(row, $('span.name')).textContent = category.name;
		dom.append(row, $('span.tokens')).textContent = paradisFormatTokens(category.average);
		dom.append(row, $('span.tokens')).textContent = paradisFormatTokens(category.max);
		dom.append(row, $('span.share')).textContent = `${category.share.toFixed(1)}%`;
	}

	appendPeriodItems(card, localize('paradis.ccusage.context.memoryFiles', "メモリファイル"), period.memoryFiles, period.conversations, item => item.name);
	appendPeriodItems(card, localize('paradis.ccusage.context.mcpServers', "MCP サーバー"), period.mcpServers, period.conversations, item => item.count !== undefined
		? localize('paradis.ccusage.context.mcpServer', "{0}（ツール {1}）", item.name, item.count)
		: item.name);
	appendPeriodItems(card, localize('paradis.ccusage.context.skills', "スキル"), period.skills, period.conversations, item => item.name);
	appendPeriodItems(card, localize('paradis.ccusage.context.agents', "カスタムエージェント"), period.agents, period.conversations, item => item.name);
	dom.append(card, $('.paradis-ccusage-note.paradis-ccusage-context-foot')).textContent = localize('paradis.ccusage.contextPeriod.foot', "Para Code のターミナルの Claude Code だけ（Codex の会話は数えません）");
}

function appendPeriodItems(card: HTMLElement, title: string, items: readonly IParadisClaudeContextPeriodItem[], conversations: number, label: (item: IParadisClaudeContextPeriodItem) => string): void {
	if (items.length === 0) {
		return;
	}
	const section = dom.append(card, $('.paradis-ccusage-context-section'));
	const heading = dom.append(section, $('.heading'));
	dom.append(heading, $('span')).textContent = title;
	dom.append(heading, $('span.total')).textContent = localize('paradis.ccusage.contextPeriod.itemColumns', "会話・1 会話あたり");
	for (const item of items.slice(0, SHOWN_ROWS)) {
		const line = dom.append(section, $('.paradis-ccusage-context-item.period'));
		const name = dom.append(line, $('span.name'));
		name.textContent = label(item);
		name.title = item.detail !== undefined ? `${item.name}\n${item.detail}` : item.name;
		dom.append(line, $('span.tokens')).textContent = localize('paradis.ccusage.contextPeriod.itemConversations', "{0} / {1}", item.conversations, conversations);
		dom.append(line, $('span.tokens')).textContent = paradisFormatTokens(item.average);
	}
	if (items.length > SHOWN_ROWS) {
		dom.append(section, $('.paradis-ccusage-context-more')).textContent = localize('paradis.ccusage.context.more', "ほか {0} 件", items.length - SHOWN_ROWS);
	}
}

/** 内訳 1 件（帯・カテゴリ・メモリファイル・MCP サーバー・エージェント・スキル）。 */
export function paradisRenderContextBreakdown(container: HTMLElement, breakdown: IParadisClaudeContextBreakdown, options: IParadisContextViewOptions): void {
	const head = dom.append(container, $('.paradis-ccusage-context-head'));
	dom.append(head, $('span.total')).textContent = localize('paradis.ccusage.context.total', "{0}%（{1} / {2}）", breakdown.percent, paradisFormatTokens(breakdown.totalTokens), paradisFormatTokens(breakdown.window));
	dom.append(head, $('span.at')).textContent = localize('paradis.ccusage.context.at', "取得: {0}", fromNow(breakdown.at, true));
	paradisRenderContextCategories(container, breakdown, options);
	paradisRenderContextRowGroups(container, breakdown, false);
}

/** 内訳のカテゴリの帯と、カテゴリごとの行（使用率に数える分は多い順、ほかは薄く）。 */
export function paradisRenderContextCategories(container: HTMLElement, breakdown: IParadisClaudeContextBreakdown, options: Pick<IParadisContextViewOptions, 'palette' | 'otherColor'>): void {
	const counted = breakdown.categories.filter(category => category.kind === 'used' && category.tokens > 0);
	const buffer = breakdown.categories.filter(category => category.kind === 'buffer' && category.tokens > 0);
	const stack = dom.append(container, $('.paradis-ccusage-context-stack'));
	for (const category of counted) {
		const part = dom.append(stack, $('span'));
		part.style.width = `${category.tokens / breakdown.window * 100}%`;
		part.style.background = categoryColor(category.name, options);
		part.title = `${category.name} ${paradisFormatTokens(category.tokens)}`;
	}
	for (const category of buffer) {
		const part = dom.append(stack, $('span.buffer'));
		part.style.width = `${category.tokens / breakdown.window * 100}%`;
		part.title = `${category.name} ${paradisFormatTokens(category.tokens)}`;
	}

	const list = dom.append(container, $('.paradis-ccusage-context-list'));
	const appendCategory = (name: string, tokens: number, color: string | undefined, dim: boolean) => {
		const row = dom.append(list, $(dim ? '.paradis-ccusage-context-cat.dim' : '.paradis-ccusage-context-cat'));
		const key = dom.append(row, $('span.key'));
		if (color !== undefined) {
			key.style.background = color;
		}
		dom.append(row, $('span.name')).textContent = name;
		dom.append(row, $('span.tokens')).textContent = paradisFormatTokens(tokens);
		dom.append(row, $('span.share')).textContent = percentText(tokens, breakdown.window);
	};
	for (const category of [...counted].sort((a, b) => b.tokens - a.tokens)) {
		appendCategory(category.name, category.tokens, categoryColor(category.name, options), false);
	}
	for (const category of breakdown.categories.filter(entry => entry.kind !== 'used' && entry.tokens > 0)) {
		appendCategory(category.name, category.tokens, undefined, true);
	}
}

/**
 * メモリファイル・MCP サーバー・カスタムエージェント・スキルの一覧。`collapsible` なら見出しで開閉し（最初は閉じている）、
 * 開くと保存してある行をすべて出す。そうでなければ見出しの下に上位 {@link SHOWN_ROWS} 行と「ほか N 件」。
 */
export function paradisRenderContextRowGroups(container: HTMLElement, breakdown: IParadisClaudeContextBreakdown, collapsible: boolean, isOpen?: (group: string) => boolean): void {
	const groups: [string, string, readonly IParadisClaudeContextRow[], (row: IParadisClaudeContextRow) => string][] = [
		['mcpServers', localize('paradis.ccusage.context.mcpServers', "MCP サーバー"), breakdown.mcpServers, row => row.count !== undefined
			? localize('paradis.ccusage.context.mcpServer', "{0}（ツール {1}）", row.name, row.count)
			: row.name],
		['memoryFiles', localize('paradis.ccusage.context.memoryFiles', "メモリファイル"), breakdown.memoryFiles, row => row.name],
		['agents', localize('paradis.ccusage.context.agents', "カスタムエージェント"), breakdown.agents, row => row.name],
		['skills', localize('paradis.ccusage.context.skills', "スキル"), breakdown.skills, row => row.name],
	];
	// AI コストの画面は今までどおりメモリファイルを先に出す
	if (!collapsible) {
		[groups[0], groups[1]] = [groups[1], groups[0]];
	}
	for (const [group, title, rows, label] of groups) {
		appendRows(container, group, title, rows, label, collapsible, isOpen?.(group) ?? false);
	}
}

function appendRows(container: HTMLElement, group: string, title: string, rows: readonly IParadisClaudeContextRow[], label: (row: IParadisClaudeContextRow) => string, collapsible: boolean, open: boolean): void {
	if (rows.length === 0) {
		return;
	}
	const total = paradisFormatTokens(rows.reduce((sum, row) => sum + row.tokens, 0));
	let section: HTMLElement;
	if (collapsible) {
		const details = dom.append(container, $<HTMLDetailsElement>('details.paradis-ccusage-context-section.collapsible'));
		details.dataset.group = group;
		details.open = open;
		const summary = dom.append(details, $('summary.heading'));
		dom.append(summary, $('span.title')).textContent = title;
		dom.append(summary, $('span.total')).textContent = localize('paradis.ccusage.context.groupCount', "{0} 件 · {1}", rows.length, total);
		section = details;
	} else {
		section = dom.append(container, $('.paradis-ccusage-context-section'));
		const heading = dom.append(section, $('.heading'));
		dom.append(heading, $('span')).textContent = title;
		dom.append(heading, $('span.total')).textContent = total;
	}
	const shown = collapsible ? rows : rows.slice(0, SHOWN_ROWS);
	for (const row of shown) {
		const line = dom.append(section, $('.paradis-ccusage-context-item'));
		const name = dom.append(line, $('span.name'));
		name.textContent = label(row);
		name.title = row.detail !== undefined ? `${row.name}\n${row.detail}` : row.name;
		dom.append(line, $('span.tokens')).textContent = paradisFormatTokens(row.tokens);
	}
	if (rows.length > shown.length) {
		dom.append(section, $('.paradis-ccusage-context-more')).textContent = localize('paradis.ccusage.context.more', "ほか {0} 件", rows.length - shown.length);
	}
}
