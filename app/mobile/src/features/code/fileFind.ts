// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { stepIndex } from '../../ipad/shortcuts.js';
import type { ViewerKind, ViewerMode } from './fileViewerModel.js';

/**
 * ファイルビューアの中の検索（モックの項目 3）。React に依存しない純関数で、`fileFind.test.ts` で固定している。
 *
 * 検索は WebView の中で動かす小さなスクリプト（{@link buildFindScript}）がする。アプリはそれを
 * `injectJavaScript` で流し込み、スクリプトは件数と今の位置を `postMessage` で返す。
 *  - 文字のノードを順にたどってつなげた文字列から探し、一致した部分を `mark` で包む（DOM は作り替えない。
 *    トークンの span をまたぐ一致も、またいだ分だけ別の `mark` で包む）
 *  - 大文字と小文字は区別しない。改行をまたぐ一致は探さない（ブロックの境目に改行を挟んでつなぐ）
 *  - 全一致を淡い琥珀、今の一致を琥珀の地に黒文字にし、今の一致を画面の中央へ送る
 *
 * HTML のプレビューではページ自身のスクリプトも動くので、届いたメッセージは種類・形・`token`・世代（`seq`）を
 * 確かめ、件数の表示より強いことには使わない（{@link parseFindMessage}）。`token` はページの別のメッセージを検索の結果と
 * 取り違えないための印（誤認防止）で、秘密ではない（同じページの中のスクリプトは読める前提）。
 */

/** WebView の中で探す範囲。 */
export interface FindTarget {
	/** 探す根（無ければ body）。 */
	readonly root?: string;
	/** 探さない要素（コードの行番号など）。 */
	readonly exclude?: string;
	/** これがあるうちは描画の途中なので、消えてから探す（Word の「レンダリング中…」）。 */
	readonly waitFor?: string;
}

/**
 * その表示の中を探せるか（探せるならどこを探すか）。画像・動画・音声・PDF は探せない
 * （PDF は WKWebView のネイティブ表示で、中の文字を JS から読めない）。
 */
export function findTargetOf(kind: ViewerKind, mode: ViewerMode): FindTarget | undefined {
	switch (kind) {
		case 'pdf':
		case 'image':
		case 'av':
		case 'unsupported':
			return undefined;
		case 'spreadsheet':
			return {};
		case 'docx':
			return { root: '#content', waitFor: '#status' };
		case 'markdown':
		case 'html':
			if (mode === 'render') {
				return {};
			}
			return CODE_TARGET;
		default:
			return CODE_TARGET;
	}
}

/** コードの表示（`buildCodeHtml`）。行番号（`.l > i`）は探さない。 */
const CODE_TARGET: FindTarget = { root: '.src', exclude: '.l > i' };

/** WebView へ送る操作。`search` は探し直し、`select` は今の一致の付け替え、`clear` は印を外す。 */
export type FindCommand =
	| { readonly op: 'search'; readonly query: string; readonly index: number }
	| { readonly op: 'select'; readonly index: number }
	| { readonly op: 'clear' };

/** 一度に印を付ける一致の上限（長いファイルで DOM を膨らませすぎない）。 */
export const FIND_MATCH_LIMIT = 1000;

/** 強調の色（モックの値）。 */
export const FIND_COLORS = {
	match: 'rgba(245,158,11,0.32)',
	current: '#f59e0b',
	currentText: '#000',
} as const;

/** 検索欄の中身を探す語にする（改行は空白へ。前後の空白は落とさない＝空白そのものも探せる）。 */
export function normalizeFindQuery(raw: string): string {
	return raw.replace(/[\r\n]+/g, ' ');
}

/**
 * WebView に流し込むスクリプト。何度流しても同じ状態に収まる（前の印を外してから付ける）。
 * `token` は検索の結果を他のメッセージと取り違えないための印（誤認防止。秘密ではない）、`seq` は送った順の番号（古い結果を捨てるため）。
 */
