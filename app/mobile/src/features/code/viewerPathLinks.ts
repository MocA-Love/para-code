// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { parseLocalFileTarget, type LocalFileTarget } from '../../localFileTarget.js';
import { findTerminalLinks } from '../../terminalLinks.js';

/**
 * ファイルビューアの Markdown・HTML のプレビューの中に書かれたファイルのパスを、押して開ける・長押しでコピーできる
 * ようにする（React に依存しない純関数。`viewerPathLinks.test.ts` で固定している。画面は `useViewerPathLinks.tsx`）。
 *
 * 流れはファイル内の検索（`fileFind.ts`）と同じく、WebView へ `injectJavaScript` で小さなスクリプトを流し、結果を
 * `postMessage` で受ける。
 *  1. 読み込み終わりに {@link buildPathLinkCollectScript} が候補を集めて送る（`a[href]`、`pre` の外の `code`、地の文）
 *  2. パスかどうかはアプリが決める（{@link pathLinksOf}。ターミナルのタップと同じ規則 `findTerminalLinks`）
 *  3. 当たったものだけに {@link buildPathLinkMarkScript} が印を付け、押す・長押しを送り返させる
 *
 * HTML のプレビューではページ自身のスクリプトも動き、`token` も読める（誤認を防ぐ印で、秘密ではない）。ページが偽の
 * 「押した」を送っても、届いた番号は 2 で決めた候補の中だけに限り、開けるのはスペースの中のファイルだけ（PC が確かめる）。
 */

/** postMessage の `type`。 */
const MESSAGE_TYPE = 'paradisPathLinks';

/** 集める候補の上限（重いページで固まらないように）。 */
export const PATH_LINK_LIMITS = {
	/** 候補の数（要素と文字のノードを合わせて）。 */
	candidates: 2_000,
	/** 候補の文字の合計。 */
	chars: 200_000,
	/** 1 つの候補の文字数（これより長い文字のノードは先頭だけを見る）。 */
	candidateChars: 4_000,
	/** 印を付ける数。 */
	marks: 500,
} as const;

/** 候補の種類。`a` はリンクの行き先（href）、`code` は `pre` の外の `code` の文字、`text` は地の文の文字のノード。 */
export type PathLinkSource = 'a' | 'code' | 'text';

/** スクリプトが集めた候補（`i` は集めた順の番号）。 */
export interface PathLinkCandidate {
	readonly i: number;
	readonly k: PathLinkSource;
	readonly t: string;
}

/** 印を付ける場所。`s`・`e` は地の文の中の範囲（要素の候補では付けない）。`id` は {@link ViewerPathLink} の番号。 */
export interface PathLinkMark {
	readonly i: number;
	readonly id: number;
	readonly s?: number;
	readonly e?: number;
}

/** 見つけたパス。`written` は書いてあったままの文字（行番号付きのことがある）。 */
export interface ViewerPathLink {
	readonly source: PathLinkSource;
	readonly written: string;
	readonly target: LocalFileTarget;
}

/** WebView から届いたメッセージ。 */
export type PathLinkMessage =
	| { readonly op: 'candidates'; readonly items: readonly PathLinkCandidate[] }
	| { readonly op: 'tap'; readonly id: number }
	| { readonly op: 'hold'; readonly id: number };

