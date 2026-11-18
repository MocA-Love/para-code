/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML の「プレビュー差分」の木の印付け。解析済みの前後の文書（DOMParser の結果で、ブラウジングコンテキストを
// 持たない）を受け取り、スクリプトを止め、body の下の要素を木のまま突き合わせて、変わった要素と語に印を付ける。
// 印を付けた文書は、そのまま文字列に戻して sandbox の iframe に入れる（paradisHtmlRenderedDiffFrame）。
//
// 比べるのは文字と要素まで。`<style>`・外の CSS・class・style 属性だけの変更は、どの要素の見た目が変わったかを
// 描いた結果を全部比べないと分からないので、色は付けずに件数だけを返す（属性が変わった要素には点線の印だけ付ける）。
//
// 並べ方:
// - 左右（`split`）: 両方の文書にその場で印を付ける。対応の取れた要素には同じ番号の `data-paradis-rdiff-anchor` を
//   付け、外枠のスクリプトが左右のスクロールをそこで合わせる（文書ごとに CSS が違うので、高さはそろえない）。
// - 1 列（`unified`）: 変更後の文書に、消えた要素を変更前の文書から複製して差し込み、消えた語を取り消し線で重ねる。
//
// 印に使う要素・属性は、ins・del・span と `paradis-rdiff-*` のクラス・`data-paradis-rdiff*` の属性だけ。

import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { alignParadisRenderedItems, diffParadisRenderedText, IParadisRenderedDiffItem, IParadisRenderedTextSegment, ParadisRenderedTextGranularity } from '../common/paradisRenderedDiff.js';
import { insertAtTextOffset, ParadisRenderedDiffLayout, PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE, wrapTextRanges } from './paradisRenderedDiffDom.js';

/** 要素の印の属性（`added`・`removed`・`changed`・`style`）。 */
export const PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE = 'data-paradis-rdiff';
/** 左右で対応の取れた要素の番号（スクロールを合わせる）。 */
export const PARADIS_HTML_RENDERED_DIFF_ANCHOR_ATTRIBUTE = 'data-paradis-rdiff-anchor';

/** body の下の要素の数の上限（片側）。超えたらプレビュー差分を出さない（ブロックの数の上限は一番上しか数えない）。 */
export const PARADIS_HTML_RENDERED_DIFF_MAX_ELEMENTS = 20_000;

/** 印の種類。`style` は class・style 属性だけが変わった要素。 */
type ParadisHtmlMark = 'added' | 'removed' | 'changed' | 'style';

/** 突き合わせの結果。 */
export interface IParadisHtmlRenderedDiffResult {
	/** 変わった所の数（↑↓ で回る数。番号は 0 から）。 */
	readonly changes: number;
	/** CSS の変更の数（`<style>`・`<link rel="stylesheet">` の変更と、class・style 属性だけが変わった要素）。 */
	readonly styleChanges: number;
}

/** 止めたスクリプトの数（`<script>` と、`on*` 属性・`javascript:` の URL を持っていた要素）。 */
export interface IParadisHtmlScriptStopResult {
	readonly stopped: number;
}

/** 見えない要素（並びに入れない）。CSS の要素は別に数える。 */
const INVISIBLE_TAGS = new Set(['script', 'style', 'link', 'meta', 'base', 'title', 'template', 'head']);

/**
 * 中の文字を語で比べない要素（中に印を入れるとページが壊れる、または中身が文字ではない）。違えば要素ごと印を付ける。
 */
const OPAQUE_TAGS = new Set(['script', 'style', 'textarea', 'select', 'option', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio', 'img', 'picture', 'template', 'input', 'noscript']);

/** 文の中に置かれる要素。子孫がこれだけ（と文字）の要素は、中の文字を語の単位で比べる。 */
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'label', 'font', 'tt', 'strike', 'big', 'nobr', 'ruby', 'rt', 'rp', 'img', 'button']);

/** `javascript:` などの URL を受け取る属性。 */
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'srcdoc', 'poster', 'background']);

/**
 * 文書のスクリプトを止める。`<script>`・`on*` の属性・`javascript:` の URL・`<meta http-equiv="refresh">`・
 * 著者の `<base>` を外す。sandbox の iframe（スクリプト無し）に入れるので動くことはないが、印の位置を変えられないよう
 * 木からも外しておく。
 */