export function buildFindScript(command: FindCommand, options: { readonly token: string; readonly seq: number; readonly target: FindTarget }): string {
	const config = {
		token: options.token,
		seq: options.seq,
		command,
		root: options.target.root ?? null,
		exclude: options.target.exclude ?? null,
		waitFor: options.target.waitFor ?? null,
		limit: FIND_MATCH_LIMIT,
		colors: FIND_COLORS,
	};
	// `</script>` などを文字列のまま閉じさせないよう、`<` はエスケープして埋め込む。
	const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
	return `(function () {
	var cfg = ${json};
	var KEY = '__paradisFind';
	window.__paradisFindSeq = cfg.seq;
	var BLOCK = 'p,div,li,td,th,h1,h2,h3,h4,h5,h6,pre,tr,section,article,blockquote,dt,dd,caption,figcaption,header,footer,table';
	function post(count, index, capped) {
		try {
			window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'paradisFind', token: cfg.token, seq: cfg.seq, count: count, index: index, capped: capped }));
		} catch (e) { }
	}
	function state() { return window[KEY] || (window[KEY] = { groups: [], index: -1 }); }
	function paint(group, current) {
		for (var i = 0; i < group.length; i++) {
			group[i].style.backgroundColor = current ? cfg.colors.current : cfg.colors.match;
			group[i].style.color = current ? cfg.colors.currentText : 'inherit';
		}
	}
	function clear() {
		var s = state();
		var parents = [];
		for (var g = 0; g < s.groups.length; g++) {
			for (var i = 0; i < s.groups[g].length; i++) {
				var m = s.groups[g][i];
				var p = m.parentNode;
				if (!p) { continue; }
				while (m.firstChild) { p.insertBefore(m.firstChild, m); }
				p.removeChild(m);
				parents.push(p);
			}
		}
		for (var j = 0; j < parents.length; j++) { try { parents[j].normalize(); } catch (e) { } }
		s.groups = [];
		s.index = -1;
	}
	function lowerOf(text) {
		return text.replace(/[\\s\\S]/g, function (c) { var l = c.toLowerCase(); return l.length === 1 ? l : c; });
	}
	function search(query) {
		clear();
		var s = state();
		if (!query) { return; }
		var root = (cfg.root && document.querySelector(cfg.root)) || document.body;
		if (!root) { return; }
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: function (n) {
				var p = n.parentElement;
				if (!p || !n.nodeValue) { return NodeFilter.FILTER_REJECT; }
				var tag = p.tagName;
				if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'TITLE') { return NodeFilter.FILTER_REJECT; }
				if (cfg.exclude && p.closest(cfg.exclude)) { return NodeFilter.FILTER_REJECT; }
				return NodeFilter.FILTER_ACCEPT;
			}
		});
		var nodes = [], starts = [], text = '', lastBlock = null, n;
		while ((n = walker.nextNode())) {
			var block = n.parentElement.closest(BLOCK);
			if (nodes.length > 0 && block !== lastBlock) { text += '\\n'; }
			lastBlock = block;
			starts.push(text.length);
			nodes.push(n);
			text += n.nodeValue;
		}
		var hay = lowerOf(text), needle = lowerOf(query);
		var segments = [];
		var count = 0, from = 0, at, k = 0;
		while (count < cfg.limit && (at = hay.indexOf(needle, from)) >= 0) {
			var end = at + needle.length;
			while (k + 1 < nodes.length && starts[k + 1] <= at) { k++; }
			for (var i = k; i < nodes.length && starts[i] < end; i++) {
				var a = Math.max(at, starts[i]) - starts[i];
				var b = Math.min(end, starts[i] + nodes[i].nodeValue.length) - starts[i];
				if (b > a) { segments.push({ node: i, start: a, end: b, match: count }); }
			}
			count++;
			from = end;
		}
		s.capped = count >= cfg.limit && hay.indexOf(needle, from) >= 0;
		var groups = [];
		for (var c = 0; c < count; c++) { groups.push([]); }
		// 同じノードの中は後ろから包む（前の位置がずれないように）。
		for (var x = segments.length - 1; x >= 0; x--) {
			var seg = segments[x];
			var node = nodes[seg.node];
			if (seg.end < node.nodeValue.length) { node.splitText(seg.end); }
			var mid = seg.start > 0 ? node.splitText(seg.start) : node;
			var mark = document.createElement('mark');
			mark.setAttribute('data-paradis-find', String(seg.match));
			mark.style.borderRadius = '2px';
			mark.style.padding = '0';
			mid.parentNode.insertBefore(mark, mid);
			mark.appendChild(mid);
			groups[seg.match].unshift(mark);
			paint([mark], false);
		}
		s.groups = groups;
	}
	function select(index) {
		var s = state();
		var count = s.groups.length;
		if (count === 0) { s.index = -1; post(0, -1, false); return; }
		var next = ((index % count) + count) % count;
		if (s.index >= 0 && s.index < count) { paint(s.groups[s.index], false); }
		s.index = next;
		paint(s.groups[next], true);
		var first = s.groups[next][0];
		if (first && first.scrollIntoView) { first.scrollIntoView({ block: 'center', inline: 'nearest' }); }
		post(count, next, !!s.capped);
	}
	function run() {
		if (window.__paradisFindSeq !== cfg.seq) { return; }
		var command = cfg.command;
		if (command.op === 'clear') { clear(); post(0, -1, false); return; }
		if (command.op === 'search') { search(command.query); }
		select(command.index);
	}
	if (cfg.command.op === 'search' && cfg.waitFor && document.querySelector(cfg.waitFor)) {
		var done = false;
		var finish = function () { if (done) { return; } done = true; observer.disconnect(); run(); };
		var observer = new MutationObserver(function () { if (!document.querySelector(cfg.waitFor)) { finish(); } });
		observer.observe(document.documentElement, { childList: true, subtree: true });
		setTimeout(finish, 15000);
	} else {
		run();
	}
	true;
})();`;
}

