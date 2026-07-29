/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING = 'paradis.codex.terminalTitle.enabled';

/**
 * Codex の `[tui].terminal_title` に書き込む項目。Codex は項目を ` | ` で連結するので、
 * 実際に届く OSC タイトルは `codex | <スレッドのタイトル>`（タイトル未確定の間はスレッド ID）になる。
 *
 * **`app-name` を外してはいけない**。Para Code が「このターミナルで動いているのは Codex だ」と判別する
 * 唯一の手掛かりが、この OSC タイトルに `codex` が含まれることだから（terminalInstance.ts の
 * `agentCliTitlePatterns` にある fork の PARA-PATCH）。外すと shell type が Codex にならず、
 * タブ名をエージェントのタイトルにする仕組みごと止まる。
 *
 * なお `thread-title` は実測（codex-cli 0.146.0）ではスレッド ID しか出さず、人間が読めるタイトルには
 * ならない。タブに出る読めるタイトルは、この fork が依頼文から作って transient title として乗せている
 * ぶんだけ（createCodexTerminalTitle）。したがってこの OSC タイトルは主に判別のためにある。
 */
export const PARADIS_CODEX_TERMINAL_TITLE_ITEMS = ['app-name', 'thread-title'] as const;

export const PARADIS_CODEX_TERMINAL_TITLE_CHANNEL = 'paradisCodexTerminalTitle';

export interface IParadisCodexThreadPromptRequest {
	readonly threadId: string;
	readonly cwd: string;
	readonly invocation: 'start' | 'resume';
	/**
	 * Skips the bounded rollout scan because an earlier lookup already read the scan's byte
	 * budget without finding a prompt. Repeating that scan on every poll would be the only
	 * expensive part of an otherwise sub-millisecond lookup.
	 */
	readonly skipRolloutScan?: boolean;
}

export interface IParadisCodexThreadPromptResult {
	readonly prompt?: string;
	/** Set when the rollout scan stopped at its byte budget instead of reaching end of file. */
	readonly rolloutScanExhausted?: boolean;
}
