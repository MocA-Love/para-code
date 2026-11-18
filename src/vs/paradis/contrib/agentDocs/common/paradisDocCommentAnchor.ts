/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメントの位置を「引用（前後の文脈つき）＋セレクタ」で持ち、描き直した後の本文に当て直す。
//
// 当て直しは、本文の文字（空白の連なりを 1 つの空白に均したもの）の上だけで行う純関数。DOM には触らない。
// プレビューのページのスクリプト（paradisDocCommentLayer.ts）が同じ関数を使うので、本体はページに埋められる
// JavaScript の文字列として書き、単体テストはその文字列そのものを動かす（paradisMarkdownCodeCopy.ts と同じ流儀）。
//
// 位置の決め方（{@link IParadisDocAnchorFunctions.resolve}）:
//  1. 引用がそのまま見つかる → 1 か所ならそこ。複数なら、前後の文脈が長く一致するもの、次にセレクタの要素の中のもの。
//     それでも決まらなければ先頭を返し、`ambiguous` を立てる。
//  2. 見つからない → 前の文脈の末尾と後ろの文脈の先頭に挟まれた範囲が、引用と似ていれば（文字の 2 つ組の Dice 係数）
//     そこ（`fuzzy`）。次に、引用の前半・後半・中ほどのどれかが残っていれば、そこから引用の長さぶんを取って似ていればそこ。
//  3. どれも当たらなければ null（位置不明）。
// `locate`・`fragmentToText` は、ソースの断片（Edit の old_string）を描いた後の本文から探す（編集中の印で使う）。
// `diffBlocks` は、描き直しの前後のブロックの文字の並びから変わったブロックを選ぶ（差分の色で使う）。

/** コメントの位置。`quote`・`before`・`after` は空白を均した本文の文字。 */
export interface IParadisDocAnchor {
	/** 引用を含むいちばん内側の要素の CSS セレクタ（当て直しでは同じ文が複数あるときの決め手にだけ使う）。 */
	readonly selector?: string;
	/** 引用の前にある、いちばん近い見出しの文字（エージェントへ場所を伝える材料）。 */
	readonly heading?: string;
	readonly quote: string;
	readonly before?: string;
	readonly after?: string;
}

/** 当て直した結果。`start`・`end` は空白を均した本文の文字の位置。 */
export interface IParadisDocResolved {
	readonly start: number;
	readonly end: number;
	/** `exact`: 引用がそのまま見つかった。`fuzzy`: 引用は書き換わっているが、前後の文脈か残った部分から場所を決めた。 */
	readonly match: 'exact' | 'fuzzy';
	/** 同じ文が複数あり、文脈でもセレクタでも決められなかった（先頭を返している）。 */
	readonly ambiguous?: boolean;
}

/** 書き換え前の文字列（Edit の `old_string`）を本文の中で探した結果。 */
export interface IParadisDocLocated {
	readonly start: number;
	readonly end: number;
	/** `exact`: 記法を外した全体がそのまま見つかった。`partial`: 行ごとに探し、見つかった行の範囲を返した。 */
	readonly match: 'exact' | 'partial';
	readonly matchedLines: number;
	readonly totalLines: number;
}

/** ページに埋める関数の組（{@link PARADIS_DOC_ANCHOR_FUNCTIONS} を評価したもの）の形。 */
export interface IParadisDocAnchorFunctions {
	normalize(text: string): string;
	/** `hint` はセレクタの要素が今の本文で占める範囲（セレクタが当たらなければ渡さない）。 */
	resolve(text: string, anchor: IParadisDocAnchor, hint?: { readonly start: number; readonly end: number }): IParadisDocResolved | null;
	/** ソースの断片（Markdown の記法・HTML のタグ入り）から、描いた後の文字に近いものを作る。 */
	fragmentToText(source: string, kind: 'markdown' | 'html'): string;
	locate(text: string, source: string, kind: 'markdown' | 'html'): IParadisDocLocated | null;
	/**
	 * 前後のブロックの文字の並びを比べ、`next` の中で変わった（足された・書き換わった）ブロックの番号を返す。先頭と末尾の
	 * 同じ並びを外し、残りの中で前に無かった文だけを選ぶ（1 つ足しても後ろを全部変わったことにしない）。`added` は残りの
	 * ブロックの数が増えた（節が足された）。
	 */
	diffBlocks(prev: readonly string[], next: readonly string[]): { readonly changed: number[]; readonly added: boolean };
}

