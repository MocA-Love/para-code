/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Codex does not set an OSC title on its own. Para Code asks for one through Codex's `[tui].terminal_title`
 * (`app-name` first, see `PARADIS_CODEX_TERMINAL_TITLE_ITEMS`), and Codex joins the items with ` | `, so the
 * title arrives as `codex | <thread title>`, or as a bare `codex` before the thread has a title.
 *
 * Only that shape counts. Titles that merely mention the word, such as a shell showing `user@host: ~/work/codex`
 * or an editor showing `codex.md`, are not Codex.
 */
const CODEX_TITLE = /^\s*codex\s*(?:\|.*)?$/i;

/** Whether an OSC title is the one Codex sets for Para Code (`codex` or `codex | <title>`). */
export function paradisIsCodexTerminalTitle(title: string): boolean {
	return CODEX_TITLE.test(title);
}

/** For the terminal's title patterns: matches the titles {@link paradisIsCodexTerminalTitle} accepts. */
export const paradisCodexTitlePattern: { test(title: string): boolean } = {
	test: title => paradisIsCodexTerminalTitle(title),
};
