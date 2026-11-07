/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のコンテキストの内訳（`/context` と同じもの）。同梱の mod が応答の終わりごとに
// `$.session.usage({ breakdown: 'summary' })` で取って送り、shared process が会話ごとに最後の 1 件を保存する
// （paradisClaudeContextStore.ts）。PC の「AI コスト」の画面とモバイル（`agent.context-breakdown.v1`）が同じ形を読む。
//
// ここには両側（renderer・shared process）が使う名前と、届いた値を信用せずに詰め直す純関数だけを置く。

/** shared process のチャネル名。 */
export const PARADIS_CLAUDE_CONTEXT_CHANNEL = 'paradisClaudeContext';

/** 一覧ごとに残す行の上限（多い順）。 */
export const PARADIS_CLAUDE_CONTEXT_MAX_ROWS = 20;
const MAX_CATEGORIES = 24;
const MAX_NAME_CHARS = 200;
const MAX_PATH_CHARS = 1_000;

export type ParadisClaudeContextCategoryKind = 'used' | 'deferred' | 'buffer' | 'free';

export interface IParadisClaudeContextCategory {
	/** Claude Code の表記のまま（`Messages`・`Memory files`・`Free space` など）。 */
	readonly name: string;
	readonly tokens: number;
	/** `used` は使用率に数える分、`deferred` は必要になってから読み込む分（数えない）、`buffer` は自動圧縮の余白、`free` は空き。 */
	readonly kind: ParadisClaudeContextCategoryKind;
}

export interface IParadisClaudeContextRow {
	readonly name: string;
	readonly tokens: number;
	/** メモリファイルの種類（`Project`・`User` など）、エージェント・スキルの出どころ。 */
	readonly detail?: string;
	/** MCP サーバーのツールの数。 */
	readonly count?: number;
}

/** 会話 1 本分の内訳（保存・送信する形）。 */
export interface IParadisClaudeContextBreakdown {
	readonly sessionId: string;
	/** 取った時刻（PC の時計）。 */
	readonly at: number;
	readonly model?: string;
	/** 会話の作業フォルダ（PC の画面の見出し）。 */
	readonly cwd?: string;
	readonly totalTokens: number;
	readonly window: number;
	/** 0〜100。 */
	readonly percent: number;
	readonly categories: readonly IParadisClaudeContextCategory[];
	readonly memoryFiles: readonly IParadisClaudeContextRow[];
	readonly mcpServers: readonly IParadisClaudeContextRow[];
	readonly agents: readonly IParadisClaudeContextRow[];
	readonly skills: readonly IParadisClaudeContextRow[];
}

function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined;
}

function kindOf(value: unknown): ParadisClaudeContextCategoryKind | undefined {
	return value === 'used' || value === 'deferred' || value === 'buffer' || value === 'free' ? value : undefined;
}

function rows(value: unknown, nameLimit: number): IParadisClaudeContextRow[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const parsed: IParadisClaudeContextRow[] = [];
	for (const candidate of value.slice(0, 500)) {
		const row = rec(candidate);
		const name = text(row?.name, nameLimit);
		const tokens = count(row?.tokens);
		if (name === undefined || tokens === undefined) {
			continue;
		}
		const detail = text(row?.detail, MAX_NAME_CHARS);
		const rowCount = count(row?.count);
		parsed.push({ name, tokens, ...(detail !== undefined ? { detail } : {}), ...(rowCount !== undefined ? { count: rowCount } : {}) });
	}
	return parsed.sort((a, b) => b.tokens - a.tokens).slice(0, PARADIS_CLAUDE_CONTEXT_MAX_ROWS);
}

/**
 * mod が送ってきた内訳（`register.ts` の `contextPayload`）を、上限つきで詰め直す。形が違えば undefined。
 * `sessionId`・`at` は受けた側が決める（送り主の言い分は使わない）。
 */
