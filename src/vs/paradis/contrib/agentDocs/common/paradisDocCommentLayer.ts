/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown / HTML のプレビューに重ねるコメント層の、ページ側のスクリプト。
//
// ページ側がするのは、選んだ文字から位置を作って「ここにコメントを書きたい」と知らせることと、コメントの場所に
// 色を付けて当て直しの結果を知らせることだけ。**コメントの本文を書く欄・保存・カードの列はワークベンチの DOM に
// 置く**（paradisDocCommentsController.ts）。ページのスクリプトは同じオリジンの webview の基盤
// （pre/index.html の `__vscode_post_message__`）へ `top` の子のフレームを辿って届くので、webview から来る
// メッセージはどれもページが作れる前提にする。ページから届いても困らないもの（開く欄の引用、色の位置、
// スクロール位置）だけを受け、本文を運ぶメッセージは作らない。
//
// 置き方は 2 つ:
//  - Markdown: 文書（自前。CSP は nonce）の末尾にスクリプトを足し、文書の中に層を置く。
//  - HTML: 自前の外枠の文書（{@link paradisDocCommentWrapperDocument}）に、ページを `<iframe srcdoc>` で入れる。
//    外枠のスクリプトが、同じオリジンの中のページの DOM を外から読む。ページの CSP に当たらず、信頼していない
//    ワークスペースでは中の iframe の sandbox に `allow-scripts` を付けないので、ページと子のフレームのスクリプトは
//    止めたまま層だけ動く。webview の基盤は中身の window（＝外枠）にだけ購読を付けるので、ページのクリックの
//    リンク・キー・右クリック・スクロール位置・検索・拡大は外枠が持ち直す。
//
// 枠と「コメント」のボタンは、対象の文書の `<html>` の直下に置いた独自要素の closed な shadow root に入れ、
// 見た目は CSSOM（`style.setProperty`）だけで付ける（`<style>` と style 属性を使わないので、ページや Markdown の
// CSP の `style-src` に当たらず、ページの CSS も届かない）。
//
// 外枠からワークベンチへのメッセージには、描くたびに作る印（token）を付ける。印は外枠のスクリプトの閉じた変数に
// だけ置き、読んだ直後にスクリプトの要素を外す。ワークベンチは印の合わないメッセージを捨てる。キーとリンクは
// ワークベンチでコマンドやファイルを開く操作になるので、ページが作った（印を知らない）ものを通さないため。

import { PARADIS_DOC_ANCHOR_FUNCTIONS, IParadisDocAnchor, PARADIS_DOC_CONTEXT_CHARS } from './paradisDocCommentAnchor.js';
import { ParadisDocCommentPlace, paradisReadDocAnchor, paradisReadDocCommentPlaces } from './paradisDocComments.js';

/** ページ → ワークベンチ。 */
const LAYER_MESSAGE_KEY = '__paradisDocComment';
/** ワークベンチ → ページ（表示するコメント）。 */
const LAYER_STATE_KEY = '__paradisDocCommentState';
/** ワークベンチ → ページ（そのコメントの場所へスクロールする）。 */
const LAYER_REVEAL_KEY = '__paradisDocCommentReveal';
/** 拡大のメッセージ（paradisViewerZoom.ts と同じ印）。 */
const ZOOM_MESSAGE_KEY = '__paradisZoom';
/** 本文の差し替えのメッセージ（paradisViewerBodySwap.ts と同じ印）。外枠では中のページを入れ替える。 */
const BODY_MESSAGE_KEY = 'paradisViewerBody';
/** 外枠の中の、ページを入れる iframe の置き場。 */
const WRAPPER_STAGE_ID = 'paradis-doc-stage';

/** ページに見せるコメント（場所と、選んでいるか）。 */
export interface IParadisDocLayerComment {
	readonly id: string;
	readonly anchor: IParadisDocAnchor;
}

export interface IParadisDocLayerState {
	readonly comments: readonly IParadisDocLayerComment[];
	/** カードで選んでいるコメント。 */
	readonly activeId?: string;
	/** 書きかけのコメントの場所（欄を開いている間、本文に色を付ける）。 */
	readonly draft?: IParadisDocAnchor;
	/** エージェントがいま書き換えようとしているところ（「編集中」の印。Q663-5）。 */
	readonly editing?: IParadisDocLayerEditing;
}

/** ページに見せる「編集中」の印。 */
export interface IParadisDocLayerEditing {
	/** 印ごとの番号（同じ番号の間は、描き直しの後に場所が見つからなければ枠を外す）。 */
	readonly id: string;
	/** 札の文（「Claude Code が編集中」など）。 */
	readonly label: string;
	/** 書き換え前の文字列の先頭（Edit の `old_string`）。無ければ場所を探さず札だけ出す。 */
	readonly source?: string;
}

export interface IParadisDocLayerLabels {
	/** 選んだ文字の横に出すボタン。 */
	readonly comment: string;
	/** 読んでいる所より下に節が足されたときの知らせ（押すとそこへ移る）。 */
	readonly newSection: string;
}

/** ワークベンチへ転送するキーの中身（webview の基盤の `KeyEvent` と同じ欄）。 */
export interface IParadisDocLayerKey {
	readonly type: 'keydown' | 'keyup';
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly repeat: boolean;
}

/** ページから届いたメッセージ（印を確かめた後）。 */
export type ParadisDocLayerMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'compose'; readonly anchor: IParadisDocAnchor }
	| { readonly type: 'places'; readonly places: ReadonlyMap<string, ParadisDocCommentPlace> }
	| { readonly type: 'focus'; readonly id: string }
	| { readonly type: 'link'; readonly href: string }
	| { readonly type: 'scroll'; readonly progress: number }
	| { readonly type: 'key'; readonly event: IParadisDocLayerKey };

