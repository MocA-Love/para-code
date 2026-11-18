/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// プレビュー差分の木を組み立てる。両側の描いたブロック（消毒の後の木の要素）を、突き合わせの純関数
// （common/paradisRenderedDiff）の結果に沿って、左右（行ごとに高さのそろう 2 列）か 1 列（消えた語を取り消し線で
// 重ねる）に並べ、変わったブロック・項目・行・語に印を付ける。
//
// 印は DOM の API だけで付ける（文字は text node のまま動かし、足す要素は span・ins・del・figure・figcaption と
// 決まったクラス・`data-paradis-rdiff*` の属性だけ）。消毒の結果を緩めることはない。

import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { alignParadisRenderedItems, diffParadisRenderedText, IParadisRenderedDiffItem, IParadisRenderedDiffRow, IParadisRenderedTextSegment, ParadisRenderedTextGranularity } from '../common/paradisRenderedDiff.js';

/** 並べ方。`split` は左右、`unified` は 1 列。 */
export type ParadisRenderedDiffLayout = 'split' | 'unified';

/** 片側の文書。`blocks` と `items` は同じ順・同じ数。 */
export interface IParadisRenderedDiffSide {
	readonly blocks: readonly HTMLElement[];
	readonly items: readonly IParadisRenderedDiffItem[];
}

/** 木に入れる文言（ローカライズ済み）。 */
export interface IParadisRenderedDiffLabels {
	/** 左右の列の見出し（変更前）。 */
	readonly original: string;
	/** 左右の列の見出し（変更後）。 */
	readonly modified: string;
	/** 1 列で前後を上下に置くときの、変更前の見出し。 */
	readonly before: string;
	/** 1 列で前後を上下に置くときの、変更後の見出し。 */
	readonly after: string;
}

export interface IParadisRenderedDiffResult {
	readonly root: HTMLElement;
	/** 変わったブロックの数（↑↓ で回る数）。 */
	readonly changes: number;
}

/** 変わったブロックに付ける属性（値は 0 から始まる番号。↑↓ で探す）。 */
export const PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE = 'data-paradis-rdiff-change';
/** 項目・行に付ける属性（`added`・`removed`）。 */
const ITEM_ATTRIBUTE = 'data-paradis-rdiff';

const MARKS: { readonly [K in IParadisRenderedDiffRow['kind']]: string } = { equal: '', added: '+', removed: '−', changed: '~' };

/** 画像・図など、語の単位では比べられない中身を含むか。 */
function hasMedia(element: HTMLElement): boolean {
	return descendants(element, node => MEDIA_TAGS.has(node.tagName) || node.classList.contains('paradis-mermaid')).length > 0;
}

const MEDIA_TAGS = new Set(['IMG', 'svg', 'SVG', 'VIDEO', 'PICTURE']);

/** 要素の中（自分も含む）の、条件に合う要素を文書の順に集める。 */
function descendants(root: HTMLElement, predicate: (element: Element) => boolean): HTMLElement[] {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
	const found: HTMLElement[] = [];
	for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
		if (predicate(node as Element)) {
			found.push(node as HTMLElement);
		}
	}
	return found;
}

/** ブロックの一番上のリストの項目（入れ子のリストの項目は含めない）。 */
function listItems(block: HTMLElement): HTMLElement[] {
	const items: HTMLElement[] = [];
	for (const list of Array.from(block.children)) {
		if (list.tagName === 'UL' || list.tagName === 'OL') {
			items.push(...Array.from(list.children).filter((child): child is HTMLElement => child.tagName === 'LI'));
		}
	}
	return items;
}

/** ブロックの表の行。 */
function tableRows(block: HTMLElement): HTMLElement[] {
	return descendants(block, element => element.tagName === 'TR');
}

/**
 * 両側の文書を突き合わせて、プレビュー差分の木を `doc` の中に作る（`doc` には入れない。呼び出し側が置く）。
 * 両側のブロックは複製して使う（元の木は変えない）。取り消されたら `CancellationError` を投げる。
 */
