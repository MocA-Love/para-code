// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * セッションのシートの「コンテキスト」の行から進む内訳（`agent.context-breakdown.v1`）。画面から切り出した純関数だけを置く。
 *
 * PC は agent の要求 `context-breakdown` に、同梱の Claude Mod が応答の終わりごとに取って保存した最後の 1 件を返す
 * （PC 側は `src/vs/paradis/contrib/claudeMod/common/paradisClaudeContextBreakdown.ts`）。取れないときは `reason`
 * （`agent` / `remote` / `none` / `unavailable`）と `error`。
 *
 * 決まり（q.html Q565: 案 A。成果物は次に回す・「見積もり」と書かない・コネクタは出さない）。
 */

import { formatTokens } from './agentSessionStatus.js';

export type ContextCategoryKind = 'used' | 'deferred' | 'buffer' | 'free';

export interface ContextCategory {
	name: string;
	tokens: number;
	kind: ContextCategoryKind;
}

export interface ContextRow {
	name: string;
	tokens: number;
	detail?: string;
	count?: number;
}

export interface ContextBreakdown {
	sessionId: string;
	/** 取った時刻（PC の時計）。 */
	at: number;
	model?: string;
	cwd?: string;
	totalTokens: number;
	window: number;
	percent: number;
	categories: ContextCategory[];
	memoryFiles: ContextRow[];
	mcpServers: ContextRow[];
	agents: ContextRow[];
	skills: ContextRow[];
}

export type ContextUnavailableReason = 'agent' | 'remote' | 'none' | 'unavailable';

export type ContextBreakdownReply =
	| { readonly kind: 'ok'; readonly breakdown: ContextBreakdown; readonly live: boolean }
	| { readonly kind: 'unavailable'; readonly reason: ContextUnavailableReason; readonly message: string };

/** 一覧ごとに出す行数（PC は 20 行まで送る）。 */
export const CONTEXT_SHOWN_ROWS = 5;
const MAX_ROWS = 20;
const MAX_CATEGORIES = 24;

function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined;
}

function rows(value: unknown): ContextRow[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const parsed: ContextRow[] = [];
	for (const candidate of value.slice(0, MAX_ROWS)) {
		const row = rec(candidate);
		const name = text(row?.name, 1_000);
		const tokens = count(row?.tokens);
		if (name === undefined || tokens === undefined) {
			continue;
		}
		const detail = text(row?.detail, 200);
		const rowCount = count(row?.count);
		parsed.push({ name, tokens, ...(detail !== undefined ? { detail } : {}), ...(rowCount !== undefined ? { count: rowCount } : {}) });
	}
	return parsed.sort((a, b) => b.tokens - a.tokens);
}

function reasonOf(value: unknown): ContextUnavailableReason {
	return value === 'agent' || value === 'remote' || value === 'none' ? value : 'unavailable';
}

/** 取れない理由の文（PC の `error` が無いときに使う）。 */
export function contextUnavailableText(reason: ContextUnavailableReason): string {
	switch (reason) {
		case 'agent': return 'Claude Code の会話でだけ取れます';
		case 'remote': return 'このペインでは取れません';
		case 'none': return 'まだありません（応答が終わると取れます）';
		case 'unavailable': return '内訳を取得できません';
	}
}

/** PC の返事（`t: 'context-breakdown'`）を読む。形が違えば取得できなかった扱い。 */
export function parseContextBreakdownReply(msg: Record<string, unknown>): ContextBreakdownReply {
	const raw = rec(msg['breakdown']);
	const sessionId = text(raw?.sessionId, 200);
	const at = typeof raw?.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined;
	const totalTokens = count(raw?.totalTokens);
	const window = count(raw?.window);
	const percent = typeof raw?.percent === 'number' && Number.isFinite(raw.percent) ? Math.max(0, Math.min(100, Math.round(raw.percent))) : undefined;
	if (raw === undefined || sessionId === undefined || at === undefined || totalTokens === undefined || window === undefined || window === 0 || percent === undefined) {
		const reason = raw === undefined ? reasonOf(msg['reason']) : 'unavailable';
		const error = raw === undefined ? text(msg['error'], 300) : undefined;
		return { kind: 'unavailable', reason, message: error ?? contextUnavailableText(reason) };
	}
	const categories: ContextCategory[] = [];
	for (const candidate of Array.isArray(raw.categories) ? raw.categories.slice(0, MAX_CATEGORIES) : []) {
		const category = rec(candidate);
		const name = text(category?.name, 200);
		const tokens = count(category?.tokens);
		const kind = category?.kind;
		if (name !== undefined && tokens !== undefined && (kind === 'used' || kind === 'deferred' || kind === 'buffer' || kind === 'free')) {
			categories.push({ name, tokens, kind });
		}
	}
	const model = text(raw.model, 200);
	const cwd = text(raw.cwd, 1_000);
	return {
		kind: 'ok',
		live: msg['live'] === true,
		breakdown: {
			sessionId, at, totalTokens, window, percent, categories,
			...(model !== undefined ? { model } : {}),
			...(cwd !== undefined ? { cwd } : {}),
			memoryFiles: rows(raw.memoryFiles),
			mcpServers: rows(raw.mcpServers),
			agents: rows(raw.agents),
			skills: rows(raw.skills),
		},
	};
}

