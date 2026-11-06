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
//
// 色付けしたコードを消毒の後に差し込む（`renderParadisMarkdownDocumentDeferred`）:
// 色付けの結果は span で元のコードの 3 倍ほどの長さになり、消毒（DOMPurify）の時間の大半を占めていた
// （1MB の文書で 345 ms）。色付けの結果は決まった形（`tokenizeToString` が作る div・span・br と、
// エスケープ済みの文字）しか持たないので、消毒には印だけを渡し、消毒した木に DOM の API で同じ要素を
// 組み立てて差し込む。文字は text node として入れるので HTML として解釈されず、要素は div・span・br、
// 属性は class だけ。形が決まった形と違う・消毒で印が消えたなどのときは、今までどおり全体を消毒する。
// 出来上がる木は全体を消毒した場合と同じ（テストで突き合わせている）。

import { sanitizeHtml } from '../../../../base/browser/domSanitize.js';
import { allowedMarkdownHtmlAttributes, allowedMarkdownHtmlTags } from '../../../../base/browser/markdownRenderer.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as marked from '../../../../base/common/marked/marked.js';
import { Schemas } from '../../../../base/common/network.js';
import { escape } from '../../../../base/common/strings.js';
import { generateUuid } from '../../../../base/common/uuid.js';
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
	return (await renderMarkdown(text, extensionService, languageService, options, token, false)).html;
}

/** {@link renderParadisMarkdownDocumentDeferred} の結果。 */
export interface IParadisMarkdownDocument {
	/** 消毒済みの HTML。色付けしたコードは、まだ印のまま。 */
	readonly html: TrustedHTML;
	/**
	 * `html` を解析した木（`body`）の印を、色付けしたコードに置き換える。出来上がる木は
	 * {@link renderParadisMarkdownDocument} の結果を解析した木と同じ。
	 */
	insertHighlightedCode(body: HTMLElement): void;
}

/**
 * {@link renderParadisMarkdownDocument} と同じ文書を、色付けしたコードを消毒に通さずに返す
 * （理由はこのモジュールの冒頭）。呼び出し側は `html` を解析した木に `insertHighlightedCode` を当てること。
 */
export function renderParadisMarkdownDocumentDeferred(
	text: string,
	extensionService: IExtensionService,
	languageService: ILanguageService,
	options: IParadisMarkdownDocumentOptions = {},
	token: CancellationToken = CancellationToken.None,
): Promise<IParadisMarkdownDocument> {
	return renderMarkdown(text, extensionService, languageService, options, token, true);
}

async function renderMarkdown(
	text: string,
	extensionService: IExtensionService,
	languageService: ILanguageService,
	options: IParadisMarkdownDocumentOptions,
	token: CancellationToken,
	defer: boolean,
): Promise<IParadisMarkdownDocument> {
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
	const deferred: IDeferredCode[] = [];
	const marker = `PARADISHL${generateUuid().replace(/-/g, '')}N`;
	walkParadisMarkedTokens(tokens, m.defaults.extensions?.childTokens, codeToken => {
		highlighting.push(highlight(codeToken.text, codeToken.lang).then(code => {
			if (typeof code === 'string' && code !== codeToken.text) {
				codeToken.escaped = true;
				codeToken.text = code;
				const segments = defer ? parseParadisTokenizedCode(code) : undefined;
				if (segments) {
					codeToken.text = `${marker}${deferred.length}Z`;
					deferred.push({ token: codeToken, html: code, segments });
				}
			}
		}));
	});
	await raceCancellationError(Promise.all(highlighting), token);
	const html = sanitizeMarkdownHtml(m.parser(tokens), options);
	if (deferred.length === 0) {
		return { html, insertHighlightedCode: () => { } };
	}
	if (!hasEachMarkerOnce(html.toString(), marker, deferred.length)) {
		// 消毒で印が消えた・増えた。差し込む場所が決まらないので、今までどおり全体を消毒する。
		for (const code of deferred) {
			code.token.text = code.html;
		}
		return { html: sanitizeMarkdownHtml(m.parser(tokens), options), insertHighlightedCode: () => { } };
	}
	return { html, insertHighlightedCode: body => insertParadisTokenizedCode(body, marker, deferred) };
}

/** 消毒に通さずに差し込むコード。 */
interface IDeferredCode {
	readonly token: marked.Tokens.Code;
	/** 色付けの結果（印に置き換える前の HTML）。 */
	readonly html: string;
	readonly segments: readonly ParadisTokenizedSegment[];
}

/** 色付けの結果の 1 片。`undefined` は改行（`<br/>`）。 */
type ParadisTokenizedSegment = { readonly className: string; readonly text: string } | undefined;