export function buildParadisRenderedDiff(doc: Document, original: IParadisRenderedDiffSide, modified: IParadisRenderedDiffSide, layout: ParadisRenderedDiffLayout, labels: IParadisRenderedDiffLabels, token?: CancellationToken): IParadisRenderedDiffResult {
	const withText = (side: IParadisRenderedDiffSide) => side.items.map((item, index) => ({ ...item, text: side.blocks[index].textContent ?? '' }));
	const rows = alignParadisRenderedItems(withText(original), withText(modified), { token });
	const root = doc.createElement('div');
	root.className = `paradis-rdiff paradis-rdiff-${layout}`;
	if (layout === 'split') {
		root.append(caption(doc, labels.original, false), caption(doc, labels.modified, true));
	}
	let changes = 0;
	for (const row of rows) {
		const o = row.original !== undefined ? doc.importNode(original.blocks[row.original], true) as HTMLElement : undefined;
		const m = row.modified !== undefined ? doc.importNode(modified.blocks[row.modified], true) as HTMLElement : undefined;
		const change = row.kind === 'equal' ? undefined : changes++;
		const kind = (row.original !== undefined ? original.items[row.original] : modified.items[row.modified!]).kind;
		if (layout === 'split') {
			let left = o;
			let right = m;
			if (row.kind === 'changed') {
				markSplitPair(o!, m!, kind, token);
			}
			left = left ? block(doc, row.kind, change, left) : ghost(doc);
			right = right ? block(doc, row.kind, change, right) : ghost(doc);
			root.append(cell(doc, left, false), cell(doc, right, true));
			continue;
		}
		if (row.kind === 'changed') {
			root.append(block(doc, 'changed', change, mergeUnifiedPair(doc, o!, m!, kind, labels, token)));
		} else {
			root.append(block(doc, row.kind, change, (m ?? o)!));
		}
	}
	return { root, changes };
}

function caption(doc: Document, text: string, right: boolean): HTMLElement {
	const element = doc.createElement('div');
	element.className = right ? 'paradis-rdiff-cap paradis-rdiff-cap-r' : 'paradis-rdiff-cap';
	element.textContent = text;
	return element;
}

function cell(doc: Document, content: HTMLElement, right: boolean): HTMLElement {
	const element = doc.createElement('div');
	element.className = right ? 'paradis-rdiff-cell paradis-rdiff-cell-r' : 'paradis-rdiff-cell';
	element.append(content);
	return element;
}

/** ブロックを印の枠で包む（変わっていなければ枠だけ）。 */
function block(doc: Document, kind: IParadisRenderedDiffRow['kind'], change: number | undefined, content: HTMLElement): HTMLElement {
	const element = doc.createElement('div');
	element.className = kind === 'equal' ? 'paradis-rdiff-b' : `paradis-rdiff-b paradis-rdiff-${kind}`;
	if (change !== undefined) {
		element.setAttribute(PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE, String(change));
		const mark = doc.createElement('span');
		mark.className = 'paradis-rdiff-gm';
		mark.setAttribute('aria-hidden', 'true');
		mark.textContent = MARKS[kind];
		element.append(mark);
	}
	// 包みの div（描いたときのブロックの境目）は外し、中身だけを入れる。
	element.append(...Array.from(content.childNodes));
	return element;
}

/** 反対側にしか無いブロックの、こちら側の空き（斜線）。 */
function ghost(doc: Document): HTMLElement {
	const element = doc.createElement('div');
	element.className = 'paradis-rdiff-b paradis-rdiff-ghost';
	element.setAttribute('aria-hidden', 'true');
	return element;
}

/** 左右に並べる「変更」の組に、消えた所（左）・足された所（右）の印を付ける。 */
function markSplitPair(o: HTMLElement, m: HTMLElement, kind: string, token: CancellationToken | undefined): void {
	if (kind === 'mermaid') {
		return;
	}
	if (kind === 'list' && markItems(o, m, listItems, false, undefined, token)) {
		return;
	}
	if (kind === 'table' && markItems(o, m, tableRows, true, undefined, token)) {
		return;
	}
	markText(o, m, kind === 'code' ? 'line' : 'word', 'split', token);
}

/**
 * 1 列に重ねる「変更」の組。文字は変更後の側に、消えた語を取り消し線で差し込み、足された語に色を付ける。
 * 図・画像・コードを含むものは、変更前と変更後を上下に置く。
 */
function mergeUnifiedPair(doc: Document, o: HTMLElement, m: HTMLElement, kind: string, labels: IParadisRenderedDiffLabels, token: CancellationToken | undefined): HTMLElement {
	if (kind === 'mermaid' || kind === 'code' || hasMedia(o) || hasMedia(m)) {
		if (kind === 'code') {
			markText(o, m, 'line', 'split', token);
		}
		const swap = doc.createElement('div');
		swap.className = 'paradis-rdiff-swap';
		swap.append(figure(doc, 'paradis-rdiff-swap-o', labels.before, o), figure(doc, 'paradis-rdiff-swap-n', labels.after, m));
		const wrapper = doc.createElement('div');
		wrapper.append(swap);
		return wrapper;
	}
	if (kind === 'list' && markItems(o, m, listItems, false, doc, token)) {
		return m;
	}
	if (kind === 'table' && markItems(o, m, tableRows, true, doc, token)) {
		return m;
	}
	markText(o, m, 'word', 'unified', token);
	return m;
}

