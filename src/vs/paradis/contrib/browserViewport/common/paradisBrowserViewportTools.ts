/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser（LLM）の set_viewport / list_viewports / open_browser_tab の viewport / list_browser_tabs の
// viewport の、LLM 向けの英文と JSON の形（shared process の paradisAgentBrowserService.ts が使う）。

import { IParadisListViewportsResult, IParadisSetViewportResult, IParadisViewportState } from './paradisBrowserViewport.js';

/** list_browser_tabs の各タブに載せる形。 */
export function paradisViewportForAgent(state: IParadisViewportState): Record<string, unknown> {
	return {
		...(state.name !== undefined ? { name: state.name } : {}),
		...(state.width !== undefined ? { width: state.width } : {}),
		...(state.height !== undefined ? { height: state.height } : {}),
		mobile: state.mobile,
		...(state.fit ? { fit: true } : {}),
	};
}

function describeState(state: IParadisViewportState): string {
	const size = state.width !== undefined && state.height !== undefined ? `${state.width}x${state.height}` : 'the editor size';
	if (state.fit) {
		return `auto (follows the editor, now ${size})`;
	}
	const named = state.name !== undefined ? `"${state.name}" (${size}${state.mobile ? ', mobile' : ''})` : `${size}${state.mobile ? ' (mobile)' : ''}`;
	return named;
}

/** set_viewport の結果の英文。失敗なら `error`。 */
export function paradisFormatSetViewportResult(tabId: string, spec: string, result: IParadisSetViewportResult): { readonly text?: string; readonly error?: string } {
	if (result.ok) {
		return { text: `Tab ${tabId} is now ${describeState(result.viewport)} (was ${describeState(result.previous)}). The size chip in the address bar shows it to the user.` };
	}
	switch (result.reason) {
		case 'unknownViewport':
			return { error: `"${spec}" is neither a saved size nor "WIDTHxHEIGHT" (each 100-9999). Call list_viewports for the saved names, or pass for example "1366x768" or "auto".` };
		case 'unknownTab':
			return { error: `PARA_BROWSER_RETRYABLE: Tab ${tabId} is no longer open in Para Code. Call list_browser_tabs.` };
		case 'tabNotReady':
			return { error: `PARA_BROWSER_RETRYABLE: The page of tab ${tabId} is not ready yet. Retry in a moment.` };
	}
}

/** list_viewports の結果の英文。 */
export function paradisFormatViewportList(result: IParadisListViewportsResult): string {
	const defaultSpec = result.globalDefault.trim();
	const lines = result.sizes.map(size => `${size.name}: ${size.width}x${size.height}${size.mobile ? ' (mobile: touch input and a phone user agent)' : ''}`);
	return JSON.stringify({
		sizes: result.sizes,
		defaultForNewTabs: defaultSpec || 'auto (follows the editor size)',
		hint: `Pass a name (or "WIDTHxHEIGHT", or "auto") to set_viewport, or as the viewport argument of open_browser_tab. Saved sizes: ${lines.join('; ') || 'none'}. The user may also set a different default for each space; list_browser_tabs shows the size each tab really has.`,
	}, null, 2);
}