function scriptJson(value: unknown): string {
	// `</script>` などを文字列のまま閉じさせないよう、`<` はエスケープして埋め込む（`buildFindScript` と同じ）。
	return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * 候補を集めて送るスクリプト。読み込み終わりのたびに流してよい（同じページで 2 回目は何もしない）。
 * 地の文は `/` を含む文字のノードだけ。`pre`・`script`・`style`・リンク・`code`・入力欄の中は見ない。
 */
export function buildPathLinkCollectScript(token: string): string {
	const config = { token, type: MESSAGE_TYPE, limits: PATH_LINK_LIMITS };
	return `(function () {
	var cfg = ${scriptJson(config)};
	if (!document.body || (window.__paradisPathLinks && window.__paradisPathLinks.token === cfg.token)) { return; }
	var state = { token: cfg.token, nodes: [] };
	window.__paradisPathLinks = state;
	var items = [];
	var chars = 0;
	function add(kind, node, text) {
		if (items.length >= cfg.limits.candidates || chars >= cfg.limits.chars || !text) { return false; }
		text = String(text).slice(0, cfg.limits.candidateChars);
		chars += text.length;
		items.push({ i: state.nodes.length, k: kind, t: text });
		state.nodes.push(node);
		return true;
	}
	var anchors = document.querySelectorAll('a[href]');
	for (var a = 0; a < anchors.length; a++) {
		add('a', anchors[a], anchors[a].getAttribute('href'));
	}
	var codes = document.querySelectorAll('code');
	for (var c = 0; c < codes.length; c++) {
		if (!codes[c].closest('pre,a')) { add('code', codes[c], codes[c].textContent); }
	}
	var SKIP = 'pre,a,code,script,style,textarea,input,select,noscript,template,svg,math,[contenteditable]';
	var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
		acceptNode: function (node) {
			var value = node.nodeValue;
			if (!value || value.indexOf('/') < 0) { return NodeFilter.FILTER_REJECT; }
			var parent = node.parentElement;
			return parent && !parent.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		}
	});
	var node;
	while ((node = walker.nextNode())) {
		if (!add('text', node, node.nodeValue)) { break; }
	}
	try {
		window.ReactNativeWebView.postMessage(JSON.stringify({ type: cfg.type, token: cfg.token, op: 'candidates', items: items }));
	} catch (e) { }
})();
true;`;
}

/**
 * 印を付け、押す・長押しを送らせるスクリプト。`color` は地の文と `code` の印の色（リンクは元の色のまま）。
 * スタイルは要素の `style` へ直接書く（ページの CSP が `<style>` を止めても効くように）。
 */
export function buildPathLinkMarkScript(token: string, marks: readonly PathLinkMark[], color: string): string {
	const config = { token, type: MESSAGE_TYPE, marks, color };
	return `(function () {
	var cfg = ${scriptJson(config)};
	var state = window.__paradisPathLinks;
	if (!state || state.token !== cfg.token || state.marked) { return; }
	state.marked = true;
	function style(el, colored) {
		el.setAttribute('data-paradis-path', '');
		el.style.textDecorationLine = 'underline';
		el.style.textDecorationStyle = 'dotted';
		el.style.textUnderlineOffset = '3px';
		el.style.webkitTouchCallout = 'none';
		el.style.webkitUserSelect = 'none';
		el.style.cursor = 'pointer';
		if (colored) { el.style.color = cfg.color; }
	}
	// 同じ文字のノードの範囲は後ろから包む（前を包むと後ろの位置がずれるため）
	var sorted = cfg.marks.slice().sort(function (x, y) { return x.i - y.i || (y.s || 0) - (x.s || 0); });
	for (var m = 0; m < sorted.length; m++) {
		var mark = sorted[m];
		var node = state.nodes[mark.i];
		if (!node) { continue; }
		if (node.nodeType === 1) {
			node.setAttribute('data-paradis-path-id', String(mark.id));
			style(node, node.tagName !== 'A');
			continue;
		}
		if (node.nodeType !== 3 || typeof mark.s !== 'number' || typeof mark.e !== 'number' || mark.e > node.nodeValue.length) { continue; }
		var tail = node.splitText(mark.s);
		tail.splitText(mark.e - mark.s);
		var span = document.createElement('span');
		span.setAttribute('data-paradis-path-id', String(mark.id));
		style(span, true);
		tail.parentNode.insertBefore(span, tail);
		span.appendChild(tail);
	}
	function post(op, id) {
		try {
			window.ReactNativeWebView.postMessage(JSON.stringify({ type: cfg.type, token: cfg.token, op: op, id: id }));
		} catch (e) { }
	}
	function idOf(target) {
		var el = target && target.nodeType === 1 ? target : target && target.parentElement;
		var hit = el && el.closest('[data-paradis-path-id]');
		return hit ? Number(hit.getAttribute('data-paradis-path-id')) : -1;
	}
	var timer = 0;
	var start = null;
	var held = 0;
	function cancel() { if (timer) { clearTimeout(timer); timer = 0; } }
	document.addEventListener('touchstart', function (event) {
		cancel();
		var id = idOf(event.target);
		if (id < 0 || event.touches.length !== 1) { return; }
		start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
		timer = setTimeout(function () { timer = 0; held = Date.now(); post('hold', id); }, 450);
	}, { capture: true, passive: true });
	document.addEventListener('touchmove', function (event) {
		if (!timer || !start || event.touches.length !== 1) { cancel(); return; }
		var dx = event.touches[0].clientX - start.x;
		var dy = event.touches[0].clientY - start.y;
		if (dx * dx + dy * dy > 100) { cancel(); }
	}, { capture: true, passive: true });
	document.addEventListener('touchend', cancel, { capture: true, passive: true });
	document.addEventListener('touchcancel', cancel, { capture: true, passive: true });
	document.addEventListener('click', function (event) {
		var id = idOf(event.target);
		if (id < 0) { return; }
		event.preventDefault();
		event.stopPropagation();
		// 長押しの指を離したときの click は開かない（メニューを出したので）
		if (held && Date.now() - held < 1500) { held = 0; return; }
		post('tap', id);
	}, true);
})();
true;`;
}

/** WebView から届いた文字を読む。形・`type`・`token` が合わなければ undefined。 */
export function parsePathLinkMessage(data: string, token: string): PathLinkMessage | undefined {
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
	if (candidate.type !== MESSAGE_TYPE || candidate.token !== token) {
		return undefined;
	}
	if (candidate.op === 'tap' || candidate.op === 'hold') {
		const id = candidate.id;
		return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && id < PATH_LINK_LIMITS.marks ? { op: candidate.op, id } : undefined;
	}
	if (candidate.op !== 'candidates' || !Array.isArray(candidate.items)) {
		return undefined;
	}
	const items: PathLinkCandidate[] = [];
	for (const raw of candidate.items.slice(0, PATH_LINK_LIMITS.candidates)) {
		if (raw === null || typeof raw !== 'object') {
			continue;
		}
		const { i, k, t } = raw as Record<string, unknown>;
		if (typeof i === 'number' && Number.isSafeInteger(i) && i >= 0 && (k === 'a' || k === 'code' || k === 'text') && typeof t === 'string') {
			items.push({ i, k, t: t.slice(0, PATH_LINK_LIMITS.candidateChars) });
		}
	}
	return { op: 'candidates', items };
}

/** 書いてあるパスの本体（行番号を除く）。 */
function barePath(target: LocalFileTarget): string {
	return target.path;
}

/**
 * 地の文で拾ってよいパスか。誤検出を減らすため、`/` を含んで拡張子で終わるもの（`src/app.ts`）か、
 * `/`・`~/` で始まる絶対パス（`/var/log/app`・`~/notes/todo.md`）だけにする。`and/or` のような単語の組は外す。
 */
export function isProsePath(path: string): boolean {
	if (!path.includes('/')) {
		return false;
	}
	if (/^(?:\/|~\/)[A-Za-z0-9._@+-]/.test(path)) {
		return true;
	}
	return /\/[^/]*[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]*$/.test(path);
}

/** `code` の文字の全体が 1 つのパスか（`src/a.ts:12` は通し、`npm run build` や `a/b c` は外す）。 */
function wholeTextPath(text: string): LocalFileTarget | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0 || /\s/.test(trimmed)) {
		return undefined;
	}
	const links = findTerminalLinks(trimmed);
	const [only] = links;
	return links.length === 1 && only !== undefined && only.kind === 'file' && only.start === 0 && only.end === trimmed.length ? only.target : undefined;
}

