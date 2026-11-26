/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// window.prompt() of the built-in browser.
//
// Electron does not implement prompt(): the call throws ("prompt() is and will not be supported"), so a page
// that asks with prompt() stopped with an exception. Para Code shows a prompt as a confirm() dialog that stands
// in for it (the browser has no dialog with a text field):
//  - the page's prompt() tells the main process the message and the default value, then opens a real confirm()
//    whose text ends with a marker line (see {@link paradisPromptStandInMessage}),
//  - a CDP client (the agent's `handle_dialog` with `promptText`) accepts that confirm with a text. Chromium
//    reports the text in `Page.javascriptDialogClosed.userInput`, also for a confirm; the main process reads it
//    there and hands it to the page as the result of prompt(),
//  - a user who presses OK gets the default value, Cancel gives null.
// The agent's CDP client talks to Chromium directly (the remote debugging port), so a dialog that Chromium itself
// opens is the only kind it can see and answer without changes to the CDP gateway.

/** Channel of the synchronous IPC the preload sends before it opens the stand-in confirm. Returns the text to show. */
export const PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL = 'vscode:browserView:paradisPromptBegin';
/** Channel of the synchronous IPC the preload sends after the stand-in confirm closed. Returns the result of prompt(). */
export const PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL = 'vscode:browserView:paradisPromptEnd';

const MARKER = '\n\n[prompt() default: ';

/**
 * The text of the confirm that stands in for a prompt: the page's message, then a line that marks it as a
 * prompt and carries the default value, then a hint for a person who reads it.
 */
export function paradisPromptStandInMessage(message: string, defaultPrompt: string, hint: string): string {
	return `${message}${MARKER}${JSON.stringify(defaultPrompt)}] ${hint}`;
}

/**
 * Read the page's message and default value back from the text of a stand-in confirm. Undefined for an
 * ordinary confirm. The bundled chrome-devtools-mcp carries the same expression (McpResponse.js).
 */
export function paradisParsePromptStandIn(text: string): { readonly message: string; readonly defaultPrompt: string } | undefined {
	const match = /^(?<message>[\s\S]*)\n\n\[prompt\(\) default: (?<value>"(?:[^"\\]|\\.)*")\] [^\n]*$/.exec(text);
	if (!match?.groups) {
		return undefined;
	}
	try {
		const defaultPrompt: unknown = JSON.parse(match.groups.value);
		return typeof defaultPrompt === 'string' ? { message: match.groups.message, defaultPrompt } : undefined;
	} catch {
		return undefined;
	}
}