export function paradisParseClaudeContextBreakdown(value: unknown, sessionId: string, at: number): IParadisClaudeContextBreakdown | undefined {
	const raw = rec(value);
	const totalTokens = count(raw?.totalTokens);
	const window = count(raw?.window);
	const percentRaw = raw?.percent;
	if (raw === undefined || totalTokens === undefined || window === undefined || window === 0) {
		return undefined;
	}
	const percent = typeof percentRaw === 'number' && Number.isFinite(percentRaw)
		? Math.min(100, Math.max(0, Math.round(percentRaw)))
		: Math.min(100, Math.round(totalTokens / window * 100));
	const categories: IParadisClaudeContextCategory[] = [];
	if (Array.isArray(raw.categories)) {
		for (const candidate of raw.categories.slice(0, MAX_CATEGORIES)) {
			const category = rec(candidate);
			const name = text(category?.name, MAX_NAME_CHARS);
			const tokens = count(category?.tokens);
			const kind = kindOf(category?.kind);
			if (name !== undefined && tokens !== undefined && kind !== undefined) {
				categories.push({ name, tokens, kind });
			}
		}
	}
	const model = text(raw.model, MAX_NAME_CHARS);
	const cwd = text(raw.cwd, MAX_PATH_CHARS);
	return {
		sessionId, at,
		...(model !== undefined ? { model } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		totalTokens, window, percent, categories,
		memoryFiles: rows(raw.memoryFiles, MAX_PATH_CHARS),
		mcpServers: rows(raw.mcpServers, MAX_NAME_CHARS),
		agents: rows(raw.agents, MAX_NAME_CHARS),
		skills: rows(raw.skills, MAX_NAME_CHARS),
	};
}

/**
 * 絶対パスのホームを `~` に縮める（`home` 自身のほか、SSH 先のホームの形 `/Users/<name>`・`/home/<name>` も）。
 * それ以外のパスはそのまま。
 */
function shortenHome(path: string, home: string): string {
	const trimmedHome = home.replace(/[\\/]+$/, '');
	if (trimmedHome.length > 0 && (path === trimmedHome || path.startsWith(`${trimmedHome}/`) || path.startsWith(`${trimmedHome}\\`))) {
		return `~${path.slice(trimmedHome.length)}`;
	}
	return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/** モバイルへ送る前に、作業フォルダとメモリファイルのパスのホームを `~` に縮める（端末にユーザー名入りのパスを残さない）。 */
export function paradisShortenContextBreakdownPaths(breakdown: IParadisClaudeContextBreakdown, home: string): IParadisClaudeContextBreakdown {
	return {
		...breakdown,
		...(breakdown.cwd !== undefined ? { cwd: shortenHome(breakdown.cwd, home) } : {}),
		memoryFiles: breakdown.memoryFiles.map(row => ({ ...row, name: shortenHome(row.name, home) })),
	};
}

/** 期間の内訳の、カテゴリ 1 つ分（値は 1 会話あたり）。 */
export interface IParadisClaudeContextPeriodCategory {
	readonly name: string;
	readonly kind: ParadisClaudeContextCategoryKind;
	/** 会話あたり平均トークン（そのカテゴリが無い会話は 0 と数える）。 */
	readonly average: number;
	readonly max: number;
	/** 窓に対する平均の割合（0〜100）。 */
	readonly share: number;
}

/** 期間の内訳の、メモリファイル・MCP サーバー・エージェント・スキルの 1 行。 */
export interface IParadisClaudeContextPeriodItem {
	readonly name: string;
	/** 読まれた会話の数。 */
	readonly conversations: number;
	/** 読まれた会話での 1 会話あたり平均トークン。 */
	readonly average: number;
	readonly detail?: string;
	readonly count?: number;
}

/**
 * 期間の内訳（「AI コスト」の画面のカード）。会話ごとの一番大きかった時点（`/compact` の前の山）の内訳を集める。
 * 会話の数が 0 なら `undefined` の項目は無く、一覧も空。
 */
export interface IParadisClaudeContextPeriod {
	/** 集めた会話の数。 */
	readonly conversations: number;
	readonly averageTokens: number;
	readonly averagePercent: number;
	readonly maxPercent: number;
	/** 会話すべての窓が同じならその大きさ。 */
	readonly window?: number;
	/** 会話以外（システムプロンプト・ツール・メモリファイル・MCP・スキルなど）の 1 会話あたり平均。 */
	readonly fixedAverage: number;
	readonly categories: readonly IParadisClaudeContextPeriodCategory[];
	readonly memoryFiles: readonly IParadisClaudeContextPeriodItem[];
	readonly mcpServers: readonly IParadisClaudeContextPeriodItem[];
	readonly agents: readonly IParadisClaudeContextPeriodItem[];
	readonly skills: readonly IParadisClaudeContextPeriodItem[];
	/** 保存してある内訳のうち一番古いものの時刻（「保存は M/D から」）。 */
	readonly since?: number;
}

/** 会話の中身にあたるカテゴリ（「毎回かかる分」から外す）。 */
const CONVERSATION_CATEGORY = 'Messages';

function aggregateItems(lists: readonly (readonly IParadisClaudeContextRow[])[]): IParadisClaudeContextPeriodItem[] {
	const items = new Map<string, { name: string; conversations: number; tokens: number; detail?: string; count?: number }>();
	for (const list of lists) {
		const seen = new Set<string>();
		for (const row of list) {
			if (seen.has(row.name)) {
				continue;
			}
			seen.add(row.name);
			const item = items.get(row.name) ?? { name: row.name, conversations: 0, tokens: 0, ...(row.detail !== undefined ? { detail: row.detail } : {}) };
			item.conversations++;
			item.tokens += row.tokens;
			if (row.count !== undefined) {
				item.count = Math.max(item.count ?? 0, row.count);
			}
			items.set(row.name, item);
		}
	}
	return [...items.values()]
		.map(item => ({
			name: item.name, conversations: item.conversations, average: Math.round(item.tokens / item.conversations),
			...(item.detail !== undefined ? { detail: item.detail } : {}),
			...(item.count !== undefined ? { count: item.count } : {}),
		}))
		.sort((a, b) => b.conversations - a.conversations || b.average - a.average)
		.slice(0, PARADIS_CLAUDE_CONTEXT_MAX_ROWS);
}

/** 会話ごとの一番大きかった時点の内訳を、期間の内訳にまとめる。 */
export function paradisAggregateClaudeContextPeriod(peaks: readonly IParadisClaudeContextBreakdown[], since?: number): IParadisClaudeContextPeriod {
	const conversations = peaks.length;
	const windows = new Set(peaks.map(peak => peak.window));
	const categories = new Map<string, { name: string; kind: ParadisClaudeContextCategoryKind; tokens: number; max: number; share: number }>();
	let fixedTokens = 0;
	for (const peak of peaks) {
		for (const category of peak.categories) {
			const entry = categories.get(category.name) ?? { name: category.name, kind: category.kind, tokens: 0, max: 0, share: 0 };
			entry.tokens += category.tokens;
			entry.max = Math.max(entry.max, category.tokens);
			entry.share += category.tokens / peak.window * 100;
			categories.set(category.name, entry);
			if (category.kind === 'used' && category.name !== CONVERSATION_CATEGORY) {
				fixedTokens += category.tokens;
			}
		}
	}
	const average = (value: number) => conversations > 0 ? value / conversations : 0;
	const kindOrder: Record<ParadisClaudeContextCategoryKind, number> = { used: 0, buffer: 1, free: 2, deferred: 3 };
	return {
		conversations,
		averageTokens: Math.round(average(peaks.reduce((sum, peak) => sum + peak.totalTokens, 0))),
		averagePercent: Math.round(average(peaks.reduce((sum, peak) => sum + peak.percent, 0))),
		maxPercent: peaks.reduce((max, peak) => Math.max(max, peak.percent), 0),
		...(windows.size === 1 ? { window: [...windows][0] } : {}),
		fixedAverage: Math.round(average(fixedTokens)),
		categories: [...categories.values()]
			.map(entry => ({ name: entry.name, kind: entry.kind, average: Math.round(average(entry.tokens)), max: entry.max, share: average(entry.share) }))
			.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.average - a.average),
		memoryFiles: aggregateItems(peaks.map(peak => peak.memoryFiles)),
		mcpServers: aggregateItems(peaks.map(peak => peak.mcpServers)),
		agents: aggregateItems(peaks.map(peak => peak.agents)),
		skills: aggregateItems(peaks.map(peak => peak.skills)),
		...(since !== undefined ? { since } : {}),
	};
}