function figure(doc: Document, className: string, label: string, content: HTMLElement): HTMLElement {
	const element = doc.createElement('figure');
	element.className = className;
	const title = doc.createElement('figcaption');
	title.textContent = label;
	element.append(title, ...Array.from(content.childNodes));
	return element;
}

/**
 * リストの項目・表の行を突き合わせて印を付ける。`mergeInto` を渡すと 1 列の形（変更後の側に、消えた項目・行を
 * 差し込む）にする。両側に項目・行が無ければ何もせず `false`。
 */
function markItems(o: HTMLElement, m: HTMLElement, itemsOf: (block: HTMLElement) => HTMLElement[], isRow: boolean, mergeInto: Document | undefined, token: CancellationToken | undefined): boolean {
	const originalItems = itemsOf(o);
	const modifiedItems = itemsOf(m);
	if (originalItems.length === 0 || modifiedItems.length === 0) {
		return false;
	}
	const toItem = (element: HTMLElement): IParadisRenderedDiffItem => {
		const key = isRow ? Array.from(element.children, child => child.textContent ?? '').join('\u001f') : element.textContent ?? '';
		return { kind: isRow ? element.parentElement?.tagName ?? 'tr' : 'li', key };
	};
	const rows = alignParadisRenderedItems(originalItems.map(toItem), modifiedItems.map(toItem), { token });
	const layout: ParadisRenderedDiffLayout = mergeInto ? 'unified' : 'split';
	// 1 列の形で、消えた項目・行を差し込む先（次に現れる変更後の項目・行の前。無ければ最後の項目・行の後）。
	const pending: HTMLElement[] = [];
	const flush = (before: HTMLElement | undefined) => {
		for (const element of pending) {
			if (before) {
				before.before(element);
			} else {
				modifiedItems[modifiedItems.length - 1].after(element);
			}
		}
		pending.length = 0;
	};
	for (const row of rows) {
		const left = row.original !== undefined ? originalItems[row.original] : undefined;
		const right = row.modified !== undefined ? modifiedItems[row.modified] : undefined;
		if (right) {
			flush(right);
		}
		switch (row.kind) {
			case 'added':
				right!.setAttribute(ITEM_ATTRIBUTE, 'added');
				break;
			case 'removed':
				left!.setAttribute(ITEM_ATTRIBUTE, 'removed');
				if (mergeInto) {
					// 項目・行の中の印（入れ子のリストなど）も含めて、そのまま差し込む
					pending.push(mergeInto.importNode(left!, true) as HTMLElement);
				}
				break;
			case 'changed': {
				const leftCells = isRow ? Array.from(left!.children) as HTMLElement[] : [left!];
				const rightCells = isRow ? Array.from(right!.children) as HTMLElement[] : [right!];
				if (leftCells.length !== rightCells.length) {
					// 列の数が違う行は、行ごと消えて足されたことにする
					right!.setAttribute(ITEM_ATTRIBUTE, 'added');
					left!.setAttribute(ITEM_ATTRIBUTE, 'removed');
					if (mergeInto) {
						right!.before(mergeInto.importNode(left!, true));
					}
					break;
				}
				leftCells.forEach((leftCell, index) => markText(leftCell, rightCells[index], 'word', layout, token));
				break;
			}
		}
	}
	flush(undefined);
	return true;
}

/**
 * 2 つの要素の文字を比べて印を付ける。`split` は消えた所を `o` に、足された所を `m` に付ける。`unified` は `m` に
 * 足された所の印を付け、消えた所を取り消し線の要素として `m` の中の同じ位置に差し込む（`o` は変えない）。
 */
