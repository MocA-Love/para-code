/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ccusage CLI 連携の共有型定義。shared process 側(node/paradisCcusageChannel.ts)が
// `ccusage <report> --json` の出力をこの型で返し、renderer 側(electron-browser/)が集計・描画する。
// 型は ccusage v20 系の JSON 出力(実機検証済み)のサブセット。フィールド欠落に耐えるよう
// 数値系は undefined 許容で扱うこと。

export const PARADIS_CCUSAGE_CHANNEL = 'paradisCcusage';

/** renderer から shared process へ渡す実行オプション。args はサービス側でホワイトリスト構築する。 */
export interface IParadisCcusageExecOptions {
	/** 設定 paradis.ccusage.executablePath の明示パス(空なら自動解決)。 */
	readonly executablePath?: string;
	/** YYYYMMDD 形式。 */
	readonly since?: string;
	/** YYYYMMDD 形式。 */
	readonly until?: string;
	/** IANA タイムゾーン(例: Asia/Tokyo)。 */
	readonly timezone?: string;
}

/** モデル単位の内訳(daily/session 共通)。 */
export interface IParadisCcusageModelBreakdown {
	readonly modelName: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheCreationTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cost?: number;
}

/** 統合 `ccusage daily --json` の1日分。 */
export interface IParadisCcusageDailyRow {
	/** YYYY-MM-DD。 */
	readonly period: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheCreationTokens?: number;
	readonly cacheReadTokens?: number;
	readonly totalCost?: number;
	readonly totalTokens?: number;
	readonly modelBreakdowns?: IParadisCcusageModelBreakdown[];
	readonly modelsUsed?: string[];
	readonly metadata?: { readonly agents?: string[] };
}

/** `ccusage blocks --json --active` の1ブロック分。 */
export interface IParadisCcusageBlock {
	readonly id: string;
	readonly isActive?: boolean;
	readonly isGap?: boolean;
	/** ISO 8601。 */
	readonly startTime: string;
	readonly endTime: string;
	readonly actualEndTime?: string;
	readonly costUSD?: number;
	readonly totalTokens?: number;
	readonly models?: string[];
	readonly tokenCounts?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly cacheCreationInputTokens?: number;
		readonly cacheReadInputTokens?: number;
	};
	readonly burnRate?: {
		readonly costPerHour?: number;
		readonly tokensPerMinute?: number;
	} | null;
	readonly projection?: {
		readonly remainingMinutes?: number;
		readonly totalCost?: number;
		readonly totalTokens?: number;
	} | null;
}

/** `ccusage claude session --json` の1セッション分(Claude Code のみ)。 */
export interface IParadisCcusageSessionRow {
	readonly sessionId?: string;
	/** 例: "-Users-magu-github-para-code"(パス区切りが '-' に変換されたもの)。 */
	readonly projectPath?: string;
	readonly firstActivity?: string;
	readonly lastActivity?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheCreationTokens?: number;
	readonly cacheReadTokens?: number;
	readonly totalCost?: number;
	readonly totalTokens?: number;
	readonly modelBreakdowns?: IParadisCcusageModelBreakdown[];
	readonly modelsUsed?: string[];
}

/** `ccusage claude daily --instances --json` の projects 値(プロジェクト名 → 日別行)。 */
export interface IParadisCcusageProjectDailyRow {
	readonly date?: string;
	readonly totalCost?: number;
	readonly totalTokens?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
}

export type ParadisCcusageProjects = { readonly [projectName: string]: IParadisCcusageProjectDailyRow[] };

/** shared process チャネルのメソッドと戻り値。 */
export interface IParadisCcusageService {
	/** 統合 daily(全エージェント合算・モデル別内訳付き)。 */
	fetchDaily(options: IParadisCcusageExecOptions): Promise<IParadisCcusageDailyRow[]>;
	/** アクティブな5時間ブロック(存在しなければ undefined)。 */
	fetchActiveBlock(options: IParadisCcusageExecOptions): Promise<IParadisCcusageBlock | undefined>;
	/** Claude Code の直近セッション(新しい順)。 */
	fetchRecentSessions(options: IParadisCcusageExecOptions): Promise<IParadisCcusageSessionRow[]>;
	/** Claude Code のプロジェクト別日別使用量。 */
	fetchProjects(options: IParadisCcusageExecOptions): Promise<ParadisCcusageProjects>;
}

/** ダッシュボードのエージェント軸。ccusage のソース名(claude/codex/gemini)に対応。 */
export type ParadisCcusageAgent = 'claude' | 'codex' | 'gemini' | 'other';

/** モデル名からエージェントを推定する(統合 daily はモデル単位でしかソースが分からないため)。 */
export function paradisCcusageAgentForModel(modelName: string): ParadisCcusageAgent {
	const name = modelName.toLowerCase();
	if (name.startsWith('claude')) {
		return 'claude';
	}
	if (name.startsWith('gpt') || name.includes('codex') || name.startsWith('o1') || name.startsWith('o3') || name.startsWith('o4')) {
		return 'codex';
	}
	if (name.startsWith('gemini')) {
		return 'gemini';
	}
	return 'other';
}