/**
 * 集めた候補のうちパスのものと、その印の場所。印は {@link PATH_LINK_LIMITS.marks} 個まで。
 * - `a`: href が http(s)・`#`・`?`・`mailto:` などでなく、ファイルの行き先として読めるもの（`parseLocalFileTarget`）
 * - `code`: 文字の全体が 1 つのパスのもの
 * - `text`: 地の文の中の、{@link isProsePath} を満たすパス（URL の一部は `findTerminalLinks` が外す）
 */
export function pathLinksOf(candidates: readonly PathLinkCandidate[]): { readonly links: readonly ViewerPathLink[]; readonly marks: readonly PathLinkMark[] } {
	const links: ViewerPathLink[] = [];
	const marks: PathLinkMark[] = [];
	const push = (candidate: PathLinkCandidate, written: string, target: LocalFileTarget, range?: { start: number; end: number }) => {
		const id = links.length;
		links.push({ source: candidate.k, written, target });
		marks.push({ i: candidate.i, id, ...(range !== undefined ? { s: range.start, e: range.end } : {}) });
	};
	for (const candidate of candidates) {
		if (links.length >= PATH_LINK_LIMITS.marks) {
			break;
		}
		if (candidate.k === 'a') {
			// 空と、問い合わせだけの href（`?tab=2`。ページ自身の動き）は外す
			const target = /^\s*(?:\?|$)/.test(candidate.t) ? undefined : parseLocalFileTarget(candidate.t);
			if (target !== undefined) {
				push(candidate, candidate.t.trim(), target);
			}
			continue;
		}
		if (candidate.k === 'code') {
			const target = wholeTextPath(candidate.t);
			if (target !== undefined) {
				push(candidate, candidate.t.trim(), target);
			}
			continue;
		}
		for (const link of findTerminalLinks(candidate.t)) {
			if (links.length >= PATH_LINK_LIMITS.marks) {
				break;
			}
			if (link.kind === 'file' && isProsePath(barePath(link.target))) {
				push(candidate, candidate.t.slice(link.start, link.end), link.target, link);
			}
		}
	}
	return { links, marks };
}