const ID_PATTERN = /^c-[a-z0-9]{6,32}$/;

/**
 * webview から届いたメッセージがコメント層のもので、印が合えば取り出す。形の違うもの・印の合わないものは捨てる。
 * 本文を運ぶ型は無い（届いても読まない）。
 */
export function paradisReadDocLayerMessage(message: unknown, token: string | undefined): ParadisDocLayerMessage | undefined {
	if (typeof message !== 'object' || message === null || !token) {
		return undefined;
	}
	const data = message as Record<string, unknown>;
	if (data.token !== token) {
		return undefined;
	}
	switch (data[LAYER_MESSAGE_KEY]) {
		case 'ready':
			return { type: 'ready' };
		case 'compose': {
			const anchor = paradisReadDocAnchor(data.anchor);
			if (anchor === undefined) {
				return undefined;
			}
			const { place: _place, ...rest } = anchor;
			return { type: 'compose', anchor: rest };
		}
		case 'places':
			return { type: 'places', places: paradisReadDocCommentPlaces(data.places) };
		case 'focus':
			return typeof data.id === 'string' && ID_PATTERN.test(data.id) ? { type: 'focus', id: data.id } : undefined;
		case 'link':
			return typeof data.href === 'string' && data.href.length > 0 && data.href.length <= 8_000 ? { type: 'link', href: data.href } : undefined;
		case 'scroll':
			return typeof data.progress === 'number' && Number.isFinite(data.progress) && data.progress >= 0 ? { type: 'scroll', progress: data.progress } : undefined;
		case 'key': {
			const event = paradisReadDocLayerKey(data.event);
			return event ? { type: 'key', event } : undefined;
		}
	}
	return undefined;
}

function paradisReadDocLayerKey(value: unknown): IParadisDocLayerKey | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const event = value as Record<string, unknown>;
	if ((event.type !== 'keydown' && event.type !== 'keyup') || typeof event.key !== 'string' || event.key.length > 64 || typeof event.code !== 'string' || event.code.length > 64
		|| typeof event.keyCode !== 'number' || !Number.isInteger(event.keyCode)) {
		return undefined;
	}
	return {
		type: event.type, key: event.key, code: event.code, keyCode: event.keyCode,
		shiftKey: event.shiftKey === true, altKey: event.altKey === true, ctrlKey: event.ctrlKey === true, metaKey: event.metaKey === true, repeat: event.repeat === true,
	};
}

/** ページへ送る、表示するコメント。 */
export function paradisDocLayerStateMessage(state: IParadisDocLayerState): { readonly [LAYER_STATE_KEY]: IParadisDocLayerState } {
	return { [LAYER_STATE_KEY]: state };
}

/** ページへ送る、そのコメントの場所へスクロールする頼み。 */
export function paradisDocLayerRevealMessage(id: string): { readonly [LAYER_REVEAL_KEY]: string } {
	return { [LAYER_REVEAL_KEY]: id };
}

/**
 * Markdown の本文を差し替えた後に動かす JavaScript（`paradisViewerBodySwapScript` の `afterSwap` に足す）。差し替えの前後の
 * ブロックを比べて、変わったブロックに差分の色を付ける（拡大・読み込み・表示の更新では比べない）。
 */
export const PARADIS_DOC_LAYER_RERUN_SCRIPT = `if(window.__paradisDocLayerSwapped){window.__paradisDocLayerSwapped();}`;

/** 描き直しで変わったブロックがこれより多ければ（書き直し）、差分の色も知らせも出さない。 */
const DIFF_MAX_BLOCKS = 60;

/** `<script>` の中に置く JSON。 */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * 層の本体。`O` は設定（labels・state）、`A` は当て直しの関数、`env` は置き方ごとの口:
 * `post(message)` はワークベンチへ送る（印は env が付ける）、`doc()`・`win()` は対象の文書と window、
 * `listen(cb)` はワークベンチからのメッセージ（印は無い。ページが作れても困らないものだけ）。
 */
