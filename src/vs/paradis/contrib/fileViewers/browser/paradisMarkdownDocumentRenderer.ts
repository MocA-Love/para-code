/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアの変換。upstream の `renderMarkdownDocument`
// （workbench/contrib/markdown/browser/markdownDocumentRenderer.ts）と同じ HTML を返す。
//
// なぜ自前で持つのか:
// upstream はコードの色付けを marked の async の walkTokens で行う。vendored の marked v14 の
// walkTokens はトークンを 1 つ辿るたびに結果の配列を作り直す（`values = values.concat(...)`）ので、
// **文書の大きさの二乗の時間がかかる**。1MB で約 0.5 秒、10MB では 80 秒以上、ワークベンチの UI
// スレッドが止まった（ベンチで実測）。marked v18 では直っているが、upstream はまだ v14 のまま。
// ここでは lex → コードのトークンを線形に集めて色付け → parse の順に分けて呼ぶ。使う marked・拡張・
// 色付け・消毒は upstream と同じなので、出力は変わらない（テストで upstream の関数と突き合わせている）。
//
// upstream の `renderMarkdownDocument` を変えたときは、この関数も合わせること。

import { sanitizeHtml } from '../../../../base/browser/domSanitize.js';
import { allowedMarkdownHtmlAttributes, allowedMarkdownHtmlTags } from '../../../../base/browser/markdownRenderer.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as marked from '../../../../base/common/marked/marked.js';
import { Schemas } from '../../../../base/common/network.js';
import { escape } from '../../../../base/common/strings.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { markedGfmHeadingIdPlugin } from '../../../../workbench/contrib/markdown/browser/markedGfmHeadingIdPlugin.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';

/** ビューアが使う設定だけ（upstream の同名の設定と同じ意味）。 */
export interface IParadisMarkdownDocumentOptions {
	readonly allowRelativeMediaPaths?: boolean;
	readonly allowRelativeLinkPaths?: boolean;
	readonly markedExtensions?: readonly marked.MarkedExtension[];
}

/**
 * Markdown を HTML にして消毒する。upstream の `renderMarkdownDocument` と同じ結果を、文書の大きさに
 * 比例する時間で返す。
 */
export async function renderParadisMarkdownDocument(
	text: string,
	extensionService: IExtensionService,
	languageService: ILanguageService,
	options: IParadisMarkdownDocumentOptions = {},
	token: CancellationToken = CancellationToken.None,
): Promise<TrustedHTML> {
	const highlight = async (code: string, lang: string | undefined): Promise<string> => {
		if (typeof lang !== 'string') {
			return escape(code);
		}
		// Mermaid は図として描き直すので、色付けせずに元の記法のまま渡す（upstream 側の PARA-PATCH と同じ）。
		if (lang.trim().toLowerCase() === 'mermaid') {
			return code;
		}
		await extensionService.whenInstalledExtensionsRegistered();
		if (token.isCancellationRequested) {
			return '';
		}
		const languageId = languageService.getLanguageIdByLanguageName(lang) ?? languageService.getLanguageIdByLanguageName(lang.split(/\s+|:|,|(?!^)\{|\?]/, 1)[0]);
		return tokenizeToString(languageService, code, languageId);
	};

	const m = new marked.Marked(
		{ renderer: { code: renderHighlightedCode } },
		markedGfmHeadingIdPlugin(),
		...(options.markedExtensions ?? []),
	);
	const tokens = m.lexer(text);
	const highlighting: Promise<void>[] = [];
	walkParadisMarkedTokens(tokens, m.defaults.extensions?.childTokens, codeToken => {
		highlighting.push(highlight(codeToken.text, codeToken.lang).then(code => {
			if (typeof code === 'string' && code !== codeToken.text) {
				codeToken.escaped = true;
				codeToken.text = code;
			}
		}));
	});
	await raceCancellationError(Promise.all(highlighting), token);
	const raw = m.parser(tokens);
	return sanitizeHtml(raw, {
		allowedLinkProtocols: { override: [Schemas.http, Schemas.https] },
		allowRelativeLinkPaths: options.allowRelativeLinkPaths,
		allowRelativeMediaPaths: options.allowRelativeMediaPaths,
		allowedTags: { override: allowedMarkdownHtmlTags },
		allowedAttributes: {
			override: [
				...allowedMarkdownHtmlAttributes,
				'name',
				'id',
				'class',
				'role',
				'tabindex',
				'placeholder',
			],
			augment: [],
		},
	});
}

/**
 * marked の walkTokens と同じ順・同じ範囲でトークンを辿り、コードのトークンを渡す。
 * marked の実装と違い、辿るたびに配列を作り直さない。
 */
export function walkParadisMarkedTokens(tokens: readonly marked.Token[], childTokens: Record<string, string[]> | undefined, onCode: (token: marked.Tokens.Code) => void): void {
	for (const token of tokens) {
		if (token.type === 'code') {
			onCode(token as marked.Tokens.Code);
		}
		switch (token.type) {
			case 'table': {
				const table = token as marked.Tokens.Table;
				for (const cell of table.header) {
					walkParadisMarkedTokens(cell.tokens, childTokens, onCode);
				}
				for (const row of table.rows) {
					for (const cell of row) {
						walkParadisMarkedTokens(cell.tokens, childTokens, onCode);
					}
				}
				break;
			}
			case 'list': {
				walkParadisMarkedTokens((token as marked.Tokens.List).items, childTokens, onCode);
				break;
			}
			default: {
				const generic = token as marked.Tokens.Generic;
				const childNames = childTokens?.[generic.type];
				if (childNames) {
					for (const name of childNames) {
						walkParadisMarkedTokens((generic[name] as marked.Token[]).flat(Infinity) as marked.Token[], childTokens, onCode);
					}
				} else if (generic.tokens) {
					walkParadisMarkedTokens(generic.tokens, childTokens, onCode);
				}
			}
		}
	}
}

/** upstream の markedHighlight の `renderer.code` と同じ（色付け済みなら `escaped` が立っている）。 */
function renderHighlightedCode({ text, lang, escaped }: marked.Tokens.Code): string {
	const classAttr = lang ? ` class="language-${escapeForMarked(lang)}"` : '';
	text = text.replace(/\n$/, '');
	return `<pre><code${classAttr}>${escaped ? text : escapeForMarked(text, true)}\n</code></pre>`;
}

// marked の helpers と同じエスケープ（upstream の MarkedHighlight と同じ写し）。
const escapeTest = /[&<>"']/;
const escapeReplace = new RegExp(escapeTest.source, 'g');
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = new RegExp(escapeTestNoEncode.source, 'g');
const escapeReplacements: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	[`'`]: '&#39;',
};
const getEscapeReplacement = (ch: string) => escapeReplacements[ch];

function escapeForMarked(html: string, encode?: boolean): string {
	if (encode) {
		if (escapeTest.test(html)) {
			return html.replace(escapeReplace, getEscapeReplacement);
		}
	} else if (escapeTestNoEncode.test(html)) {
		return html.replace(escapeReplaceNoEncode, getEscapeReplacement);
	}
	return html;
}