/** ホームからのパス（`~/…`）か。スペースの外なので開かない。 */
export function isHomePath(path: string): boolean {
	return /^~[\\/]/.test(path);
}

/** スペースの根からの相対パスの `..`・`.` を畳む。根より上へ出るなら undefined。 */
function normalizeRelative(path: string): string | undefined {
	const segments: string[] = [];
	for (const segment of path.replace(/\\/g, '/').split('/')) {
		if (segment.length === 0 || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length === 0) {
				return undefined;
			}
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return segments.length > 0 ? segments.join('/') : undefined;
}

/**
 * PC に解決を頼む順番（スペースの根からの相対パスか、書いてあるままの絶対パス）。
 * リンク（`a`）は文書のフォルダからの相対を先に（Markdown・HTML の決まり）、`code` と地の文はスペースの根からを先に
 * （エージェントはリポジトリの根からのパスを書くことが多い）試す。`~/` は開かないので空。
 */
export function pathLinkResolveOrder(viewerPath: string, link: Pick<ViewerPathLink, 'source' | 'target'>): readonly string[] {
	const path = link.target.path;
	if (isHomePath(path)) {
		return [];
	}
	if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
		return [path];
	}
	const slash = viewerPath.lastIndexOf('/');
	const folder = slash >= 0 ? viewerPath.slice(0, slash) : '';
	const fromFolder = normalizeRelative(folder.length > 0 ? `${folder}/${path}` : path);
	const fromRoot = normalizeRelative(path);
	const order = link.source === 'a' ? [fromFolder, fromRoot] : [fromRoot, fromFolder];
	return order.filter((candidate, index): candidate is string => candidate !== undefined && order.indexOf(candidate) === index);
}

/** 開けなかった理由。PC の断りの文（`paradisMobileWorkspaceProvider.ts` の resolveLink）から読む。 */
export type PathLinkFailure = 'outside' | 'missing';

export function pathLinkFailureOf(message: string): PathLinkFailure {
	return /outside the workspace/i.test(message) ? 'outside' : 'missing';
}

/** 開けなかったときに見せる文。 */
export function pathLinkFailureText(failure: PathLinkFailure): string {
	return failure === 'outside' ? 'スペースの外のファイルは開けません' : 'スペースの中にこのファイルが見つかりません';
}