const LAYER_BODY = `function (O, A, env) {
	'use strict';
	var L = O.labels, state = O.state || { comments: [] };
	function sx(el, o) { for (var k in o) { el.style.setProperty(k, o[k], 'important'); } }
	function color(name, fallback) {
		var v = '';
		try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { }
		return v || fallback;
	}
	var ACCENT = color('--vscode-focusBorder', '#0969da');
	var PANEL = color('--vscode-editorWidget-background', '#f6f8fa');
	var TEXT = color('--vscode-editorWidget-foreground', color('--vscode-foreground', '#1f2328'));
	var LINE = color('--vscode-widget-border', color('--vscode-editorWidget-border', '#d0d7de'));
	var MARK = color('--vscode-editor-findMatchHighlightBackground', 'rgba(234,92,0,.33)');
	var ADDED = color('--vscode-diffEditor-insertedTextBackground', 'rgba(46,160,67,.25)');
	var EDIT = color('--vscode-paradis-accent', ACCENT);
	var EDIT_TEXT = color('--vscode-badge-foreground', '#ffffff');
	var FONT = '12px/22px system-ui, sans-serif';
	var TAG_FONT = '10px/16px system-ui, sans-serif';

	var layer = null, boxes = null, fixed = null, index = null, bound = null, button = null, pending = null;
	var hits = [], reported = {};
	// 差分: 前の差し替えのときのブロックの文字の並び（snap。前の文書の要素は持たない）と、変わったブロックの要素。知らせ（pill）は足された節が画面より下のとき
	var snap = null, changedEls = [], pill = null, pillTarget = null;
	// 「編集中」の印: 同じ番号の印のまま本文が差し替わったか（差し替わった後は、そのままの文が見つかるときだけ枠を出す）
	var editingSeen = null, editRect = null;
	function zoomOf() { var d = env.doc(), z = d && d.documentElement && d.documentElement.currentCSSZoom; return z && z > 0 ? z : 1; }
	var blockCache = null;
	function blockOf(el, root) {
		var start = el, w = env.win();
		while (el && el !== root && el.nodeType === 1) {
			var hit = blockCache && blockCache.get(el);
			if (hit === undefined) { hit = String(w.getComputedStyle(el).display).indexOf('inline') !== 0; if (blockCache) { blockCache.set(el, hit); } }
			if (hit) { return el; }
			el = el.parentElement;
		}
		return el || start;
	}
	var SPACE = /\\s/;
	/** 対象の文書の文字を、空白を均して 1 本にする（文字の位置 ⇄ DOM の位置の対応つき）。 */
	function buildIndex() {
		var d = env.doc();
		if (!d) { return null; }
		var root = d.getElementById('paradis-viewer-body') || d.body;
		if (!root) { return null; }
		blockCache = typeof WeakMap === 'function' ? new WeakMap() : null;
		var w = d.createTreeWalker(root, 4);
		var text = '', nodes = [], maps = [], heads = [], blocks = [], lastSpace = true, lastBlock = null, n;
		while ((n = w.nextNode())) {
			var p = n.parentNode;
			if (!p || p.nodeType !== 1) { continue; }
			var tag = p.nodeName;
			if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') { continue; }
			var block = blockOf(p, root);
			if (block !== lastBlock) {
				if (!lastSpace) { text += ' '; lastSpace = true; }
				if (blocks.length) { blocks[blocks.length - 1].end = text.length; }
				blocks.push({ el: block, start: text.length, end: text.length });
				lastBlock = block;
				if (/^H[1-6]$/.test(block.nodeName)) { heads.push({ at: text.length, text: String(block.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) }); }
			}
			var data = n.data, map = new Array(data.length + 1);
			for (var i = 0; i < data.length; i++) {
				map[i] = text.length;
				var ch = data.charAt(i);
				if (SPACE.test(ch)) { if (!lastSpace) { text += ' '; lastSpace = true; } } else { text += ch; lastSpace = false; }
			}
			map[data.length] = text.length;
			nodes.push(n); maps.push(map);
		}
		if (blocks.length) { blocks[blocks.length - 1].end = text.length; }
		return { text: text, nodes: nodes, maps: maps, root: root, heads: heads, blocks: blocks };
	}
	function headingAt(pos) {
		var h = '';
		for (var i = 0; i < index.heads.length && index.heads[i].at <= pos; i++) { h = index.heads[i].text; }
		return h;
	}
	function nodeAt(pos) {
		var lo = 0, hi = index.nodes.length - 1, k = 0;
		while (lo <= hi) { var mid = (lo + hi) >> 1; if (index.maps[mid][0] <= pos) { k = mid; lo = mid + 1; } else { hi = mid - 1; } }
		return k;
	}
	function rangeFor(start, end) {
		if (!index || !index.nodes.length) { return null; }
		var r = env.doc().createRange();
		var a = nodeAt(start), ma = index.maps[a], i = 0;
		while (i < ma.length - 1 && ma[i] < start) { i++; }
		var b = nodeAt(Math.max(start, end - 1)), mb = index.maps[b], j = 0;
		while (j < mb.length - 1 && mb[j] < end) { j++; }
		try { r.setStart(index.nodes[a], i); r.setEnd(index.nodes[b], j); } catch (e) { return null; }
		return r;
	}
	function posOf(range, atStart) {
		var node = atStart ? range.startContainer : range.endContainer, offset = atStart ? range.startOffset : range.endOffset;
		var k = index.nodes.indexOf(node);
		if (k !== -1) { return index.maps[k][Math.min(offset, index.maps[k].length - 1)]; }
		var found = -1;
		for (var i = 0; i < index.nodes.length; i++) {
			var c;
			try { c = range.comparePoint(index.nodes[i], 0); } catch (e) { continue; }
			if (atStart) { if (c >= 0) { return index.maps[i][0]; } } else if (c <= 0) { found = i; } else { break; }
		}
		return found === -1 ? -1 : index.maps[found][index.maps[found].length - 1];
	}
	function cssPath(el) {
		var d = env.doc(), parts = [];
		while (el && el.nodeType === 1 && el !== d.documentElement && el !== d.body && parts.length < 12) {
			if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) { parts.unshift('#' + el.id); break; }
			var i = 1, s = el;
			while ((s = s.previousElementSibling)) { if (s.nodeName === el.nodeName) { i++; } }
			parts.unshift(el.nodeName.toLowerCase() + ':nth-of-type(' + i + ')');
			el = el.parentElement;
		}
		return parts.join(' > ');
	}
	function hintFor(selector) {
		if (!selector) { return undefined; }
		var el = null;
		try { el = env.doc().querySelector(selector); } catch (e) { }
		if (!el) { return undefined; }
		var first = -1, last = -1;
		for (var i = 0; i < index.nodes.length; i++) { if (el.contains(index.nodes[i])) { if (first === -1) { first = i; } last = i; } }
		return first === -1 ? undefined : { start: index.maps[first][0], end: index.maps[last][index.maps[last].length - 1] };
	}
	/** 画面の矩形 → 層の中の座標（文書の左上から。拡大率で割る）。 */
	function toLayer(r) {
		var w = env.win(), z = zoomOf();
		return { x: (r.left + w.scrollX) / z, y: (r.top + w.scrollY) / z, w: r.width / z, h: r.height / z };
	}
	function rectsOf(range) {
		var out = [], rs = range.getClientRects();
		for (var i = 0; i < rs.length; i++) { if (rs[i].width >= 1 && rs[i].height >= 1) { out.push(toLayer(rs[i])); } }
		return out;
	}
	function el(doc, tag, css, text) {
		var e = doc.createElement(tag);
		if (css) { sx(e, css); }
		if (text !== undefined) { e.textContent = text; }
		return e;
	}
	function box(r, css) {
		var b = el(env.doc(), 'div', { position: 'absolute', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', 'box-sizing': 'border-box', 'pointer-events': 'none', 'border-radius': '2px' });
		sx(b, css);
		boxes.appendChild(b);
		return b;
	}
	function ensureLayer() {
		var d = env.doc();
		if (!d || !d.documentElement || !d.body) { return false; }
		if (layer && layer.ownerDocument === d && layer.isConnected) { return true; }
		layer = d.createElement('paradis-doc-comment-layer');
		sx(layer, { all: 'initial' });
		sx(layer, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', 'z-index': '2147483647', 'pointer-events': 'none', display: 'block' });
		var shadow = layer.attachShadow({ mode: 'closed' });
		boxes = el(d, 'div', { position: 'absolute', left: '0', top: '0', font: FONT, color: TEXT });
		shadow.appendChild(boxes);
		// 画面に留める札と知らせ（本文と一緒に流れない）
		fixed = el(d, 'div', { position: 'fixed', left: '0', top: '0', width: '0', height: '0', font: FONT, color: TEXT });
		shadow.appendChild(fixed);
		pill = null;
		d.documentElement.appendChild(layer);
		if (bound !== d) { bound = d; bind(d); }
		return true;
	}
	function bind(d) {
		var w = env.win();
		d.addEventListener('mouseup', function (e) { if (e.isTrusted) { setTimeout(onSelect, 0); } });
		d.addEventListener('keyup', function (e) { if (e.isTrusted && e.shiftKey) { setTimeout(onSelect, 0); } });
		d.addEventListener('click', function (e) {
			if (!e.isTrusted || !index) { return; }
			if (e.altKey && O.commentable !== false) {
				e.preventDefault(); e.stopPropagation();
				var r = d.createRange();
				r.selectNodeContents(e.target);
				var s = posOf(r, true), t = posOf(r, false);
				if (s >= 0 && t > s) { compose({ start: s, end: Math.min(t, s + 80), selector: cssPath(e.target) }); }
				return;
			}
			var z = zoomOf(), x = (e.clientX + w.scrollX) / z, y = (e.clientY + w.scrollY) / z;
			for (var i = 0; i < hits.length; i++) {
				for (var j = 0; j < hits[i].rects.length; j++) {
					var b = hits[i].rects[j];
					if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { env.post({ ${LAYER_MESSAGE_KEY}: 'focus', id: hits[i].id }); return; }
				}
			}
		}, true);
		// 中で巻き取る要素のスクロールだけ描き直す（文書そのもののスクロールでは枠は文書と一緒に動く）
		d.addEventListener('scroll', function (e) { if (e.target !== d) { schedule(); } else { checkPill(); } }, true);
		// 幅が変わると選んだ文字の位置も変わるので、「コメント」のボタンは外す（選び直せば出る）
		function relayout() { hideButton(); schedule(); }
		w.addEventListener('resize', relayout);
		if (typeof w.ResizeObserver === 'function') {
			try { new w.ResizeObserver(relayout).observe(d.body); } catch (e) { }
		}
	}
	var timer = 0;
	function schedule() { if (!timer) { timer = setTimeout(function () { timer = 0; draw(); }, 60); } }
	function hideButton() { if (button && button.parentNode) { button.parentNode.removeChild(button); } button = null; }
	function onSelect() {
		if (O.commentable === false) { return; }
		var w = env.win(), sel = w && w.getSelection && w.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !ensureLayer()) { hideButton(); return; }
		index = buildIndex();
		if (!index) { hideButton(); return; }
		var r = sel.getRangeAt(0);
		if (!index.root.contains(r.commonAncestorContainer)) { hideButton(); return; }
		var s = posOf(r, true), e = posOf(r, false);
		if (s < 0 || e <= s) { hideButton(); return; }
		var c = r.commonAncestorContainer;
		pending = { start: s, end: e, selector: cssPath(c.nodeType === 1 ? c : c.parentElement) };
		var rs = rectsOf(r);
		if (!rs.length) { hideButton(); return; }
		var last = rs[rs.length - 1];
		hideButton();
		button = el(env.doc(), 'button', {
			position: 'absolute', left: Math.max(0, last.x + last.w - 8) + 'px', top: (last.y + last.h + 4) + 'px', height: '24px', 'box-sizing': 'border-box', 'pointer-events': 'auto', cursor: 'pointer',
			font: FONT, color: TEXT, background: PANEL, border: '1px solid ' + LINE, 'border-radius': '6px', padding: '0 8px', 'white-space': 'nowrap', 'box-shadow': '0 2px 8px rgba(0,0,0,.25)',
		}, L.comment);
		button.setAttribute('type', 'button');
		button.setAttribute('data-paradis-doc-comment', 'compose');
		// 押した瞬間に選択が外れて描き直されてもボタンが外れないよう、mousedown で選択を外させない
		button.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
		button.addEventListener('mouseup', function (ev) { ev.stopPropagation(); });
		button.addEventListener('click', function (ev) {
			ev.preventDefault(); ev.stopPropagation();
			if (!ev.isTrusted) { return; }
			var p = pending; hideButton();
			if (p) { compose(p); }
		});
		boxes.appendChild(button);
	}
	function compose(p) {
		if (!index) { return; }
		var C = ${PARADIS_DOC_CONTEXT_CHARS};
		var quote = index.text.slice(p.start, p.end).trim();
		if (!quote) { return; }
		var anchor = { quote: index.text.slice(p.start, p.end), before: index.text.slice(Math.max(0, p.start - C), p.start), after: index.text.slice(p.end, p.end + C) };
		if (p.selector) { anchor.selector = p.selector; }
		var heading = headingAt(p.start);
		if (heading) { anchor.heading = heading; }
		env.post({ ${LAYER_MESSAGE_KEY}: 'compose', anchor: anchor });
	}
	function clear(node) { while (node && node.firstChild) { node.removeChild(node.firstChild); } }
	/** 差分を比べるブロックの並び（文字の無いブロックは除く）。 */
	function blockList(idx) {
		var out = [];
		for (var i = 0; i < idx.blocks.length; i++) {
			var b = idx.blocks[i], t = idx.text.slice(b.start, b.end).trim();
			if (t) { out.push({ el: b.el, text: t }); }
		}
		return out;
	}
	function texts(list) { var out = []; for (var i = 0; i < list.length; i++) { out.push(list[i].text); } return out; }
	function takeSnapshot() {
		var idx = buildIndex();
		snap = idx ? texts(blockList(idx)) : null;
		changedEls = []; pillTarget = null;
	}
	/** 本文が差し替わった（Markdown の本文の差し替え・HTML の中のページの入れ替え）。変わったブロックに差分の色を付ける。 */
	function swapped() {
		reported = {};
		if (editingSeen) { editingSeen.swapped = true; }
		var idx = buildIndex(), next = idx ? blockList(idx) : null;
		changedEls = []; pillTarget = null;
		if (snap && next) {
			var r = A.diffBlocks(snap, texts(next));
			if (r.changed.length <= ${DIFF_MAX_BLOCKS}) {
				for (var i = 0; i < r.changed.length; i++) {
					var e = next[r.changed[i]].el;
					if (changedEls.indexOf(e) === -1) { changedEls.push(e); }
				}
				if (r.added && changedEls.length) { pillTarget = changedEls[0]; }
			}
		}
		snap = next ? texts(next) : null;
		draw();
	}
	/** 足された節が画面より下にあれば知らせを出す。見える所まで来たら外す。 */
	function checkPill() {
		if (!fixed) { return; }
		var w = env.win(), below = false;
		if (pillTarget && pillTarget.isConnected && w) {
			var r = pillTarget.getBoundingClientRect();
			below = r.top >= w.innerHeight;
			if (!below) { pillTarget = null; }
		}
		if (!below) {
			if (pill && pill.parentNode) { pill.parentNode.removeChild(pill); }
			pill = null;
			return;
		}
		if (pill && pill.isConnected) { return; }
		pill = el(env.doc(), 'button', {
			position: 'fixed', left: '50%', bottom: '10px', transform: 'translateX(-50%)', height: '24px', 'box-sizing': 'border-box', 'pointer-events': 'auto', cursor: 'pointer',
			font: FONT, color: TEXT, background: PANEL, border: '1px solid ' + LINE, 'border-radius': '999px', padding: '0 10px', 'white-space': 'nowrap', 'box-shadow': '0 2px 8px rgba(0,0,0,.25)',
		}, L.newSection);
		pill.setAttribute('type', 'button');
		pill.setAttribute('data-paradis-doc-comment', 'new-section');
		pill.addEventListener('click', function (ev) {
			ev.preventDefault(); ev.stopPropagation();
			if (!ev.isTrusted) { return; }
			var target = pillTarget, w2 = env.win();
			pillTarget = null; checkPill();
			if (target && target.isConnected && w2) {
				var r2 = target.getBoundingClientRect();
				try { w2.scrollTo({ top: Math.max(0, w2.scrollY + r2.top - 16), behavior: 'smooth' }); } catch (e) { }
			}
		});
		fixed.appendChild(pill);
	}
	/** 要素たちを囲む矩形（層の座標）。 */
	function unionRect(els) {
		var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
		for (var i = 0; i < els.length; i++) {
			if (!els[i] || !els[i].isConnected) { continue; }
			var r = toLayer(els[i].getBoundingClientRect());
			if (r.w < 1 && r.h < 1) { continue; }
			x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
		}
		return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
	}
	function drawDiff() {
		for (var i = 0; i < changedEls.length; i++) {
			var r = unionRect([changedEls[i]]);
			if (r) { box(r, { background: ADDED, 'box-shadow': '0 0 0 2px ' + ADDED }); }
		}
	}
	function tag(text, css) {
		var t = el(env.doc(), 'div', { 'box-sizing': 'border-box', height: '16px', padding: '0 6px', 'border-radius': '999px', background: EDIT, color: EDIT_TEXT, font: TAG_FONT, 'white-space': 'nowrap', 'pointer-events': 'none' }, text);
		sx(t, css);
		t.setAttribute('data-paradis-doc-comment', 'editing');
		return t;
	}
	/**
	 * 「編集中」の印。書き換え前の文字列が見つかれば、そのブロックを破線の枠で囲み、右上に札を出す。見つからない
	 * （Write・属性だけの書き換え）ときは画面の右上に札だけ。本文が差し替わった後は、そのままの文が見つかるときだけ枠を
	 * 出す（書き換えが入った後は、残った行の一部に当たって違う所を囲みうるため）。
	 */
	function drawEditing(idx) {
		var e = state.editing;
		editRect = null;
		if (!e) { editingSeen = null; return; }
		if (!editingSeen || editingSeen.id !== e.id) { editingSeen = { id: e.id, swapped: false }; }
		var loc = e.source && idx ? A.locate(idx.text, e.source, O.kind) : null;
		if (loc && editingSeen.swapped && loc.match !== 'exact') { loc = null; }
		var range = loc ? rangeFor(loc.start, Math.max(loc.start + 1, loc.end)) : null;
		var rect = null;
		if (range) {
			var sc = range.startContainer, ec = range.endContainer;
			rect = unionRect([blockOf(sc.nodeType === 1 ? sc : sc.parentElement, idx.root), blockOf(ec.nodeType === 1 ? ec : ec.parentElement, idx.root)]);
		}
		if (rect) {
			var pad = 5;
			editRect = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
			box(editRect, { border: '1px dashed ' + EDIT });
			boxes.appendChild(tag(e.label, { position: 'absolute', left: (editRect.x + editRect.w + 1) + 'px', top: Math.max(0, editRect.y - 17) + 'px', transform: 'translateX(-100%)' }));
			return;
		}
		if (!editingSeen.swapped || !e.source) {
			fixed.appendChild(tag(e.label, { position: 'fixed', right: '12px', top: '8px' }));
		}
	}
	function draw() {
		if (!ensureLayer()) { return; }
		var comments = state.comments || [];
		var keepButton = button; button = null;
		clear(boxes);
		var keepPill = pill && pill.parentNode === fixed ? pill : null;
		clear(fixed);
		hits = [];
		// 本文を読み直すのは、当てるもの（コメント・書きかけ・編集中の場所）があるときだけ
		var needIndex = comments.length > 0 || !!state.draft || !!(state.editing && state.editing.source);
		if (needIndex) { index = buildIndex(); }
		var places = {}, changed = false;
		if (needIndex && index) {
			for (var k = 0; k < comments.length; k++) {
				var c = comments[k], hit = A.resolve(index.text, c.anchor, hintFor(c.anchor.selector));
				var range = hit ? rangeFor(hit.start, hit.end) : null, rs = range ? rectsOf(range) : [];
				var place = 'lost';
				if (hit && rs.length) {
					place = hit.match === 'fuzzy' ? 'changed' : hit.ambiguous ? 'ambiguous' : 'found';
					var active = c.id === state.activeId;
					for (var q = 0; q < rs.length; q++) { box(rs[q], { background: MARK, 'border-bottom': (active ? '2px' : '1px') + ' solid ' + (active ? ACCENT : 'transparent') }); }
					hits.push({ id: c.id, rects: rs });
				}
				places[c.id] = place;
				if (reported[c.id] !== place) { changed = true; }
			}
			if (state.draft) {
				var dh = A.resolve(index.text, state.draft, hintFor(state.draft.selector)), dr = dh ? rangeFor(dh.start, dh.end) : null;
				var drs = dr ? rectsOf(dr) : [];
				for (var m = 0; m < drs.length; m++) { box(drs[m], { background: MARK, 'border-bottom': '2px solid ' + ACCENT }); }
			}
		}
		drawDiff();
		drawEditing(needIndex ? index : null);
		if (keepPill) { fixed.appendChild(keepPill); }
		checkPill();
		if (keepButton) { button = keepButton; boxes.appendChild(button); }
		if (changed) { reported = places; env.post({ ${LAYER_MESSAGE_KEY}: 'places', places: places }); }
	}
	function reveal(id) {
		for (var i = 0; i < hits.length; i++) {
			if (hits[i].id === id && hits[i].rects.length) {
				var w = env.win(), z = zoomOf(), y = hits[i].rects[0].y * z;
				try { w.scrollTo({ top: Math.max(0, y - w.innerHeight / 3), behavior: 'smooth' }); } catch (e) { }
				return;
			}
		}
	}
	env.listen(function (d) {
		if (d && d.${LAYER_STATE_KEY}) { state = d.${LAYER_STATE_KEY}; draw(); }
		if (d && typeof d.${LAYER_REVEAL_KEY} === 'string') { reveal(d.${LAYER_REVEAL_KEY}); }
	});
	return {
		refresh: function () { reported = {}; draw(); },
		start: function () { reported = {}; takeSnapshot(); draw(); env.post({ ${LAYER_MESSAGE_KEY}: 'ready' }); },
		swapped: swapped,
		// 「編集中」の枠の矩形（層の座標）。カーソルの演出（Q663-6、今は無し）を足すときはここへ
		// paradisCursorOverlay.ts の press・status を置く
		editingRect: function () { return editRect; },
	};
}`;