/** Claude Code のカテゴリの名前の読み替え（知らない名前はそのまま）。 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
	'Messages': '会話',
	'Memory files': 'メモリファイル',
	'MCP tools': 'MCP ツール',
	'MCP server instructions': 'MCP サーバーの説明',
	'System prompt': 'システムプロンプト',
	'System tools': 'システムツール',
	'Skills': 'スキル',
	'Custom agents': 'カスタムエージェント',
	'Autocompact buffer': '自動圧縮の余白',
	'Compact buffer': '圧縮の余白',
	'Free space': '空き',
	'MCP tools (deferred)': 'MCP ツール（必要なときに読み込む）',
	'System tools (deferred)': 'システムツール（必要なときに読み込む）',
};

export function contextCategoryLabel(name: string): string {
	return CATEGORY_LABELS[name] ?? name;
}

/** 帯と一覧に並べる行。`share` は窓全体に対する割合（0〜100）。 */
export interface ContextCategoryLine {
	readonly key: string;
	readonly label: string;
	readonly tokens: number;
	readonly share: number;
	readonly kind: ContextCategoryKind;
}

/**
 * カテゴリの並び: 使っている分（多い順）、自動圧縮の余白、空き。必要になってから読み込む分（使用率に数えない）は
 * 最後に分けて返す。
 */
export function contextCategoryLines(breakdown: ContextBreakdown): { readonly counted: readonly ContextCategoryLine[]; readonly deferred: readonly ContextCategoryLine[] } {
	const line = (category: ContextCategory): ContextCategoryLine => ({
		key: category.name,
		label: contextCategoryLabel(category.name),
		tokens: category.tokens,
		share: category.tokens / breakdown.window * 100,
		kind: category.kind,
	});
	const nonzero = breakdown.categories.filter(category => category.tokens > 0);
	const used = nonzero.filter(category => category.kind === 'used').sort((a, b) => b.tokens - a.tokens);
	const buffer = nonzero.filter(category => category.kind === 'buffer');
	const free = nonzero.filter(category => category.kind === 'free');
	return {
		counted: [...used, ...buffer, ...free].map(line),
		deferred: nonzero.filter(category => category.kind === 'deferred').map(line),
	};
}

/** 見出しの数（「35%（353.9K / 1M）」）。 */
export function contextHeadline(breakdown: ContextBreakdown): string {
	return `${breakdown.percent}%（${formatTokens(breakdown.totalTokens)} / ${formatTokens(breakdown.window)}）`;
}

/** 割合の表記（「26.1%」）。 */
export function formatShare(share: number): string {
	return `${share.toFixed(1)}%`;
}

/** 一覧の行の名前（MCP サーバーはツールの数を添える）。 */
export function contextRowLabel(row: ContextRow, section: 'memory' | 'mcp' | 'agent' | 'skill'): string {
	return section === 'mcp' && row.count !== undefined ? `${row.name}（ツール ${row.count}）` : row.name;
}

/** 一覧の行のうち出すものと、畳んだ残りの数。 */
export function shownRows(list: readonly ContextRow[]): { readonly shown: readonly ContextRow[]; readonly rest: number } {
	return { shown: list.slice(0, CONTEXT_SHOWN_ROWS), rest: Math.max(0, list.length - CONTEXT_SHOWN_ROWS) };
}

/** 内訳の画面の取り直しの状態。どの端末について聞いたかを持ち、端末を替えた直後に前の端末の結果を出さない。 */
export type ContextFetchState =
	| { readonly kind: 'loading'; readonly terminalKey: string | undefined }
	| { readonly kind: 'done'; readonly terminalKey: string | undefined }
	| { readonly kind: 'failed'; readonly terminalKey: string | undefined; readonly message: string };

/** 最後に取れた内訳と、それを聞いた端末。 */
export interface ContextLoadedState {
	readonly terminalKey: string;
	readonly reply: Extract<ContextBreakdownReply, { readonly kind: 'ok' }>;
}

/** 内訳の画面に出すもの。前の内訳があれば取り直し中・取り直しの失敗の間も残す（UX 点検 U2 案 A）。 */
export type ContextBreakdownDisplay =
	| { readonly kind: 'spinner' }
	| { readonly kind: 'reason'; readonly message: string }
	| { readonly kind: 'shown'; readonly reply: Extract<ContextBreakdownReply, { readonly kind: 'ok' }>; readonly refreshing: boolean; readonly failedMessage: string | undefined };

/** 今の端末・取り直しの状態・最後に取れた内訳から、画面に出すものを決める。別の端末の状態と内訳は無いものとして扱う。 */
export function contextBreakdownDisplay(terminalKey: string | undefined, fetchState: ContextFetchState, loaded: ContextLoadedState | undefined): ContextBreakdownDisplay {
	const current: ContextFetchState = fetchState.terminalKey === terminalKey ? fetchState : { kind: 'loading', terminalKey };
	const reply = loaded !== undefined && loaded.terminalKey === terminalKey ? loaded.reply : undefined;
	if (reply === undefined) {
		return current.kind === 'failed' ? { kind: 'reason', message: current.message } : { kind: 'spinner' };
	}
	return { kind: 'shown', reply, refreshing: current.kind === 'loading', failedMessage: current.kind === 'failed' ? current.message : undefined };
}
