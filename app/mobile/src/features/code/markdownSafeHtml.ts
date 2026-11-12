// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Marked, type Tokens } from 'marked';
import { viewerScriptContentSecurityPolicy } from './fileFind.js';

/**
 * ファイルのビューアの Markdown を HTML にする（React に依存しない純関数。`markdownSafeHtml.test.ts` で固定している）。
 *
 * marked は本文に書かれた生の HTML をそのまま通すので、ワークスペースの Markdown の `<iframe>`・`<form>`・
 * `<img src="https://…">` が、開いただけで外へリクエストを出していた。ここでは許可リストで絞る。
 *  - 生の HTML は、許可したタグと属性だけを残す。ほかのタグは外し（中の文字は残す）、`<script>`・`<style>`・
 *    `<iframe>` のように中身が文字でないものは中身ごと落とす
 *  - 外の画像（`http(s):`・`//`）は描かず、代わりの文字（alt）を出す。`![](…)` の画像も同じ
 *  - 念のため CSP でも外の画像・フレーム・フォームの送り先を止める（{@link markdownContentSecurityPolicy}）
 *
 * DOM の無い React Native の側で組むので、DOMPurify は使えない。完全な HTML のパーサーではないので、CSP と
 * 遷移のガード（`webViewLinkGuard.ts`）と合わせて守る。
 */

/** 残すタグ。属性は {@link GLOBAL_ATTRIBUTES} と {@link TAG_ATTRIBUTES} だけ。 */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
	'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
	'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small',
	'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
	'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);

/** 中身が文字ではない（中身ごと落とす）タグ。 */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
	'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed', 'noframes',
	'template', 'textarea', 'select', 'title', 'xmp', 'svg', 'math', 'audio', 'video',
]);

/** どのタグにも残す属性。 */
const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set(['align', 'title', 'lang', 'dir']);

/** タグごとに残す属性。 */
const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
	a: new Set(['href']),
	img: new Set(['src', 'alt', 'width', 'height']),
	ol: new Set(['start', 'type', 'reversed']),
	td: new Set(['colspan', 'rowspan']),
	th: new Set(['colspan', 'rowspan', 'scope']),
	col: new Set(['span']),
	colgroup: new Set(['span']),
	details: new Set(['open']),
	time: new Set(['datetime']),
};

/** ブラウザが URL を読む前に捨てる制御文字と空白を除く（`java\tscript:` や先頭の空白で判定をすり抜けないように）。 */
function compactUrl(url: string): string {
	// eslint-disable-next-line no-control-regex
	return url.replace(/[\u0000- \u007f]+/g, '').toLowerCase();
}

/**
 * scheme の部分（最初の `/`・`?`・`#` より前）に文字参照が混ざっているか。`&#106;avascript:` や `&#104;ttps:` は、
 * ここでは scheme に見えないのに、ブラウザが属性を読むときに戻してしまう。
 */