function sanitizeMarkdownHtml(raw: string, options: IParadisMarkdownDocumentOptions): TrustedHTML {
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

const TOKENIZED_OPEN = '<div class="monaco-tokenized-source">';
const TOKENIZED_CLOSE = '</div>';
// `tokenizeToString` の 1 片。文字は `strings.escape` が `<` `>` `&` だけをエスケープしたもの。
// 文字の部分は 1 文字ずつの選択にして、合わないときに後戻りが爆発しないようにしている。
const TOKENIZED_SEGMENT = /<br\/>|<span class="([a-z\d]+(?: [a-z\d]+)*)">((?:[^<>&]|&(?:lt|gt|amp);)*)<\/span>/y;
// HTML として解析すると形が変わる文字（NUL は捨てられる。CR は LF になる。対の無いサロゲート）。
// これを含む片は差し込まず、今までどおり消毒に通す。
const CHANGED_BY_PARSING = /[\0\r]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * `tokenizeToString` の結果を片に分ける。決まった形（div の中に span と br だけ、span の中は
 * エスケープ済みの文字だけ）でなければ `undefined`（差し込まずに消毒へ回す）。
 */
export function parseParadisTokenizedCode(html: string): readonly ParadisTokenizedSegment[] | undefined {
	if (!html.startsWith(TOKENIZED_OPEN) || !html.endsWith(TOKENIZED_CLOSE)) {
		return undefined;
	}
	const end = html.length - TOKENIZED_CLOSE.length;
	const segments: ParadisTokenizedSegment[] = [];
	let offset = TOKENIZED_OPEN.length;
	while (offset < end) {
		TOKENIZED_SEGMENT.lastIndex = offset;
		const match = TOKENIZED_SEGMENT.exec(html);
		if (!match || match.index !== offset || TOKENIZED_SEGMENT.lastIndex > end) {
			return undefined;
		}
		offset = TOKENIZED_SEGMENT.lastIndex;
		if (match[1] === undefined) {
			segments.push(undefined);
			continue;
		}
		const text = match[2].replace(/&(lt|gt|amp);/g, (_, name: string) => name === 'lt' ? '<' : name === 'gt' ? '>' : '&');
		if (CHANGED_BY_PARSING.test(text)) {
			return undefined;
		}
		segments.push({ className: match[1], text });
	}
	return offset === end ? segments : undefined;
}

/** 印がそれぞれちょうど 1 回だけ、ほかの番号の印は無いこと。 */
function hasEachMarkerOnce(html: string, marker: string, count: number): boolean {
	const seen = new Array<number>(count).fill(0);
	let index = html.indexOf(marker);
	while (index !== -1) {
		const match = /^(\d+)Z/.exec(html.slice(index + marker.length, index + marker.length + 12));
		const n = match ? Number(match[1]) : -1;
		if (n < 0 || n >= count || ++seen[n] > 1) {
			return false;
		}
		index = html.indexOf(marker, index + marker.length);
	}
	return seen.every(value => value === 1);
}

/** 木の中の印を、色付けしたコードの要素に置き換える。要素は div・span・br、属性は class、文字は text node だけ。 */
function insertParadisTokenizedCode(body: HTMLElement, marker: string, codes: readonly IDeferredCode[]): void {
	const doc = body.ownerDocument;
	const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
	const found: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if ((node as Text).data.includes(marker)) {
			found.push(node as Text);
		}
	}
	const pattern = new RegExp(`${marker}(\\d+)Z`, 'g');
	for (const node of found) {
		const data = node.data;
		const parts: Node[] = [];
		let last = 0;
		for (const match of data.matchAll(pattern)) {
			if (match.index > last) {
				parts.push(doc.createTextNode(data.slice(last, match.index)));
			}
			parts.push(buildTokenizedCode(doc, codes[Number(match[1])].segments));
			last = match.index + match[0].length;
		}
		if (last < data.length) {
			parts.push(doc.createTextNode(data.slice(last)));
		}
		node.replaceWith(...parts);
	}
}

function buildTokenizedCode(doc: Document, segments: readonly ParadisTokenizedSegment[]): HTMLElement {
	const container = doc.createElement('div');
	container.className = 'monaco-tokenized-source';
	for (const segment of segments) {
		if (!segment) {
			container.appendChild(doc.createElement('br'));
			continue;
		}
		const span = doc.createElement('span');
		span.className = segment.className;
		if (segment.text) {
			span.appendChild(doc.createTextNode(segment.text));
		}
		container.appendChild(span);
	}
	return container;
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