/** WebView から届いた検索の結果。 */
export interface FindResult {
	readonly seq: number;
	/** 一致の数（上限で打ち切っていれば上限の数）。 */
	readonly count: number;
	/** 今の一致（0 始まり。一致が無ければ -1）。 */
	readonly index: number;
	/** 上限で打ち切った。 */
	readonly capped: boolean;
}

/**
 * WebView の `onMessage` の中身を読む。検索の結果でない・形が違う・`token` が違うものは undefined
 * （HTML のページ自身が送ったメッセージや、ページが真似た偽のメッセージを件数として出さない）。
 */
export function parseFindMessage(data: string, token: string): FindResult | undefined {
	let message: unknown;
	try {
		message = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (message === null || typeof message !== 'object' || Array.isArray(message)) {
		return undefined;
	}
	const candidate = message as Record<string, unknown>;
	const { seq, count, index, capped } = candidate;
	if (candidate.type !== 'paradisFind' || candidate.token !== token
		|| typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0
		|| typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > FIND_MATCH_LIMIT
		|| typeof index !== 'number' || !Number.isSafeInteger(index) || index < -1 || index >= Math.max(count, 1)
		|| (count === 0 && index !== -1) || (count > 0 && index < 0)
		|| typeof capped !== 'boolean') {
		return undefined;
	}
	return { seq, count, index, capped };
}

/** 前後の一致へ動いた位置（端では反対の端へ回る）。一致が無ければ -1。 */
export function stepFindIndex(result: FindResult | undefined, delta: 1 | -1): number {
	return result === undefined ? -1 : stepIndex(result.index, result.count, delta);
}

/** 欄の右の件数（「2 / 5」）。探していない・結果待ちなら空、一致が無ければ「0 件」。 */
export function findCountLabel(query: string, result: FindResult | undefined): string {
	if (query.length === 0 || result === undefined) {
		return '';
	}
	if (result.count === 0) {
		return '0 件';
	}
	return `${result.index + 1} / ${result.count}${result.capped ? '+' : ''}`;
}

/**
 * コードと Markdown の表示に当てる CSP（自分のスクリプトだけを動かす）。
 *
 * Markdown は marked が生の HTML をそのまま通すので、本文に `<script>` や `onerror=` やフレームが混ざりうる。
 * 検索のためにスクリプトを有効にしても、それらは nonce を持たないので動かない。`injectJavaScript` で流す検索の
 * スクリプトはネイティブ側からの注入なので、この CSP に止められない（Office の WebView の probe と同じ）。
 * 画像などの読み込みは今までどおり許す（`default-src` は絞らない）。
 */
export function viewerScriptContentSecurityPolicy(nonce: string): string {
	if (!/^[A-Za-z\d_-]{16,128}$/.test(nonce)) {
		throw new TypeError('Invalid viewer CSP nonce');
	}
	return `script-src 'nonce-${nonce}'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
}

/** {@link viewerScriptContentSecurityPolicy} を `<head>` の先頭に置く meta 要素。 */
export function viewerScriptCspMeta(nonce: string): string {
	return `<meta http-equiv="Content-Security-Policy" content="${viewerScriptContentSecurityPolicy(nonce)}">`;
}