function hasEncodedScheme(url: string): boolean {
	return (compactUrl(url).split(/[/?#]/, 1)[0] ?? '').includes('&');
}

/** 描かない画像の URL。scheme の付いたもの（`http(s):`・`file:` など）と `//` で始まるもの。`data:image/` は描く。 */
function isExternalImage(url: string): boolean {
	const compact = compactUrl(url);
	return hasEncodedScheme(url) || /^(?:[a-z][a-z\d+.-]*:|[/\\]{2})/.test(compact) && !compact.startsWith('data:image/');
}

/** リンクとして使えない scheme。 */
function isUnsafeHref(url: string): boolean {
	return hasEncodedScheme(url) || /^(?:javascript|vbscript|data|file):/.test(compactUrl(url));
}

/** 文字の中の `<`・`>` を逃がす。`&` は文字参照（`&amp;`・`&#39;`）でないものだけ。 */
function escapeText(text: string): string {
	return text.replace(/&(?!#?[a-z\d]+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, '&quot;');
}

const ATTRIBUTE_PATTERN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** 1 つのタグを許可リストで組み直す。残さないなら空文字。 */
function sanitizeTag(name: string, closing: boolean, rawAttributes: string): string {
	if (!ALLOWED_TAGS.has(name)) {
		return '';
	}
	if (closing) {
		return `</${name}>`;
	}
	const allowed = TAG_ATTRIBUTES[name];
	const kept: string[] = [];
	let alt: string | undefined;
	let dropImage = false;
	for (const match of rawAttributes.matchAll(ATTRIBUTE_PATTERN)) {
		const attribute = (match[1] ?? '').toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? '';
		if (!GLOBAL_ATTRIBUTES.has(attribute) && allowed?.has(attribute) !== true) {
			continue;
		}
		if (attribute === 'href' && isUnsafeHref(value)) {
			continue;
		}
		if (name === 'img' && attribute === 'src' && isExternalImage(value)) {
			dropImage = true;
			continue;
		}
		if (name === 'img' && attribute === 'alt') {
			alt = value;
		}
		kept.push(`${attribute}="${escapeAttribute(value)}"`);
	}
	if (name === 'img' && dropImage) {
		return externalImageText(alt);
	}
	return `<${name}${kept.length > 0 ? ` ${kept.join(' ')}` : ''}>`;
}

/** 描かない外の画像の代わり。alt が無ければ何も出さない。 */
function externalImageText(alt: string | undefined): string {
	return alt !== undefined && alt.trim().length > 0 ? `<span class="ext-img">${escapeAttribute(alt)}</span>` : '';
}

const TOKEN_PATTERN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^>]*>?|<(\/?)([a-z][a-z\d-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

/**
 * 生の HTML の切れ端を許可リストで組み直す（タグの外の文字は逃がして残す）。
 * `<script>…</script>` のように中身ごと落とすタグは、同じ切れ端の中の閉じタグまで捨てる。
 */
export function sanitizeMarkdownRawHtml(html: string): string {
	let out = '';
	let last = 0;
	let dropping: string | undefined;
	for (const match of html.matchAll(TOKEN_PATTERN)) {
		const index = match.index ?? 0;
		if (dropping === undefined) {
			out += escapeText(html.slice(last, index));
		}
		last = index + match[0].length;
		const name = match[2]?.toLowerCase();
		if (name === undefined) {
			// コメント・CDATA・`<!DOCTYPE>`・処理命令は出さない
			continue;
		}
		const closing = match[1] === '/';
		if (dropping !== undefined) {
			if (closing && name === dropping) {
				dropping = undefined;
			}
			continue;
		}
		if (DROPPED_WITH_CONTENT.has(name)) {
			if (!closing && !/\/\s*$/.test(match[3] ?? '')) {
				dropping = name;
			}
			continue;
		}
		out += sanitizeTag(name, closing, match[3] ?? '');
	}
	if (dropping === undefined) {
		out += escapeText(html.slice(last));
	}
	return out;
}

const safeMarked = new Marked({
	async: false,
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag): string {
			return sanitizeMarkdownRawHtml(token.text);
		},
		image(token: Tokens.Image): string | false {
			if (isExternalImage(token.href)) {
				return externalImageText(token.text);
			}
			// 外でない画像は marked の既定のまま描く
			return false;
		},
	},
});

/** Markdown を、生の HTML を許可リストで絞った HTML にする。 */
export function renderMarkdownSafely(content: string): string {
	return safeMarked.parse(content, { async: false });
}

/**
 * Markdown の表示に必ず当てる CSP。外の画像・音や動画・フレーム・フォームの送り先を止める。
 * `nonce` を渡すと自分のスクリプトだけを動かし（`viewerScriptContentSecurityPolicy`）、渡さなければスクリプトは動かさない。
 */
export function markdownContentSecurityPolicy(nonce?: string): string {
	const scripts = nonce !== undefined
		? viewerScriptContentSecurityPolicy(nonce)
		: `script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
	return `${scripts}; img-src data: blob:; media-src data: blob:`;
}

/** {@link markdownContentSecurityPolicy} を `<head>` の先頭に置く meta 要素。 */
export function markdownCspMeta(nonce?: string): string {
	return `<meta http-equiv="Content-Security-Policy" content="${markdownContentSecurityPolicy(nonce)}">`;
}
