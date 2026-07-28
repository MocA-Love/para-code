/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING = 'paradis.codex.terminalTitle.enabled';

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