/**
 * Markdown の文書の末尾に入れる、コメント層のスクリプト（文書は自前で、CSP の nonce で止めているのでページの
 * スクリプトは無い）。webview の API は、ほかの補助スクリプトと同じ `window.__paradisVsCodeApi` を使う。
 */
export function paradisDocCommentInPageScript(nonce: string, token: string, labels: IParadisDocLayerLabels, state: IParadisDocLayerState, fromHost: string): string {
	return `<script nonce="${nonce}">(function(){try{
var T=${scriptJson(token)};
var api=window.__paradisVsCodeApi;if(!api&&typeof acquireVsCodeApi==='function'){api=window.__paradisVsCodeApi=acquireVsCodeApi();}
var fromHost=${fromHost};
var layer=(${LAYER_BODY})(${scriptJson({ labels, state, kind: 'markdown' })},${PARADIS_DOC_ANCHOR_FUNCTIONS},{
post:function(m){var o={token:T};for(var k in m){if(k!=='token'){o[k]=m[k];}}try{if(api){api.postMessage(o);}}catch(e){}},
doc:function(){return document;},win:function(){return window;},
listen:function(cb){window.addEventListener('message',function(e){if(fromHost(e)){cb(e.data);}});}
});
window.__paradisDocLayerRefresh=layer.refresh;window.__paradisDocLayerSwapped=layer.swapped;
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',layer.start);}else{layer.start();}
window.addEventListener('load',layer.refresh);
}catch(err){console.error('[paradis] doc comment layer failed',err);}})();</script>`;
}

