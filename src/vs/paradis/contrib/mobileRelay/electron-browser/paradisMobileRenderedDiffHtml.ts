/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホの差分の画面の「差分」（Markdown のプレビュー差分）の HTML。PC の差分エディタの 1 列の形
// （paradisRenderedDiffDom の木とスタイル）をそのまま使い、VS Code の webview が配るテーマの CSS 変数の代わりに
// アプリの配色（app/mobile/src/theme.ts の colors）を :root に置く。
//
// アプリの WebView はスクリプトを止めて開くので、ページの中の補助スクリプト（↑↓・拡大・Mermaid・検索）は入れない。
// 画像は PC が data: に埋め込んだものだけを出す（CSP で外への読み込みを止める。アプリの Markdown の表示と同じ線引き）。

import { DEFAULT_MARKDOWN_STYLES } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { PARADIS_MARKDOWN_ALERT_STYLES } from '../../fileViewers/browser/paradisMarkdownAlerts.js';
import { PARADIS_FRONTMATTER_STYLES } from '../../fileViewers/browser/paradisMarkdownFrontMatter.js';
import { PARADIS_INLINE_MEDIA_STYLES } from '../../fileViewers/browser/paradisMarkdownInlineResources.js';
import { PARADIS_RENDERED_DIFF_STYLES } from '../../fileViewers/browser/paradisRenderedDiffDom.js';

/** スマホへ送るプレビュー差分の HTML の上限（バイト。Word の差分と同じ）。超えたら送らず、アプリに Raw を勧める。 */
export const PARADIS_MOBILE_RENDERED_DIFF_HTML_MAX_BYTES = 6_000_000;

/** 埋め込む画像の上限。HTML の上限に収まるよう、PC の差分エディタより小さくする。 */
export const PARADIS_MOBILE_RENDERED_DIFF_MEDIA_LIMITS = Object.freeze({
	maxBytesPerFile: 2 * 1024 * 1024,
	maxBytesTotal: 3 * 1024 * 1024,
});

/**
 * アプリの配色（app/mobile/src/theme.ts の colors）。差分の色は Raw の行の色（add・del）、変更は accent の既定、
 * 地はアプリの Markdown の表示と同じ codeBg。
 */
const PARADIS_MOBILE_RENDERED_DIFF_THEME = `
:root {
	color-scheme: dark;
	--text-link-decoration: none;
	--vscode-editor-background: #1e1e1e;
	--vscode-editor-foreground: #e0e0e0;
	--vscode-editor-font-family: Menlo, ui-monospace, monospace;
	--vscode-editor-font-size: 13px;
	--vscode-editor-font-weight: normal;
	--vscode-textCodeBlock-background: #242424;
	--vscode-widget-border: #2a2a2a;
	--vscode-editorGroup-border: #2a2a2a;
	--vscode-descriptionForeground: #a1a1a1;
	--vscode-focusBorder: #3b82f6;
	--vscode-diffEditor-insertedLineBackground: rgba(129, 184, 139, 0.12);
	--vscode-diffEditor-removedLineBackground: rgba(199, 78, 57, 0.13);
	--vscode-diffEditor-insertedTextBackground: rgba(129, 184, 139, 0.32);
	--vscode-diffEditor-removedTextBackground: rgba(199, 78, 57, 0.36);
	--vscode-diffEditor-diagonalFill: rgba(161, 161, 161, 0.2);
	--vscode-editorGutter-addedBackground: #81b88b;
	--vscode-editorGutter-deletedBackground: #c74e39;
	--vscode-editorGutter-modifiedBackground: #3b82f6;
	--vscode-charts-blue: #3b82f6;
	--vscode-charts-green: #22c55e;
	--vscode-charts-purple: #a78bfa;
	--vscode-charts-red: #ef4444;
	--vscode-charts-yellow: #eab308;
}
html { -webkit-text-size-adjust: 100%; }
body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 15px; line-height: 24px; overflow-wrap: anywhere; }
a { color: #3b82f6; }
h1, hr, th, table > tbody > tr + tr > td { border-color: var(--vscode-widget-border); }
code { font-family: var(--vscode-editor-font-family); font-size: 13px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 1px 4px; }
pre { background: #111111; border: 0.5px solid var(--vscode-widget-border); border-radius: 6px; padding: 10px 12px; font-size: 12px; line-height: 18px; overflow-x: auto; overflow-wrap: normal; }
pre code { background: none; padding: 0; font-size: 12px; }
table { display: block; max-width: 100%; overflow-x: auto; }
th, td { overflow-wrap: break-word; }
blockquote { color: var(--vscode-descriptionForeground); border-left-color: #3a3a3a; }
.paradis-rdiff-unified { padding: 4px 12px 0 30px; }
.paradis-mobile-rdiff-note { margin: 8px 12px 0; padding: 6px 10px; border: 0.5px solid var(--vscode-widget-border); border-radius: 6px; font-size: 12px; line-height: 18px; color: var(--vscode-descriptionForeground); }
`;

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * スマホへ送る 1 列のプレビュー差分の文書を作る。`body` は buildParadisRenderedDiff の木（消毒済みの描画に印を
 * 付けたもの）の HTML。`note` があれば先頭に断り書きとして出す（古い側の画像を今の作業ツリーから読んだなど）。
 */
export function renderParadisMobileRenderedDiffHtml(body: string, note: string | undefined, nonce: string): string {
	const csp = `default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'nonce-${nonce}'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none';`;
	return `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
		<style nonce="${escapeHtml(nonce)}">
			${DEFAULT_MARKDOWN_STYLES}
			${PARADIS_FRONTMATTER_STYLES}
			${PARADIS_INLINE_MEDIA_STYLES}
			${PARADIS_MARKDOWN_ALERT_STYLES}
			${PARADIS_RENDERED_DIFF_STYLES}
			${PARADIS_MOBILE_RENDERED_DIFF_THEME}
		</style>
	</head>
	<body class="paradis-markdown-body paradis-rdiff-body">
		${note ? `<p class="paradis-mobile-rdiff-note">${escapeHtml(note)}</p>` : ''}
		${body}
	</body>
</html>`;
}