export function stopParadisHtmlScripts(doc: Document): IParadisHtmlScriptStopResult {
	let stopped = 0;
	for (const element of Array.from(doc.querySelectorAll('script'))) {
		element.remove();
		stopped++;
	}
	for (const element of Array.from(doc.querySelectorAll('base, meta[http-equiv]'))) {
		if (element.localName === 'base' || element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') {
			element.remove();
		}
	}
	for (const element of Array.from(doc.getElementsByTagName('*'))) {
		let found = false;
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			// URL の前の空白と制御文字はブラウザが読み飛ばす
			// eslint-disable-next-line no-control-regex
			if (name.startsWith('on') || (URL_ATTRIBUTES.has(name) && /^[\u0000- ]*(?:javascript|vbscript):/i.test(attribute.value.replace(/[\t\n\r]/g, '')))) {
				element.removeAttribute(attribute.name);
				found = true;
			}
		}
		if (found) {
			stopped++;
		}
	}
	return { stopped };
}

/** body の下の要素の数。 */
export function countParadisHtmlElements(doc: Document): number {
	return doc.body ? doc.body.getElementsByTagName('*').length : 0;
}

/** 突き合わせの 1 件と、その元の節。 */
interface IChild {
	readonly node: Element | Text;
	readonly item: IParadisRenderedDiffItem;
}