/** 外枠の文書を組み立てる材料。 */
export interface IParadisDocCommentWrapperOptions {
	/** ページの HTML（`<base>` などを差し込んだ後のもの）。 */
	readonly pageHtml: string;
	/** ページ自身のスクリプトを動かすか（信頼したワークスペースだけ）。 */
	readonly allowPageScripts: boolean;
	/** ワークベンチへのメッセージに付ける印。 */
	readonly token: string;
	readonly labels: IParadisDocLayerLabels;
	readonly state: IParadisDocLayerState;
	/** コメントを書けるか（資料でないファイルは外枠だけ使い、選んでも「コメント」を出さない）。 */
	readonly commentable: boolean;
	/** 最初に開いたときに戻すスクロール位置（`scrollY / body.clientHeight`）。 */
	readonly scrollProgress: number;
	/** `fromHost` の判定の関数式（paradisWebviewHostMessage.ts）。 */
	readonly fromHost: string;
}

/**
 * 中の iframe の sandbox。webview の基盤が中身のフレームに付けるもの（pre/index.html）と同じにする。
 * 信頼していないワークスペースでは `allow-scripts` を付けない（ページと子のフレームのスクリプトは動かない）。
 */
export function paradisDocCommentFrameSandbox(allowPageScripts: boolean): string {
	return allowPageScripts ? 'allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms' : 'allow-same-origin allow-pointer-lock';
}

