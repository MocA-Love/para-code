/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの会話から読み取った「ペインごとの様子」を、デスクトップの UI へ渡すための契約。
//
// 読み取りそのものはモバイル中継（mobileRelay の ParadisMobileAgentChat）が transcript と hook から
// 既にやっている。ここで定義するのは、その読み取り結果を**モバイルへ送る形式とは別に**
// デスクトップへ渡す口だけ。モバイルへ送るメッセージの形は一切変えない。
//
// 中継はモバイル連携を無効にしていても shared process で常に動いている（status 用の tail は
// モバイル接続から独立している）ため、ここを経由すればモバイル連携の有無に関わらず同じ値が引ける。

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** サブエージェントの状態（モバイル中継の ParadisAgentActivityStatus と同じ語彙）。 */
export type ParadisAgentPaneSubagentStatus = 'running' | 'idle' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export interface IParadisAgentPaneSubagent {
	readonly id: string;
	readonly label: string;
	/** subagent = Claude の Agent/Task や Codex の子スレッド、teammate = Claude の Agent Teams */
	readonly role: 'subagent' | 'teammate';
	readonly status: ParadisAgentPaneSubagentStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
	/** 入れ子の深さ（1 = 親エージェント直下）。 */
	readonly depth?: number;
}

/** 手が止まってユーザーの操作を待っている内容。 */
export interface IParadisAgentPaneInteraction {
	readonly kind: 'question' | 'permission';
	/** 1行に畳んだ要約（質問文、または許可を求めているコマンドなど）。 */
	readonly text: string;
	readonly at: number;
}

/**
 * プロンプトキャッシュの状態。Claude の transcript に記録された usage からだけ作る
 * （Codex は有効期限を決める根拠が記録に無いため作らない。paradisReadClaudePromptCacheUsage 参照）。
 */
export interface IParadisAgentPromptCache {
	/** キャッシュを最後に使った（読んだ・書いた）リクエストの時刻。 */
	readonly lastUsedAt: number;
	/** 有効期限の長さ。5分か1時間。 */
	readonly ttlMs: number;
}

/** ペイン1つ分の様子。 */
export interface IParadisAgentPaneInsight {
	readonly token: string;
	readonly agent: 'claude' | 'codex';
	/** 動いているもの → 最近終わったもの の順。 */
	readonly subagents: readonly IParadisAgentPaneSubagent[];
	/** 最後のアシスタント発言（1行に畳んだもの）。 */
	readonly lastMessage?: { readonly text: string; readonly at?: number };
	readonly interaction?: IParadisAgentPaneInteraction;
	readonly promptCache?: IParadisAgentPromptCache;
}

/**
 * shared process のモバイル中継サービスが追加で公開する読み取り口（IPC 契約）。
 * モバイル中継のチャネル（PARADIS_MOBILE_RELAY_CHANNEL）にそのまま載る。
 */
export interface IParadisAgentPaneInsightSource {
	/** どれかのペインの様子が変わった。受け取った側は必要なペインだけを取り直す。 */
	readonly onDidChangeAgentPaneInsights: Event<void>;
	/** 指定したペイントークンの様子。セッションが確定していないペインは含まれない。 */
	getAgentPaneInsights(tokens: readonly string[]): Promise<readonly IParadisAgentPaneInsight[]>;
}

/** 1つのスペースに属するペインの様子（スペース一覧のホバーやメタ段が使う）。 */
export interface IParadisAgentScopePane {
	readonly instanceId: number;
	readonly token: string;
	/** ターミナルのタイトル。 */
	readonly title: string;
	readonly insight: IParadisAgentPaneInsight;
}

export const IParadisAgentInsightsService = createDecorator<IParadisAgentInsightsService>('paradisAgentInsightsService');

/**
 * デスクトップの UI がペインごとの様子を引くためのストア。書き込みは electron-browser の
 * 取得係（shared process から読む）だけが行う。Web ビルドでは常に空。
 */
export interface IParadisAgentInsightsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	getForToken(token: string): IParadisAgentPaneInsight | undefined;
	getForInstance(instanceId: number): IParadisAgentPaneInsight | undefined;
	/** そのスペースに確実に属しているペインだけを返す（所属が推測になるものは含めない）。 */
	getScopePanes(stateKey: string): readonly IParadisAgentScopePane[];
	/** 取得係が、このウィンドウのペインの最新の様子を丸ごと置き換える。 */
	setInsights(insights: readonly IParadisAgentPaneInsight[]): void;
}

// ---- プロンプトキャッシュ ----------------------------------------------------------------------