function collapse(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/** 印の属性を除いた要素の書き方（鍵）。 */
function elementKey(element: Element): string {
	return collapse(element.outerHTML);
}

/** 並べる子（コメント・空白だけの文字・見えない要素は除く）。 */
function childItems(parent: Element): IChild[] {
	const result: IChild[] = [];
	for (const node of Array.from(parent.childNodes)) {
		if (node.nodeType === 3 /* TEXT_NODE */) {
			const text = collapse(node.textContent ?? '');
			if (text) {
				result.push({ node: node as Text, item: { kind: '#text', key: text } });
			}
		} else if (node.nodeType === 1 /* ELEMENT_NODE */) {
			const element = node as Element;
			if (!INVISIBLE_TAGS.has(element.localName)) {
				result.push({ node: element, item: { kind: element.localName, key: elementKey(element), text: collapse(element.textContent ?? '') } });
			}
		}
	}
	return result;
}

/** 子孫が文の中の要素と文字だけか（中の文字を語で比べられるか）。 */
function isLeaf(element: Element): boolean {
	if (OPAQUE_TAGS.has(element.localName)) {
		return false;
	}
	for (const descendant of Array.from(element.getElementsByTagName('*'))) {
		if (!INLINE_TAGS.has(descendant.localName)) {
			return false;
		}
	}
	return true;
}

/** 属性を名前の順に並べた文字列（印の属性は除く）。 */
function attributesKey(element: Element, predicate: (name: string) => boolean = () => true): string {
	return Array.from(element.attributes)
		.filter(attribute => !attribute.name.startsWith('data-paradis-rdiff') && predicate(attribute.name))
		.map(attribute => `${attribute.name}=${attribute.value}`)
		.sort()
		.join('\u0000');
}

const STYLE_ATTRIBUTES = new Set(['class', 'style']);

/** 属性の違いが class・style だけか。 */
function onlyStyleAttributesDiffer(o: Element, m: Element): boolean {
	return attributesKey(o, name => !STYLE_ATTRIBUTES.has(name)) === attributesKey(m, name => !STYLE_ATTRIBUTES.has(name));
}

/** 文書の CSS（`<style>` の中身と `<link rel="stylesheet">` の行き先）の並び。 */
function styleItems(doc: Document): IParadisRenderedDiffItem[] {
	const items: IParadisRenderedDiffItem[] = [];
	for (const element of Array.from(doc.querySelectorAll('style, link'))) {
		if (element.localName === 'style') {
			items.push({ kind: 'style', key: collapse(element.textContent ?? '') });
		} else if ((element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) {
			items.push({ kind: 'link', key: element.getAttribute('href') ?? '' });
		}
	}
	return items;
}

/** 突き合わせの途中の状態。 */
class ParadisHtmlDiffMarker {

	private _changes = 0;
	private _styleChanges = 0;
	private _anchors = 0;

	constructor(
		private readonly _modified: Document,
		private readonly _layout: ParadisRenderedDiffLayout,
		private readonly _token: CancellationToken | undefined,
	) { }

	get result(): IParadisHtmlRenderedDiffResult {
		return { changes: this._changes, styleChanges: this._styleChanges };
	}

	countStyleChanges(count: number): void {
		this._styleChanges += count;
	}

	/** 2 つの要素の子を突き合わせて印を付ける。 */
	markChildren(o: Element, m: Element): void {
		if (this._token?.isCancellationRequested) {
			throw new CancellationError();
		}
		const originalChildren = childItems(o);
		const modifiedChildren = childItems(m);
		const rows = alignParadisRenderedItems(originalChildren.map(child => child.item), modifiedChildren.map(child => child.item), { token: this._token });
		// 1 列のとき、消えた子を差し込む先（次に現れる変更後の子の前。無ければ親の最後）。
		const pending: Node[] = [];
		const flush = (before: Node | undefined) => {
			for (const node of pending) {
				if (before) {
					before.parentNode?.insertBefore(node, before);
				} else {
					m.appendChild(node);
				}
			}
			pending.length = 0;
		};
		for (const row of rows) {
			const left = row.original !== undefined ? originalChildren[row.original].node : undefined;
			const right = row.modified !== undefined ? modifiedChildren[row.modified].node : undefined;
			if (right) {
				flush(right);
			}
			switch (row.kind) {
				case 'equal':
					this._anchor(left!, right!);
					break;
				case 'changed':
					if (isElement(left!) && isElement(right!)) {
						this._anchor(left, right);
						this._markPair(left, right);
					} else if (!isElement(left!) && !isElement(right!)) {
						this._markTextPair(left, right);
					} else {
						// 文字と要素が入れ替わった。消えた方を先に置く
						this._markRemoved(left!, pending);
						flush(right);
						this._markAdded(right!);
					}
					break;
				case 'removed':
					this._markRemoved(left!, pending);
					break;
				case 'added':
					this._markAdded(right!);
					break;
			}
		}
		flush(undefined);
	}

	/** 同じ種類の 2 つの要素（中身か属性が違う）。 */
	private _markPair(o: Element, m: Element): void {
		if (OPAQUE_TAGS.has(o.localName)) {
			const styleOnly = o.innerHTML === m.innerHTML && onlyStyleAttributesDiffer(o, m);
			this._markElements(o, m, styleOnly ? 'style' : 'changed');
			return;
		}
		if (isLeaf(o) && isLeaf(m)) {
			const granularity: ParadisRenderedTextGranularity = o.localName === 'pre' || o.closest('pre') ? 'line' : 'word';
			if (this._markText(o as HTMLElement, m as HTMLElement, granularity)) {
				return;
			}
			if (o.innerHTML !== m.innerHTML) {
				// 文字は同じで、中の要素（太字・リンクの行き先・画像など）が変わった
				this._markElements(o, m, 'changed');
			} else if (attributesKey(o) !== attributesKey(m)) {
				this._markElements(o, m, onlyStyleAttributesDiffer(o, m) ? 'style' : 'changed');
			}
			return;
		}
		if (attributesKey(o) !== attributesKey(m)) {
			if (onlyStyleAttributesDiffer(o, m)) {
				// 中の変更は子ごとに印を付けるので、この要素には点線だけ（番号は付けない）
				m.setAttribute(PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE, 'style');
				if (this._layout === 'split') {
					o.setAttribute(PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE, 'style');
				}
				this._styleChanges++;
			}
			// それ以外の属性（id・href など）の違いは、中の印で分かるものとして数えない
		}
		this.markChildren(o, m);
	}

	/** 両方とも文字の節。 */
	private _markTextPair(o: Text, m: Text): void {
		const left = wrapTextNode(o);
		const right = wrapTextNode(m);
		if (!this._markText(left, right, 'word')) {
			unwrap(left);
			unwrap(right);
		}
	}

	/**
	 * 文字を比べて印を付ける。見える違いがあれば番号を付けて `true`。`split` は消えた語を `o` に、足された語を `m` に
	 * 付け、`unified` は `m` に足された語の印を付け、消えた語を取り消し線の要素として差し込む。
	 */
	private _markText(o: HTMLElement, m: HTMLElement, granularity: ParadisRenderedTextGranularity): boolean {
		const segments = diffParadisRenderedText(o.textContent ?? '', m.textContent ?? '', granularity, { token: this._token });
		const visible = (segment: IParadisRenderedTextSegment) => segment.kind !== 'equal' && segment.text.trim().length > 0;
		if (!segments.some(visible)) {
			return false;
		}
		const trimmed = (segment: IParadisRenderedTextSegment, start: number) => {
			const leading = segment.text.length - segment.text.trimStart().length;
			return { start: start + leading, length: segment.text.trim().length };
		};
		const added = segments.filter(segment => segment.kind === 'added' && visible(segment));
		const removed = segments.filter(segment => segment.kind === 'removed' && visible(segment));
		wrapTextRanges(m, added.map(segment => trimmed(segment, segment.modifiedStart)), 'ins');
		if (this._layout === 'split') {
			wrapTextRanges(o, removed.map(segment => trimmed(segment, segment.originalStart)), 'del');
		} else {
			// 後ろから差し込む（差し込んだ文字の分だけ、それより後ろの位置がずれるため）
			for (let i = removed.length - 1; i >= 0; i--) {
				const element = this._modified.createElement('del');
				element.className = 'paradis-rdiff-w';
				element.textContent = removed[i].text;
				insertAtTextOffset(m, removed[i].modifiedStart, element);
			}
		}
		this._markElements(o, m, 'changed', false);
		return true;
	}

	/** 両側の要素に印と番号を付ける。`outline` が `false` なら番号だけ（語の印で分かる）。 */
	private _markElements(o: Element, m: Element, mark: ParadisHtmlMark, outline = true): void {
		const change = String(this._changes++);
		for (const element of this._layout === 'split' ? [o, m] : [m]) {
			element.setAttribute(PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE, change);
			if (outline) {
				element.setAttribute(PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE, mark);
			}
		}
		if (mark === 'style') {
			this._styleChanges++;
		}
	}

	private _markAdded(node: Element | Text): void {
		const element = isElement(node) ? node : wrapTextNode(node);
		element.setAttribute(PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE, 'added');
		element.setAttribute(PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE, String(this._changes++));
	}

	private _markRemoved(node: Element | Text, pending: Node[]): void {
		const change = String(this._changes++);
		if (this._layout === 'split') {
			const element = isElement(node) ? node : wrapTextNode(node);
			element.setAttribute(PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE, 'removed');
			element.setAttribute(PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE, change);
			return;
		}
		const copy = this._modified.importNode(node, true) as Element | Text;
		const element = isElement(copy) ? copy : wrapTextNode(copy);
		element.setAttribute(PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE, 'removed');
		element.setAttribute(PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE, change);
		pending.push(element);
	}

	/** 左右で対応の取れた要素に同じ番号を付ける（1 列では使わない）。 */
	private _anchor(o: Element | Text, m: Element | Text): void {
		if (this._layout === 'split' && isElement(o) && isElement(m)) {
			const anchor = String(this._anchors++);
			o.setAttribute(PARADIS_HTML_RENDERED_DIFF_ANCHOR_ATTRIBUTE, anchor);
			m.setAttribute(PARADIS_HTML_RENDERED_DIFF_ANCHOR_ATTRIBUTE, anchor);
		}
	}
}

function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}

/** 文字の節を印の span で包む（印は要素にしか付けられないため）。 */
function wrapTextNode(node: Text): HTMLElement {
	const element = node.ownerDocument.createElement('span');
	element.className = 'paradis-rdiff-t';
	node.replaceWith(element);
	element.append(node);
	return element;
}

function unwrap(element: HTMLElement): void {
	element.replaceWith(...Array.from(element.childNodes));
}

/**
 * 前後の文書を突き合わせて印を付ける（スクリプトは先に {@link stopParadisHtmlScripts} で止めておく）。`split` は両方の
 * 文書を、`unified` は変更後の文書だけを書き換える。取り消されたら `CancellationError` を投げる。
 */
export function markParadisHtmlRenderedDiff(original: Document, modified: Document, layout: ParadisRenderedDiffLayout, token?: CancellationToken): IParadisHtmlRenderedDiffResult {
	const marker = new ParadisHtmlDiffMarker(modified, layout, token);
	const styles = alignParadisRenderedItems(styleItems(original), styleItems(modified), { token });
	marker.countStyleChanges(styles.filter(row => row.kind !== 'equal').length);
	if (original.body && modified.body) {
		marker.markChildren(original.body, modified.body);
	}
	return marker.result;
}

/**
 * 印の見た目（iframe の中のページの `<head>` の末尾に入れる）。ページの CSS に負けないよう `!important` を付ける。色は
 * 外枠が写す差分エディタのテーマの色（CSS 変数）だけを使う。
 */
export function paradisHtmlRenderedDiffPageStyle(layout: ParadisRenderedDiffLayout): string {
	const attribute = PARADIS_HTML_RENDERED_DIFF_ATTRIBUTE;
	return `ins.paradis-rdiff-w{text-decoration:none !important;background-color:var(--vscode-diffEditor-insertedTextBackground) !important;border-radius:2px;}`
		+ `del.paradis-rdiff-w{background-color:var(--vscode-diffEditor-removedTextBackground) !important;border-radius:2px;${layout === 'split' ? 'text-decoration:none !important;' : ''}}`
		+ `[${attribute}="added"]{background-color:var(--vscode-diffEditor-insertedTextBackground) !important;outline:2px solid var(--vscode-editorGutter-addedBackground) !important;outline-offset:1px;}`
		+ `[${attribute}="removed"]{background-color:var(--vscode-diffEditor-removedTextBackground) !important;outline:2px solid var(--vscode-editorGutter-deletedBackground) !important;outline-offset:1px;${layout === 'unified' ? 'text-decoration:line-through !important;' : ''}}`
		+ `[${attribute}="changed"]{outline:2px solid var(--vscode-editorGutter-modifiedBackground) !important;outline-offset:1px;}`
		+ `[${attribute}="style"]{outline:1px dashed var(--vscode-editorGutter-modifiedBackground) !important;outline-offset:1px;}`
		+ `.paradis-rdiff-current{outline:2px solid var(--vscode-focusBorder) !important;outline-offset:2px;}`;
}

// ワークベンチは Trusted Types を強制しており、DOMParser.parseFromString に生の文字列を渡すと落ちる。素通しの
// ポリシーで包んで渡す（名前は workbench.html の trusted-types の一覧に載せてある）。DOMParser が作る文書は
// ブラウジングコンテキストを持たず、スクリプトも画像の読み込みも走らない。ここでは木を書き換えて文字列に戻すだけで、
// 要素をワークベンチの画面へ入れない（ページは webview の中の sandbox の iframe に入れる）。
const ttPolicy = createTrustedTypesPolicy('paradisHtmlRenderedDiff', { createHTML: value => value });

/** HTML の文字列を、ブラウジングコンテキストを持たない文書に解析する。 */
export function parseParadisHtmlDiffDocument(html: string): Document {
	const trusted = ttPolicy?.createHTML(html) ?? html;
	return new DOMParser().parseFromString(trusted as unknown as string, 'text/html');
}

/** iframe に入れるページと、突き合わせの結果。 */
export interface IParadisHtmlRenderedDiffPages extends IParadisHtmlRenderedDiffResult {
	/** 左右のときの変更前のページ（1 列なら `undefined`）。 */
	readonly originalHtml: string | undefined;
	/** 変更後のページ（1 列なら消えた所を重ねたページ）。 */
	readonly modifiedHtml: string;
	/** 止めたスクリプトの数（両側の合計）。 */
	readonly stoppedScripts: number;
}

/**
 * 前後の HTML の文字列から、iframe に入れるページを作る。`headHtml` は両側の `<head>` の先頭に入れるもの（`<base>` と
 * ビューアの既定のスタイル）。要素が多すぎて比べないときは `undefined`。取り消されたら `CancellationError` を投げる。
 */
export function buildParadisHtmlRenderedDiffPages(originalText: string, modifiedText: string, layout: ParadisRenderedDiffLayout, headHtml: string, token?: CancellationToken): IParadisHtmlRenderedDiffPages | undefined {
	const original = parseParadisHtmlDiffDocument(originalText);
	const modified = parseParadisHtmlDiffDocument(modifiedText);
	if (countParadisHtmlElements(original) > PARADIS_HTML_RENDERED_DIFF_MAX_ELEMENTS || countParadisHtmlElements(modified) > PARADIS_HTML_RENDERED_DIFF_MAX_ELEMENTS) {
		return undefined;
	}
	const stoppedScripts = stopParadisHtmlScripts(original).stopped + stopParadisHtmlScripts(modified).stopped;
	const result = markParadisHtmlRenderedDiff(original, modified, layout, token);
	const style = paradisHtmlRenderedDiffPageStyle(layout);
	return {
		...result,
		stoppedScripts,
		originalHtml: layout === 'split' ? serializeParadisHtmlDiffDocument(original, headHtml, style) : undefined,
		modifiedHtml: serializeParadisHtmlDiffDocument(modified, headHtml, style),
	};
}

/**
 * 文書を文字列に戻す。`<!DOCTYPE>` を残し（落とすと quirks mode で描かれる）、`<head>` の先頭に `headHtml`、末尾に
 * 印の見た目を入れる。`headHtml` は解析し直さず文字列のまま入れるため、目印の要素を置いて文字列で差し替える。
 */
export function serializeParadisHtmlDiffDocument(doc: Document, headHtml: string, markStyle: string): string {
	const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild);
	const placeholder = doc.createElement('meta');
	const marker = `paradis-rdiff-head-${generateUuid()}`;
	placeholder.setAttribute('name', marker);
	head.insertBefore(placeholder, head.firstChild);
	const style = doc.createElement('style');
	style.textContent = markStyle;
	head.appendChild(style);
	const doctype = doc.doctype ? `${new XMLSerializer().serializeToString(doc.doctype)}\n` : '';
	return doctype + doc.documentElement.outerHTML.replace(`<meta name="${marker}">`, () => headHtml);
}
