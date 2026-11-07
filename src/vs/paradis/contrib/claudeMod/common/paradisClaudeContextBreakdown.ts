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