export const PARADIS_PROMPT_CACHE_TTL_5M = 5 * 60 * 1000;
export const PARADIS_PROMPT_CACHE_TTL_1H = 60 * 60 * 1000;
/** 残りがこれ以下になったら警告色にする。 */
export const PARADIS_PROMPT_CACHE_WARNING_MS = 60 * 1000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positive(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Claude の transcript 1行から「このリクエストでキャッシュをどう使ったか」を読む。
 *
 * - `message.usage.cache_creation.ephemeral_5m_input_tokens` が 1 以上 → 5分のキャッシュを書いた
 * - `message.usage.cache_creation.ephemeral_1h_input_tokens` だけが 1 以上 → 1時間のキャッシュを書いた
 *   （両方あるときは 5分。先に切れる方で次の依頼が割高になるため）
 * - 読み込み（`cache_read_input_tokens`）だけ → 書いたときの長さのまま延長される。ここでは
 *   長さが分からないので `ttl: undefined` を返し、呼び出し側が直前の長さを引き継ぐ
 * - どちらも 0 → キャッシュを使っていないリクエスト。残り時間は延びないので undefined
 *
 * 時刻は行の `timestamp`（応答を書き終えた時刻）。実際の有効期限の起点はリクエスト時刻なので、
 * 応答にかかった時間ぶんだけ長めに見積もる。サブエージェントの行（isSidechain）は親の
 * キャッシュとは別物なので読まない。
 */
export function paradisReadClaudePromptCacheUsage(line: Readonly<Record<string, unknown>>): { readonly at: number; readonly ttlMs: number | undefined } | undefined {
	if (line.type !== 'assistant' || line.isSidechain === true) {
		return undefined;
	}
	const usage = record(record(line.message)?.usage);
	if (!usage) {
		return undefined;
	}
	const timestamp = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
	if (!Number.isFinite(timestamp)) {
		return undefined;
	}
	const creation = record(usage.cache_creation);
	const wrote5m = positive(creation?.ephemeral_5m_input_tokens);
	const wrote1h = positive(creation?.ephemeral_1h_input_tokens);
	if (wrote5m) {
		return { at: timestamp, ttlMs: PARADIS_PROMPT_CACHE_TTL_5M };
	}
	if (wrote1h) {
		return { at: timestamp, ttlMs: PARADIS_PROMPT_CACHE_TTL_1H };
	}
	// 内訳の無い古い形式。書き込み量だけがあるなら既定の5分として扱う。
	if (positive(usage.cache_creation_input_tokens)) {
		return { at: timestamp, ttlMs: PARADIS_PROMPT_CACHE_TTL_5M };
	}
	if (positive(usage.cache_read_input_tokens)) {
		return { at: timestamp, ttlMs: undefined };
	}
	return undefined;
}

/** 残り時間（ms）。切れていれば 0。 */
export function paradisPromptCacheRemainingMs(cache: IParadisAgentPromptCache, now: number): number {
	return Math.max(0, cache.lastUsedAt + cache.ttlMs - now);
}

/** 残り時間の表示（`4:12`、1時間以上は `1:02:03`）。秒は切り上げる（0:00 のまま残る瞬間を作らない）。 */
export function paradisFormatPromptCacheRemaining(remainingMs: number): string {
	const total = Math.max(0, Math.ceil(remainingMs / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, '0');
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * そのペインで残り時間を出すか。出すのは Claude のペインで、応答中ではなく、まだ切れていないときだけ。
 * 応答中はキャッシュを使い続けているので、減っていく数字を見せると誤解を招く。
 */
export function paradisVisiblePromptCacheRemainingMs(insight: IParadisAgentPaneInsight | undefined, working: boolean, now: number): number | undefined {
	if (!insight || insight.agent !== 'claude' || !insight.promptCache || working) {
		return undefined;
	}
	const remaining = paradisPromptCacheRemainingMs(insight.promptCache, now);
	return remaining > 0 ? remaining : undefined;
}

// ---- 待っている内容の要約 --------------------------------------------------------------------

/** 改行と連続空白を1つに畳み、長すぎれば末尾を省略する。 */
export function paradisOneLine(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	// allow-any-unicode-next-line
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

const INTERACTION_TEXT_LIMIT = 200;

/**
 * AskUserQuestion の tool_input から、最初の質問文を1行にする。
 * 複数問あるときは先頭だけを出す（残りは端末かモバイルで見る）。
 */
export function paradisSummarizeQuestionInput(toolInput: unknown): string | undefined {
	const questions = record(toolInput)?.questions;
	if (!Array.isArray(questions)) {
		return undefined;
	}
	for (const item of questions) {
		const question = record(item)?.question;
		if (typeof question === 'string' && question.trim().length > 0) {
			return paradisOneLine(question, INTERACTION_TEXT_LIMIT);
		}
	}
	return undefined;
}

/**
 * 許可を求めているツール呼び出しを1行にする。コマンドやファイルパスがあればそれを優先し、
 * 無ければツール名だけにする（入力の JSON をそのまま出しても読めないため）。
 */
export function paradisSummarizePermissionInput(toolName: string | undefined, toolInput: unknown): string | undefined {
	const input = record(toolInput);
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = input?.[key];
			if (typeof value === 'string' && value.trim().length > 0) {
				return value;
			}
		}
		return undefined;
	};
	const detail = pick('command', 'cmd', 'file_path', 'path', 'url', 'pattern', 'description');
	const text = detail !== undefined
		? (toolName && toolName !== 'Bash' ? `${toolName}: ${detail}` : detail)
		: toolName;
	return text ? paradisOneLine(text, INTERACTION_TEXT_LIMIT) : undefined;
}

// ---- サブエージェント ------------------------------------------------------------------------

/** 動いている（まだ終わっていない）サブエージェントか。 */
export function paradisIsActiveSubagent(subagent: IParadisAgentPaneSubagent): boolean {
	return subagent.status === 'running' || subagent.status === 'idle';
}

/**
 * デスクトップへ渡すサブエージェントの選び方。動いているものは全部（上限あり）、
 * 終わったものは新しい方から少しだけ。セッション内の完了履歴は最大100件まで溜まるため、
 * そのまま渡すとホバーが縦に伸び切る。
 */
export function paradisSelectInsightSubagents(subagents: readonly IParadisAgentPaneSubagent[], limits = { active: 20, finished: 5 }): IParadisAgentPaneSubagent[] {
	const active = subagents.filter(paradisIsActiveSubagent).slice(0, limits.active);
	const finished = subagents.filter(subagent => !paradisIsActiveSubagent(subagent))
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, limits.finished);
	return [...active, ...finished];
}
