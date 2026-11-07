/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「AI コスト」の画面のコンテキストの内訳（Claude Code の `/context` と同じもの）を描く。
// - 右の列の先頭の「動いているセッション」のカード（行を押すと内訳）
// - 「最近のセッション」の行を押したときに開く、保存した最後の内訳
// 内訳は同梱の mod が応答の終わりごとに取り、shared process が会話ごとに最後の 1 件を保存している
// （src/vs/paradis/contrib/claudeMod/node/paradisClaudeContextStore.ts）。描くだけで、取りに行くのは呼び出し側。

import * as dom from '../../../../base/browser/dom.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { IParadisClaudeContextBreakdown, IParadisClaudeContextRow } from '../../claudeMod/common/paradisClaudeContextBreakdown.js';
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

function categoryColor(name: string, options: IParadisContextViewOptions): string {
	const index = CATEGORY_COLOR_INDEX[name];
	return index !== undefined && index >= 0 ? options.palette[index % options.palette.length] : options.otherColor;
}

/** 行の見出し（作業フォルダの名前。無ければ会話の id の頭）。 */
function sessionLabel(breakdown: IParadisClaudeContextBreakdown): string {
	return breakdown.cwd !== undefined ? basename(breakdown.cwd) : breakdown.sessionId.slice(0, 8);
}

function percentText(tokens: number, window: number): string {
	return `${(tokens / Math.max(1, window) * 100).toFixed(1)}%`;
}

/** 押すと開く行にする（クリックと Enter・Space）。 */
function makeToggle(row: HTMLElement, expanded: boolean, toggle: () => void, disposables: DisposableStore): void {
	row.setAttribute('role', 'button');
	row.tabIndex = 0;
	row.setAttribute('aria-expanded', String(expanded));
	disposables.add(dom.addDisposableListener(row, dom.EventType.CLICK, toggle));
	disposables.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggle();
		}
	}));
}

/**
 * 「動いているセッション」のカード。`live` が undefined なら読み込み中、`error` があれば取れなかった。
 * 行は会話ごとで、押すと {@link paradisRenderContextBreakdown} を開く。
 */
export function paradisRenderContextLiveCard(
	card: HTMLElement,
	live: readonly IParadisClaudeContextBreakdown[] | undefined,
	error: string | undefined,
	expanded: ReadonlySet<string>,
	onToggle: (sessionId: string) => void,
	options: IParadisContextViewOptions,
): void {
	card.classList.add('paradis-ccusage-context-card');
	dom.append(card, $('h3')).textContent = localize('paradis.ccusage.context.title', "動いているセッション");
	dom.append(card, $('.desc')).textContent = localize('paradis.ccusage.context.desc', "Claude Code のコンテキストの使用率・行を押すと内訳");
	if (error !== undefined) {
		dom.append(card, $('.paradis-ccusage-note')).textContent = localize('paradis.ccusage.context.error', "内訳を読み込めませんでした: {0}", error);
		return;
	}
	if (live === undefined) {
		dom.append(card, $('.paradis-ccusage-note')).textContent = localize('paradis.ccusage.context.loading', "読み込んでいます…");
		return;
	}
	if (live.length === 0) {
		dom.append(card, $('.paradis-ccusage-note')).textContent = localize('paradis.ccusage.context.none', "Para Code のターミナルで動いている Claude Code の会話はありません。応答が終わると出ます。");
		return;
	}
	for (const breakdown of live) {
		const open = expanded.has(breakdown.sessionId);
		const row = dom.append(card, $('.paradis-ccusage-context-row'));
		row.title = breakdown.cwd ?? breakdown.sessionId;
		dom.append(row, $('span.chevron')).textContent = open ? '▾' : '▸';
		const name = dom.append(row, $('span.name'));
		name.textContent = breakdown.model !== undefined
			? localize('paradis.ccusage.context.rowName', "{0} · {1}", sessionLabel(breakdown), breakdown.model)
			: sessionLabel(breakdown);
		const track = dom.append(row, $('.track'));
		const fill = dom.append(track, $('.fill'));
		fill.style.width = `${Math.min(100, Math.max(1, breakdown.percent))}%`;
		fill.style.background = options.palette[0];
		dom.append(row, $('span.val')).textContent = `${breakdown.percent}%`;
		makeToggle(row, open, () => onToggle(breakdown.sessionId), options.disposables);
		if (open) {
			paradisRenderContextBreakdown(dom.append(card, $('.paradis-ccusage-context-open')), breakdown, options);
		}
	}
	dom.append(card, $('.paradis-ccusage-note.paradis-ccusage-context-foot')).textContent = localize('paradis.ccusage.context.foot', "Para Code のターミナルの Claude Code だけ（Codex のペインは出ません）");
}

/** 内訳 1 件（帯・カテゴリ・メモリファイル・MCP サーバー・エージェント・スキル）。 */
export function paradisRenderContextBreakdown(container: HTMLElement, breakdown: IParadisClaudeContextBreakdown, options: IParadisContextViewOptions): void {
	const head = dom.append(container, $('.paradis-ccusage-context-head'));
	dom.append(head, $('span.total')).textContent = localize('paradis.ccusage.context.total', "{0}%（{1} / {2}）", breakdown.percent, paradisFormatTokens(breakdown.totalTokens), paradisFormatTokens(breakdown.window));
	dom.append(head, $('span.at')).textContent = localize('paradis.ccusage.context.at', "取得: {0}", fromNow(breakdown.at, true));

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

	appendRows(container, localize('paradis.ccusage.context.memoryFiles', "メモリファイル"), breakdown.memoryFiles, row => row.name);
	appendRows(container, localize('paradis.ccusage.context.mcpServers', "MCP サーバー"), breakdown.mcpServers, row => row.count !== undefined
		? localize('paradis.ccusage.context.mcpServer', "{0}（ツール {1}）", row.name, row.count)
		: row.name);
	appendRows(container, localize('paradis.ccusage.context.agents', "カスタムエージェント"), breakdown.agents, row => row.name);
	appendRows(container, localize('paradis.ccusage.context.skills', "スキル"), breakdown.skills, row => row.name);
}

function appendRows(container: HTMLElement, title: string, rows: readonly IParadisClaudeContextRow[], label: (row: IParadisClaudeContextRow) => string): void {
	if (rows.length === 0) {
		return;
	}
	const section = dom.append(container, $('.paradis-ccusage-context-section'));
	const heading = dom.append(section, $('.heading'));
	dom.append(heading, $('span')).textContent = title;
	dom.append(heading, $('span.total')).textContent = paradisFormatTokens(rows.reduce((sum, row) => sum + row.tokens, 0));
	for (const row of rows.slice(0, SHOWN_ROWS)) {
		const line = dom.append(section, $('.paradis-ccusage-context-item'));
		const name = dom.append(line, $('span.name'));
		name.textContent = label(row);
		name.title = row.detail !== undefined ? `${row.name}\n${row.detail}` : row.name;
		dom.append(line, $('span.tokens')).textContent = paradisFormatTokens(row.tokens);
	}
	if (rows.length > SHOWN_ROWS) {
		dom.append(section, $('.paradis-ccusage-context-more')).textContent = localize('paradis.ccusage.context.more', "ほか {0} 件", rows.length - SHOWN_ROWS);
	}
}