function markText(o: HTMLElement, m: HTMLElement, granularity: ParadisRenderedTextGranularity, layout: ParadisRenderedDiffLayout, token: CancellationToken | undefined): void {
	const segments = diffParadisRenderedText(o.textContent ?? '', m.textContent ?? '', granularity, { token });
	const visible = (segment: IParadisRenderedTextSegment) => segment.text.trim().length > 0;
	// 印は前後の空白を外して付ける（語の間の空白まで色が付くと読みにくい）。
	const trimmed = (segment: IParadisRenderedTextSegment, start: number): ITextRange => {
		const leading = segment.text.length - segment.text.trimStart().length;
		return { start: start + leading, length: segment.text.trim().length };
	};
	wrapTextRanges(m, segments.filter(segment => segment.kind === 'added' && visible(segment)).map(segment => trimmed(segment, segment.modifiedStart)), 'ins');
	if (layout === 'split') {
		wrapTextRanges(o, segments.filter(segment => segment.kind === 'removed' && visible(segment)).map(segment => trimmed(segment, segment.originalStart)), 'del');
		return;
	}
	// 後ろから差し込む（差し込んだ文字の分だけ、それより後ろの位置がずれるため）。
	const removed = segments.filter(segment => segment.kind === 'removed' && visible(segment));
	for (let i = removed.length - 1; i >= 0; i--) {
		const element = m.ownerDocument.createElement('del');
		element.className = 'paradis-rdiff-w';
		element.textContent = removed[i].text;
		insertAtTextOffset(m, removed[i].modifiedStart, element);
	}
}

interface ITextRange {
	readonly start: number;
	readonly length: number;
}

/** 要素の中の文字（text node を前から順につないだもの）の位置の範囲を、`tag` の要素で包む。範囲は前から順に渡す。 */
export function wrapTextRanges(root: HTMLElement, ranges: readonly ITextRange[], tag: 'ins' | 'del'): void {
	if (ranges.length === 0) {
		return;
	}
	const doc = root.ownerDocument;
	const texts = textNodes(root);
	// 包む前に、各 text node の始まりの位置を決めておく（包むと text node が分かれるため）。
	const starts: number[] = [];
	let offset = 0;
	for (const text of texts) {
		starts.push(offset);
		offset += text.data.length;
	}
	for (let i = texts.length - 1; i >= 0; i--) {
		const nodeStart = starts[i];
		const nodeEnd = nodeStart + texts[i].data.length;
		// この text node に掛かる範囲を、後ろから切り出して包む（前の位置がずれないように）。
		for (let r = ranges.length - 1; r >= 0; r--) {
			const from = Math.max(ranges[r].start, nodeStart);
			const to = Math.min(ranges[r].start + ranges[r].length, nodeEnd);
			if (from >= to) {
				continue;
			}
			let target = texts[i];
			if (to < nodeEnd) {
				target.splitText(to - nodeStart);
			}
			if (from > nodeStart) {
				target = target.splitText(from - nodeStart);
			}
			const element = doc.createElement(tag);
			element.className = 'paradis-rdiff-w';
			target.replaceWith(element);
			element.append(target);
		}
	}
}

/** 要素の中の文字の位置 `offset` に `node` を差し込む。位置が text node の境目なら、前の text node の後ろに置く。 */
export function insertAtTextOffset(root: HTMLElement, offset: number, node: Node): void {
	const texts = textNodes(root);
	let position = 0;
	for (const text of texts) {
		const end = position + text.data.length;
		if (offset <= end) {
			if (offset === end) {
				text.after(node);
			} else if (offset === position) {
				text.before(node);
			} else {
				text.splitText(offset - position).before(node);
			}
			return;
		}
		position = end;
	}
	(texts.length ? texts[texts.length - 1].parentNode ?? root : root).appendChild(node);
}

function textNodes(root: HTMLElement): Text[] {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const result: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		result.push(node as Text);
	}
	return result;
}

