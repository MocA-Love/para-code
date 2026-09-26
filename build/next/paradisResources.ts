/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Non-TypeScript files the fork ships with the desktop build. Merged into the desktop
 * resource list by `resources.ts`.
 */
export const paradisDesktopResourcePatterns: readonly string[] = [
	// Built-in notification ringtones played by the notification settings dialog / trigger
	'vs/paradis/contrib/notifications/browser/media/sounds/*.mp3',
	// Fork changelog shown by the paradis.showChangelog command
	'vs/paradis/contrib/releaseNotes/electron-browser/media/*.md',
	// Vendored React DevTools extension loaded into built-in browser sessions
	// (`**/*.*` instead of `**`: this glob impl matches directories too and copyFile would fail on them)
	'vs/paradis/contrib/browserExtensions/electron-main/media/**/*.*',
	// Spreadsheet viewer CSS read at runtime for the mobile xlsx HTML (inlined into the WebView document)
	'vs/paradis/contrib/fileViewers/electron-browser/media/*.css',
	// Vendored pdf.js runtime loaded by the PDF viewer webview
	// (`**/*.*` matches all payload files; extension-less LICENSE files are listed separately)
	'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs/**/*.*',
	'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs/**/LICENSE*',
	// Vendored docx-preview + jszip runtime loaded by the Word (.docx) viewer webview
	'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/**/*.*',
	'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/**/LICENSE*',
	// Vendored mermaid.js runtime inlined into the Markdown viewer webview
	'vs/paradis/contrib/fileViewers/browser/media/mermaid/**/*.*',
	'vs/paradis/contrib/fileViewers/browser/media/mermaid/**/LICENSE*',
	// Vendored chrome-devtools-mcp spawned per-pane by the para-browser MCP server
	'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/**/*.*',
	'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/**/LICENSE*',
	'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/**/THIRD_PARTY_NOTICES',
];

/**
 * Vendored third-party trees whose JavaScript must be copied byte-for-byte instead of being
 * minified like upstream's own resource scripts:
 * - they are already distributed in their final form (docx-preview is even hash-pinned by
 *   the `docx-preview-037` build),
 * - many of them carry `sourceMappingURL` comments for maps that are not vendored, which the
 *   resource minifier treats as a hard error,
 * - chrome-devtools-mcp is a Node ESM package tree and React DevTools is a Chrome extension;
 *   neither is a classic script, which is what the resource minifier assumes.
 */
const paradisVerbatimResourcePrefixes: readonly string[] = [
	'vs/paradis/contrib/browserExtensions/electron-main/media/',
	'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs/',
	'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview/',
	'vs/paradis/contrib/fileViewers/browser/media/mermaid/',
	'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/',
];

/**
 * Whether a resource (path relative to `src/`, forward slashes) is a vendored file that has to
 * be copied without minification.
 */
export function isParadisVerbatimResource(file: string): boolean {
	const normalized = file.replace(/\\/g, '/');
	return paradisVerbatimResourcePrefixes.some(prefix => normalized.startsWith(prefix));
}
