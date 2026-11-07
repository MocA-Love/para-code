/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアの GitHub 式の注意書き（`> [!NOTE]`・`[!TIP]`・`[!IMPORTANT]`・`[!WARNING]`・`[!CAUTION]`）。
//
// 引用の最初の段落の先頭が、その行だけの印（`[!NOTE]` など）なら、引用の代わりに色とアイコン付きの枠で描く。
// `> [!NOTE] 同じ行の文` は GitHub と同じく普通の引用のまま（Orca の `github-callouts.ts` と同じ規則）。
//
// marked の walkTokens は使わない（ビューアは lex と parse を分けて呼ぶので walkTokens は走らず、走らせると
// 文書の大きさの二乗の時間がかかる。paradisMarkdownDocumentRenderer.ts の冒頭）。引用の renderer の中で、
// その引用の最初のトークンだけを見る。トークンは書き換えない（色付けの差し込みに失敗したとき、同じトークンで
// もう一度 parse するため）。

import * as marked from '../../../../base/common/marked/marked.js';
import { escape } from '../../../../base/common/strings.js';
import { localize } from '../../../../nls.js';

export type ParadisMarkdownAlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const ALERT_KINDS: readonly ParadisMarkdownAlertKind[] = ['note', 'tip', 'important', 'warning', 'caution'];

// 印はその行だけにあるときに限る（後ろに文があれば普通の引用）。
const ALERT_MARKER = /^\[!(?<kind>[a-z]+)\][ \t]*(?:\r?\n|$)/i;

function alertLabel(kind: ParadisMarkdownAlertKind): string {
	switch (kind) {
		case 'note': return localize('paradis.markdown.alert.note', "Note");
		case 'tip': return localize('paradis.markdown.alert.tip', "Tip");
		case 'important': return localize('paradis.markdown.alert.important', "Important");
		case 'warning': return localize('paradis.markdown.alert.warning', "Warning");
		case 'caution': return localize('paradis.markdown.alert.caution', "Caution");
	}
}

/**
 * 引用の中身が注意書きなら、種類と、印を除いた中身のトークンを返す。注意書きでなければ `undefined`。
 * 渡されたトークンは書き換えず、変える所だけ写しを作る。
 */
export function paradisMarkdownAlertOf(tokens: readonly marked.Token[]): { readonly kind: ParadisMarkdownAlertKind; readonly tokens: marked.Token[] } | undefined {
	const paragraph = tokens[0];
	if (paragraph?.type !== 'paragraph') {
		return undefined;
	}
	const inline = (paragraph as marked.Tokens.Paragraph).tokens;
	const first = inline[0];
	if (first?.type !== 'text') {
		return undefined;
	}
	const text = (first as marked.Tokens.Text).text;
	const match = ALERT_MARKER.exec(text);
	const kind = ALERT_KINDS.find(candidate => candidate === match?.groups?.kind.toLowerCase());
	if (!match || !kind) {
		return undefined;
	}
	const remainder = text.slice(match[0].length);
	let restInline: marked.Token[];
	if (remainder) {
		const restText: marked.Tokens.Text = { ...(first as marked.Tokens.Text), raw: remainder, text: remainder };
		restInline = [restText, ...inline.slice(1)];
	} else if (match[0].endsWith('\n') || inline.length === 1) {
		restInline = inline.slice(1);
	} else {
		// `[!NOTE]*文*` のように、印と同じ行に別のトークンが続く
		return undefined;
	}
	const rest = tokens.slice(1);
	if (restInline.length === 0) {
		return { kind, tokens: rest };
	}
	const restParagraph: marked.Tokens.Paragraph = { ...(paragraph as marked.Tokens.Paragraph), tokens: restInline };
	return { kind, tokens: [restParagraph, ...rest] };
}

/** 注意書きを描く marked の拡張。注意書きでない引用は既定の描き方に任せる。 */
export function markedParadisAlertExtension(): marked.MarkedExtension {
	return {
		renderer: {
			blockquote(this: marked.Renderer, token: marked.Tokens.Blockquote): string | false {
				const alert = paradisMarkdownAlertOf(token.tokens);
				if (!alert) {
					return false;
				}
				const body = this.parser.parse(alert.tokens);
				return `<div class="paradis-markdown-alert paradis-markdown-alert-${alert.kind}" role="note">\n<p class="paradis-markdown-alert-title">${escape(alertLabel(alert.kind))}</p>\n${body}</div>\n`;
			},
		},
	};
}

// アイコンは線だけの SVG を mask にして、文字と同じ色で塗る（CSP は data: の画像を許している）。
function icon(paths: string): string {
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'>${paths}</svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const ALERT_ICONS: Readonly<Record<ParadisMarkdownAlertKind, string>> = {
	note: icon(`<circle cx='8' cy='8' r='6.5'/><path d='M8 7v4M8 5v.01'/>`),
	tip: icon(`<path d='M6 13h4M6.5 15h3M8 1.5a4.5 4.5 0 0 0-2.5 8.2V11h5V9.7A4.5 4.5 0 0 0 8 1.5z'/>`),
	important: icon(`<path d='M2 2.5h12v8.5H8l-3 2.5V11H2z'/><path d='M8 4.5v3.5M8 9.5v.01'/>`),
	warning: icon(`<path d='M8 2 15 14H1z'/><path d='M8 6v4M8 12v.01'/>`),
	caution: icon(`<path d='M5.3 1.5h5.4l3.8 3.8v5.4l-3.8 3.8H5.3l-3.8-3.8V5.3z'/><path d='M8 5v3.5M8 11v.01'/>`),
};

const ALERT_COLORS: Readonly<Record<ParadisMarkdownAlertKind, string>> = {
	note: 'var(--vscode-charts-blue)',
	tip: 'var(--vscode-charts-green)',
	important: 'var(--vscode-charts-purple)',
	warning: 'var(--vscode-charts-yellow)',
	caution: 'var(--vscode-charts-red)',
};

/** 注意書きの見た目（ビューアの `<style>` に入れる）。色はテーマの charts.* を使う。 */
export const PARADIS_MARKDOWN_ALERT_STYLES = `
.paradis-markdown-alert {
	margin: 0.75em 0;
	padding: 0.25em 1em;
	border-left: 3px solid;
}
.paradis-markdown-alert > :last-child {
	margin-bottom: 0.25em;
}
.paradis-markdown-alert-title {
	display: flex;
	align-items: center;
	gap: 6px;
	margin: 0.25em 0;
	font-weight: 500;
}
.paradis-markdown-alert-title + * {
	margin-top: 0;
}
.paradis-markdown-alert-title::before {
	content: "";
	flex: none;
	width: 1em;
	height: 1em;
	background-color: currentColor;
	-webkit-mask-position: center;
	-webkit-mask-size: contain;
	-webkit-mask-repeat: no-repeat;
}
${ALERT_KINDS.map(kind => `.paradis-markdown-alert-${kind} { border-left-color: ${ALERT_COLORS[kind]}; }
.paradis-markdown-alert-${kind} > .paradis-markdown-alert-title { color: ${ALERT_COLORS[kind]}; }
.paradis-markdown-alert-${kind} > .paradis-markdown-alert-title::before { -webkit-mask-image: ${ALERT_ICONS[kind]}; }`).join('\n')}
`;
