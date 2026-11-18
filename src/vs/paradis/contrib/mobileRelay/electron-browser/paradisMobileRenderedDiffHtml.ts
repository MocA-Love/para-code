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
//
// HTML（scm.rendered-diff-html.v1）は、PC の差分エディタの HTML のプレビュー差分の 1 列の形（変更後の文書に印を
// 付け、消えた要素を差し込んだもの）を、iframe に入れずにそのまま 1 枚の文書にして返す。PC の外枠の役（配信サーバ・
// テーマの CSS 変数・断り書きの行）は、ここで `<head>` の先頭に置く CSP と印の色、`<body>` の先頭の断り書きで代える。

import { DEFAULT_MARKDOWN_STYLES } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { PARADIS_MARKDOWN_ALERT_STYLES } from '../../fileViewers/browser/paradisMarkdownAlerts.js';
import { PARADIS_FRONTMATTER_STYLES } from '../../fileViewers/browser/paradisMarkdownFrontMatter.js';
import { PARADIS_INLINE_MEDIA_STYLES } from '../../fileViewers/browser/paradisMarkdownInlineResources.js';
import { paradisHtmlRenderedDiffPageStyle, serializeParadisHtmlDiffDocument } from '../../fileViewers/browser/paradisHtmlRenderedDiff.js';
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
.paradis-mobile-rdiff-ext-img { color: var(--vscode-descriptionForeground); }
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

/**
 * HTML のプレビュー差分のページの `<head>` の先頭に入れるもの。ページ自身の `<style>`・style 属性は通し、スクリプト・
 * 外への読み込み・フォームの送信・iframe は CSP で止める（`data:` の画像・字体だけ読む）。印の色は白い地のページに
 * 合わせてライトのテーマの差分の色を置く（PC は差分エディタのテーマの色を写すが、スマホには届かない）。白い地と
 * 文字の既定は層に入れ、ページが決めた色に必ず負けるようにする。
 */
function htmlRenderedDiffHead(): string {
	const csp = `default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';`;
	return `<meta charset="utf-8">`
		+ `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`
		+ `<meta name="viewport" content="width=device-width, initial-scale=1">`
		+ `<style>@layer paradis-mobile-default{html{color-scheme:light;background-color:#ffffff;}body{color:#000000;}img,video{max-width:100%;}}`
		+ `:root{--vscode-diffEditor-insertedTextBackground:rgba(156, 204, 44, 0.4);--vscode-diffEditor-removedTextBackground:rgba(255, 0, 0, 0.2);`
		+ `--vscode-editorGutter-addedBackground:#48985d;--vscode-editorGutter-deletedBackground:#e51400;--vscode-editorGutter-modifiedBackground:#2090d3;--vscode-focusBorder:#0090f1;}`
		+ `${PARADIS_INLINE_MEDIA_STYLES}`
		+ `.paradis-mobile-rdiff-ext-img{color:#57606a;}`
		+ `.paradis-mobile-rdiff-html-note{all:initial !important;display:block !important;margin:8px !important;padding:6px 10px !important;border:1px solid #d0d7de !important;border-radius:6px !important;background:#f6f8fa !important;color:#57606a !important;font:12px/18px -apple-system, BlinkMacSystemFont, sans-serif !important;}`
		+ `.paradis-mobile-rdiff-html-note > span{all:initial !important;display:block !important;color:inherit !important;font:inherit !important;}`
		+ `</style>`;
}

/**
 * HTML のプレビュー差分の 1 枚の文書を作る。`doc` は印を付け（1 列）、CSS・画像を埋め込み、スクリプトを外した変更後の
 * 文書。`notes` は `<body>` の先頭に断り書きとして出す（スクリプトを止めた・CSS の変更に色が無い・CSS と画像は今の
 * 作業ツリーのもの）。`doc` は書き換える。
 */
export function renderParadisMobileHtmlRenderedDiffHtml(doc: Document, notes: readonly string[]): string {
	if (notes.length > 0 && doc.body) {
		const box = doc.createElement('div');
		box.className = 'paradis-mobile-rdiff-html-note';
		for (const note of notes) {
			box.appendChild(doc.createElement('span')).textContent = note;
		}
		doc.body.insertBefore(box, doc.body.firstChild);
	}
	return serializeParadisHtmlDiffDocument(doc, htmlRenderedDiffHead(), paradisHtmlRenderedDiffPageStyle('unified'));
}