/** プレビュー差分の見た目。色は差分エディタのテーマの色（webview に配られる CSS 変数）だけを使う。 */
export const PARADIS_RENDERED_DIFF_STYLES = `
body.paradis-rdiff-body { max-width: none; padding: 0 0 24px; }
.paradis-rdiff-unified { max-width: 882px; margin: 0 auto; padding: 0 20px 0 36px; }
.paradis-rdiff-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.paradis-rdiff-cell { min-width: 0; padding: 0 16px 0 30px; box-sizing: border-box; }
.paradis-rdiff-cell-r { box-shadow: inset 1px 0 0 var(--vscode-editorGroup-border); }
.paradis-rdiff-cap { position: sticky; top: 0; z-index: 1; padding: 3px 12px; font-size: 11px; line-height: 18px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); box-shadow: 0 1px 0 var(--vscode-editorGroup-border); }
.paradis-rdiff-cap-r { box-shadow: inset 1px 0 0 var(--vscode-editorGroup-border), 0 1px 0 var(--vscode-editorGroup-border); }
.paradis-rdiff-b { position: relative; padding: 1px 10px 1px 26px; margin: 0 -10px 0 -26px; border-radius: 4px; }
.paradis-rdiff-split .paradis-rdiff-b { height: 100%; box-sizing: border-box; }
.paradis-rdiff-b > :not(.paradis-rdiff-gm):first-of-type { margin-top: 0.6em; }
.paradis-rdiff-b > :last-child { margin-bottom: 0.6em !important; }
.paradis-rdiff-added { background: var(--vscode-diffEditor-insertedLineBackground); }
.paradis-rdiff-removed { background: var(--vscode-diffEditor-removedLineBackground); }
.paradis-rdiff-changed { background: color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 12%, transparent); }
.paradis-rdiff-gm { position: absolute; left: 6px; top: 6px; width: 14px; height: 18px; font: 600 13px/18px var(--vscode-editor-font-family); text-align: center; user-select: none; }
.paradis-rdiff-added > .paradis-rdiff-gm { color: var(--vscode-editorGutter-addedBackground); }
.paradis-rdiff-removed > .paradis-rdiff-gm { color: var(--vscode-editorGutter-deletedBackground); }
.paradis-rdiff-changed > .paradis-rdiff-gm { color: var(--vscode-editorGutter-modifiedBackground); }
.paradis-rdiff-current { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.paradis-rdiff-ghost { min-height: 28px; opacity: 0.6; background-image: linear-gradient(-45deg, var(--vscode-diffEditor-diagonalFill) 12.5%, transparent 12.5%, transparent 50%, var(--vscode-diffEditor-diagonalFill) 50%, var(--vscode-diffEditor-diagonalFill) 62.5%, transparent 62.5%, transparent 100%); background-size: 8px 8px; }
ins.paradis-rdiff-w { text-decoration: none; background: var(--vscode-diffEditor-insertedTextBackground); border-radius: 2px; }
del.paradis-rdiff-w { background: var(--vscode-diffEditor-removedTextBackground); border-radius: 2px; }
.paradis-rdiff-split del.paradis-rdiff-w { text-decoration: none; }
[${ITEM_ATTRIBUTE}="added"] { background: var(--vscode-diffEditor-insertedTextBackground); }
[${ITEM_ATTRIBUTE}="removed"] { background: var(--vscode-diffEditor-removedTextBackground); }
.paradis-rdiff-unified [${ITEM_ATTRIBUTE}="removed"] { text-decoration: line-through; }
li[${ITEM_ATTRIBUTE}] { border-radius: 2px; }
.paradis-rdiff-swap { display: grid; gap: 8px; }
.paradis-rdiff-swap figure { margin: 0; padding: 6px; border-radius: 4px; min-width: 0; }
.paradis-rdiff-swap-o { background: var(--vscode-diffEditor-removedLineBackground); }
.paradis-rdiff-swap-n { background: var(--vscode-diffEditor-insertedLineBackground); }
.paradis-rdiff-swap figcaption { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
`;

/**
 * ページの中の補助スクリプト（nonce 付き）。ワークベンチから `{ paradisRenderedDiffGo: n }` が届いたら、n 番目の
 * 変更へスクロールして枠を付ける。
 */
export function paradisRenderedDiffNavigationScript(nonce: string): string {
	return `<script nonce="${nonce}">
(function () {
	var attribute = '${PARADIS_RENDERED_DIFF_CHANGE_ATTRIBUTE}';
	window.addEventListener('message', function (event) {
		var data = event.data;
		if (!data || typeof data.paradisRenderedDiffGo !== 'number') { return; }
		var previous = document.querySelectorAll('.paradis-rdiff-current');
		for (var i = 0; i < previous.length; i++) { previous[i].classList.remove('paradis-rdiff-current'); }
		var targets = document.querySelectorAll('[' + attribute + '="' + data.paradisRenderedDiffGo + '"]');
		for (var j = 0; j < targets.length; j++) { targets[j].classList.add('paradis-rdiff-current'); }
		if (targets.length) { targets[0].scrollIntoView({ block: 'center' }); }
	});
})();
</script>`;
}

/** ワークベンチからページへ送る「n 番目の変更へ」。 */
export function paradisRenderedDiffGoMessage(index: number): { readonly paradisRenderedDiffGo: number } {
	return { paradisRenderedDiffGo: index };
}