/**
 * 外枠の文書。外枠のスクリプトは、印を閉じた変数に移してから自分の要素を外し、webview の API を先に取り、
 * それから中の iframe を作る（ページが動き出すのはその後）。印はメッセージの object リテラルに書く（ページが
 * 外枠の `Object.prototype` に setter を置いても、代入でなく定義なので呼ばれない）。
 *
 * 外枠には CSP を置かない。`srcdoc` の iframe は親の CSP を受け継ぐので、置くとページの `<style>` やスクリプトまで止まる。
 *
 * 外枠が持ち直すもの: ページの中のリンクのクリック（ワークベンチで開く・ページ内の `#` へ移る）、キー（ワークベンチの
 * ショートカット。webview の基盤と同じく、コピーや検索などのキーはページの既定の動きを止めて渡す）、右クリック
 * （外枠の文書へ同じ位置で出し直し、基盤のメニューを出す）、スクロール位置（知らせと最初の復元）、拡大、検索
 * （基盤が外枠の `window.find`・`getSelection`・`document.execCommand` を呼ぶので、中のページへ向ける）、本文の差し替え
 * （新しい iframe を見えないまま読み込み、読めたら入れ替える）、webview の既定の文字の大きさと色の変数。
 */
export function paradisDocCommentWrapperDocument(options: IParadisDocCommentWrapperOptions): string {
	const config = {
		labels: options.labels,
		state: options.state,
		commentable: options.commentable,
		kind: 'html',
		sandbox: paradisDocCommentFrameSandbox(options.allowPageScripts),
		scroll: options.scrollProgress,
	};
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
#${WRAPPER_STAGE_ID} { position: relative; width: 100%; height: 100%; }
#${WRAPPER_STAGE_ID} > iframe { position: absolute; left: 0; top: 0; width: 100%; height: 100%; border: 0; background: transparent; }
</style>
<script>(function(){try{
var T=${scriptJson(options.token)};
var self=document.currentScript;if(self&&self.parentNode){self.parentNode.removeChild(self);}
var api=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():null;
var send=api?api.postMessage:null;
var fromHost=${options.fromHost};
var O=${scriptJson(config)};
var stage=null,frame=null,pendingFrame=null,listeners=[],layer=null,firstLoad=true;
var nativeFind=window.find,nativeSelection=window.getSelection.bind(window),nativeExec=document.execCommand.bind(document);
function post(m){var o={token:T};for(var k in m){if(k!=='token'){o[k]=m[k];}}try{if(send){send(o);}}catch(e){}}
function idoc(){try{return frame?frame.contentDocument:null;}catch(e){return null;}}
function iwin(){try{return frame?frame.contentWindow:null;}catch(e){return null;}}
// webview の基盤の検索・選択・コピーを中のページへ向ける
window.find=function(){var w=iwin();return w?w.find.apply(w,arguments):false;};
window.getSelection=function(){var w=iwin();return w?w.getSelection():nativeSelection();};
document.execCommand=function(){var d=idoc();return d?d.execCommand.apply(d,arguments):nativeExec.apply(null,arguments);};
// webview の既定の文字の大きさと色の変数を中のページへ写す
function copyVars(){var d=idoc();if(!d||!d.documentElement){return;}var s=document.documentElement.style;for(var i=0;i<s.length;i++){var n=s[i];if(n.indexOf('--')===0){d.documentElement.style.setProperty(n,s.getPropertyValue(n));}}}
try{new MutationObserver(copyVars).observe(document.documentElement,{attributes:true,attributeFilter:['style']});}catch(e){}
var scrollQueued=false;
function onScroll(){if(scrollQueued){return;}scrollQueued=true;requestAnimationFrame(function(){scrollQueued=false;var w=iwin(),d=idoc();if(!w||!d||!d.body||!d.body.clientHeight){return;}post({${LAYER_MESSAGE_KEY}:'scroll',progress:w.scrollY/d.body.clientHeight});});}
function isMeta(e){return e.ctrlKey||e.metaKey;}
function blocked(e){var k=e.keyCode;return isMeta(e)&&[90,89,80,70,83,67,86,88].indexOf(k)!==-1||(e.shiftKey&&k===45);}
function onKey(e){if(!e.isTrusted){return;}if(e.type==='keydown'&&blocked(e)){e.preventDefault();}post({${LAYER_MESSAGE_KEY}:'key',event:{type:e.type,key:e.key,code:e.code,keyCode:e.keyCode,shiftKey:e.shiftKey,altKey:e.altKey,ctrlKey:e.ctrlKey,metaKey:e.metaKey,repeat:e.repeat}});}
function onClick(e){
if(!e.isTrusted||e.defaultPrevented||e.button!==0){return;}
var d=idoc(),w=iwin();if(!d||!w){return;}
var path=e.composedPath?e.composedPath():[];
for(var i=0;i<path.length;i++){var n=path[i];if(n&&n.tagName&&n.tagName.toLowerCase()==='a'&&n.href){
var raw=n.getAttribute('href')||'';
e.preventDefault();
if(raw==='#'){w.scrollTo(0,0);return;}
if(raw.charAt(0)==='#'){var f=raw.slice(1),t=d.getElementById(f);try{t=t||d.getElementById(decodeURIComponent(f));}catch(x){}if(t){t.scrollIntoView();}else if(f.toLowerCase()==='top'){w.scrollTo(0,0);}return;}
post({${LAYER_MESSAGE_KEY}:'link',href:String(n.href.baseVal||n.href)});return;}}
}
function onAux(e){if(e.button!==1){return;}var path=e.composedPath?e.composedPath():[];for(var i=0;i<path.length;i++){var n=path[i];if(n&&n.tagName&&n.tagName.toLowerCase()==='a'&&n.href){e.preventDefault();return;}}}
function onContextMenu(e){if(e.defaultPrevented||!e.isTrusted){return;}e.preventDefault();var r=frame.getBoundingClientRect();try{document.body.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:e.clientX+r.left,clientY:e.clientY+r.top,screenX:e.screenX,screenY:e.screenY}));}catch(x){}}
function bindFrame(){var d=idoc(),w=iwin();if(!d||!w){return;}
w.addEventListener('scroll',onScroll,{passive:true});w.addEventListener('keydown',onKey);w.addEventListener('keyup',onKey);
w.addEventListener('click',onClick);w.addEventListener('auxclick',onAux);w.addEventListener('contextmenu',onContextMenu);}
function makeFrame(html){var f=document.createElement('iframe');f.setAttribute('sandbox',O.sandbox);f.setAttribute('title','');f.style.visibility='hidden';f.srcdoc=html;return f;}
function show(next,old){
var x=0,y=0;
if(old){try{x=old.contentWindow.scrollX;y=old.contentWindow.scrollY;}catch(e){}}
frame=next;copyVars();bindFrame();
var w=iwin(),d=idoc();
try{if(old){w.scrollTo(x,y);}else if(firstLoad&&O.scroll>0&&d&&d.body){w.scrollTo(0,O.scroll*d.body.clientHeight);}}catch(e){}
firstLoad=false;
next.style.visibility='visible';
if(old&&old.parentNode){old.parentNode.removeChild(old);}
if(layer){if(old){layer.swapped();}else{layer.start();}}
}
function load(html){
var old=frame;
if(pendingFrame&&pendingFrame.parentNode){pendingFrame.parentNode.removeChild(pendingFrame);}
var next=makeFrame(html);pendingFrame=next;
next.addEventListener('load',function(){if(pendingFrame!==next){return;}pendingFrame=null;show(next,old);});
stage.appendChild(next);
}
window.addEventListener('message',function(e){
if(!fromHost(e)){return;}var d=e.data;if(!d){return;}
if(typeof d.${ZOOM_MESSAGE_KEY}==='number'){var id=idoc();if(id&&id.documentElement){id.documentElement.style.zoom=String(d.${ZOOM_MESSAGE_KEY});}if(layer){layer.refresh();}return;}
if(typeof d.${BODY_MESSAGE_KEY}==='string'){load(d.${BODY_MESSAGE_KEY});return;}
for(var i=0;i<listeners.length;i++){listeners[i](d);}
});
layer=(${LAYER_BODY})(O,${PARADIS_DOC_ANCHOR_FUNCTIONS},{post:post,doc:idoc,win:iwin,listen:function(cb){listeners.push(cb);}});
function start(){stage=document.getElementById('${WRAPPER_STAGE_ID}');load(${scriptJson(options.pageHtml)});}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',start);}else{start();}
}catch(err){console.error('[paradis] doc comment frame failed',err);}})();</script>
</head>
<body>
<div id="${WRAPPER_STAGE_ID}"></div>
</body>
</html>`;
}