/** 文脈として前後に覚える文字数。 */
export const PARADIS_DOC_CONTEXT_CHARS = 32;

/**
 * 当て直しの関数の組を返す式（ページに埋める JavaScript）。外の変数を読まない。
 */
export const PARADIS_DOC_ANCHOR_FUNCTIONS = `(function () {
	function normalize(s) { return String(s).replace(/\\s+/g, ' '); }
	function bigrams(s) {
		var m = {}, n = 0;
		for (var i = 0; i + 1 < s.length; i++) { var k = s.substr(i, 2); m[k] = (m[k] || 0) + 1; n++; }
		return { m: m, n: n };
	}
	/** 文字の 2 つ組の Dice 係数（0〜1）。 */
	function similarity(a, b) {
		if (a === b) { return 1; }
		if (a.length < 2 || b.length < 2) { return 0; }
		var x = bigrams(a), y = bigrams(b), hit = 0;
		for (var k in x.m) { if (y.m[k]) { hit += Math.min(x.m[k], y.m[k]); } }
		return 2 * hit / (x.n + y.n);
	}
	function resolve(text, a, hint) {
		var q = a && a.quote || '';
		if (!q) { return null; }
		var pre = a.before || '', suf = a.after || '';
		function context(s, e) {
			var p = 0;
			while (p < pre.length && s - 1 - p >= 0 && text.charAt(s - 1 - p) === pre.charAt(pre.length - 1 - p)) { p++; }
			var x = 0;
			while (x < suf.length && e + x < text.length && text.charAt(e + x) === suf.charAt(x)) { x++; }
			return p + x;
		}
		function inHint(s, e) { return !!hint && s >= hint.start && e <= hint.end; }
		var hits = [], i = text.indexOf(q);
		while (i !== -1 && hits.length < 500) { hits.push(i); i = text.indexOf(q, i + 1); }
		if (hits.length === 1) { return { start: hits[0], end: hits[0] + q.length, match: 'exact' }; }
		if (hits.length > 1) {
			var best = -1, bestScore = -1, tie = false;
			for (var h = 0; h < hits.length; h++) {
				var score = context(hits[h], hits[h] + q.length) * 2 + (inHint(hits[h], hits[h] + q.length) ? 1 : 0);
				if (score > bestScore) { bestScore = score; best = h; tie = false; } else if (score === bestScore) { tie = true; }
			}
			var r = { start: hits[best], end: hits[best] + q.length, match: 'exact' };
			if (tie) { r.ambiguous = true; }
			return r;
		}
		// 引用は書き換わっている。前後の文脈に挟まれた範囲を見る
		var MIN = 6, TAIL = 16, found = null, foundScore = 0;
		function consider(s, e, floor) {
			if (e <= s || s < 0 || e > text.length) { return; }
			var sim = similarity(text.slice(s, e), q) + (inHint(s, e) ? 0.05 : 0);
			if (sim >= floor && sim > foundScore) { foundScore = sim; found = { start: s, end: e, match: 'fuzzy' }; }
		}
		var pt = pre.slice(-TAIL), sh = suf.slice(0, TAIL);
		var limit = Math.max(q.length * 2, q.length + 80);
		if (pt.length >= MIN && sh.length >= MIN) {
			var p0 = text.indexOf(pt), guard = 0;
			while (p0 !== -1 && guard++ < 200) {
				var s0 = p0 + pt.length, e0 = text.indexOf(sh, s0);
				if (e0 !== -1 && e0 - s0 <= limit) { consider(s0, e0, 0.3); }
				p0 = text.indexOf(pt, p0 + 1);
			}
		}
		if (found) { return found; }
		// 引用の残った部分（前半・後半・中ほど）から場所を決める
		var half = Math.floor(q.length / 2), third = Math.floor(q.length / 3);
		var parts = [[0, half], [half, q.length], [third, q.length - third]];
		for (var k = 0; k < parts.length; k++) {
			var part = q.slice(parts[k][0], parts[k][1]);
			if (part.length < MIN) { continue; }
			var at = text.indexOf(part), guard2 = 0;
			while (at !== -1 && guard2++ < 200) {
				var s1 = Math.max(0, at - parts[k][0]);
				consider(s1, Math.min(text.length, s1 + q.length), 0.6);
				at = text.indexOf(part, at + 1);
			}
		}
		return found;
	}
	var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
	/** 文の途中に置くタグ。外しても前後の文字はつながったまま（それ以外のタグは区切りとして空白にする）。 */
	var INLINE_TAG = /<\\/?(?:a|abbr|b|code|del|em|i|ins|kbd|mark|s|small|span|strong|sub|sup|u)(?:\\s[^<>]*)?>/gi;
	function stripHtml(s) {
		return s.replace(/<(script|style)[\\s\\S]*?<\\/\\1\\s*>/gi, ' ')
			.replace(/<!--[\\s\\S]*?-->/g, ' ')
			.replace(INLINE_TAG, '')
			.replace(/<\\/?[a-zA-Z][^<>]*>/g, ' ')
			.replace(/<\\/?[a-zA-Z][^<>]*$/, ' ')
			.replace(/^[^<>]*"\\s*>/, ' ')
			.replace(/&#(\\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
			.replace(/&([a-z]+);/g, function (m, n) { return ENTITIES[n] !== undefined ? ENTITIES[n] : m; });
	}
	function stripMarkdownLine(line) {
		if (/^\\s*(\`\`\`|~~~)/.test(line)) { return ''; }
		if (/^\\s*\\|?\\s*:?-{2,}[-:| ]*$/.test(line)) { return ''; }
		return stripHtml(line)
			.replace(/^\\s{0,3}#{1,6}\\s+/, '')
			.replace(/^\\s*>+\\s?/, '')
			.replace(/^\\s*(?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX]\\]\\s+)?/, '')
			.replace(/!\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1')
			.replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1')
			.replace(/(\\*\\*|__|~~|\\*|\`)/g, '')
			.replace(/\\|/g, ' ');
	}
	function fragmentToText(source, kind) {
		var s = String(source);
		if (kind === 'html') { return normalize(stripHtml(s)).trim(); }
		var lines = s.split(/\\r?\\n/), out = [];
		for (var i = 0; i < lines.length; i++) { out.push(stripMarkdownLine(lines[i])); }
		return normalize(out.join(' ')).trim();
	}
	function locate(text, source, kind) {
		var whole = fragmentToText(source, kind);
		var lines = String(source).split(/\\r?\\n/), texts = [];
		for (var i = 0; i < lines.length; i++) { var t = fragmentToText(lines[i], kind); if (t.length >= 2) { texts.push(t); } }
		if (whole) {
			var at = text.indexOf(whole);
			if (at !== -1) { return { start: at, end: at + whole.length, match: 'exact', matchedLines: texts.length, totalLines: texts.length }; }
		}
		var start = -1, end = -1, from = 0, matched = 0;
		for (var j = 0; j < texts.length; j++) {
			var p = text.indexOf(texts[j], from);
			if (p === -1) { continue; }
			if (start === -1) { start = p; }
			end = p + texts[j].length; from = end; matched++;
		}
		if (start === -1) { return null; }
		return { start: start, end: end, match: 'partial', matchedLines: matched, totalLines: texts.length };
	}
	function diffBlocks(prev, next) {
		var a = 0, m = prev.length, n = next.length;
		while (a < m && a < n && prev[a] === next[a]) { a++; }
		var b = 0;
		while (b < m - a && b < n - a && prev[m - 1 - b] === next[n - 1 - b]) { b++; }
		var old = Object.create(null), changed = [];
		for (var i = a; i < m - b; i++) { old[prev[i]] = (old[prev[i]] || 0) + 1; }
		for (var j = a; j < n - b; j++) {
			if (old[next[j]]) { old[next[j]]--; } else { changed.push(j); }
		}
		return { changed: changed, added: (n - b - a) > (m - b - a) };
	}
	return { normalize: normalize, resolve: resolve, fragmentToText: fragmentToText, locate: locate, similarity: similarity, diffBlocks: diffBlocks };
})()`;

/**
 * 選んだ範囲（空白を均した本文の `start`〜`end`）から位置を作る。ページのスクリプトも同じ作り方をする
 * （前後 {@link PARADIS_DOC_CONTEXT_CHARS} 文字を文脈として覚える）。
 */
export function paradisCreateDocAnchor(text: string, start: number, end: number, selector?: string): IParadisDocAnchor {
	return {
		...(selector !== undefined ? { selector } : {}),
		quote: text.slice(start, end),
		before: text.slice(Math.max(0, start - PARADIS_DOC_CONTEXT_CHARS), start),
		after: text.slice(end, end + PARADIS_DOC_CONTEXT_CHARS),
	};
}
