// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ブラウザ画面のアドレス欄の見せ方と、打った文字の扱い（案A）。
 *
 * URL か検索かの判定は、PC が `browser.page.v1` を持っていれば PC に任せる（PC のアドレスバーと同じ判定と
 * 設定の検索エンジン。生の文字を `open` で送る）。ここの {@link legacyNavigateUrl} は、それを持たない古い
 * PC へ `navigate` で送るときだけ使う控えの判定（検索は Google）。
 */

/** アドレス欄に出すもの。`title` は題名（無ければホスト名）、`url` は URL。 */
export type AddressDisplayMode = 'title' | 'url';

const HTTP_URL = /^https?:\/\//i;
/** スキームの無いホスト名（:ポート、/パス付き可）。 */
const BARE_HOST = /^(?<host>\[[0-9a-f:.]+\]|[^\s/?#:]+)(?::(?<port>\d{1,5}))?(?:[/?#]\S*)?$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 手元の網の中を指すホスト（http で開く）。 */
function isLocalHost(host: string): boolean {
	const lower = host.toLowerCase();
	return lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || IPV4.test(lower) || lower.startsWith('[') || !lower.includes('.');
}

/**
 * 打った文字を URL か検索に分ける。空なら `undefined`。
 *
 * - `http://` `https://` で始まれば URL
 * - 空白を含めば検索
 * - `localhost`・IP・`.local`・ポート付きのホスト名・ドットとそれらしい TLD を持つホスト名（パス付き可）は URL
 *   （手元の網の中を指すものは http、それ以外は https を付ける）
 * - それ以外（1 語・TLD に見えないもの）は検索
 */
export function classifyBrowserAddress(raw: string): { readonly kind: 'url'; readonly url: string } | { readonly kind: 'search'; readonly query: string } | undefined {
	const text = raw.trim();
	if (text.length === 0) {
		return undefined;
	}
	if (HTTP_URL.test(text)) {
		return /\s/.test(text) ? { kind: 'search', query: text } : { kind: 'url', url: text };
	}
	if (/\s/.test(text)) {
		return { kind: 'search', query: text };
	}
	const groups = BARE_HOST.exec(text)?.groups;
	const host = groups?.host;
	if (host !== undefined) {
		const lower = host.toLowerCase();
		const tld = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
		const local = lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || IPV4.test(lower) || lower.startsWith('[');
		if (local || groups?.port !== undefined || /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld)) {
			return { kind: 'url', url: `${isLocalHost(host) ? 'http' : 'https'}://${text}` };
		}
	}
	return { kind: 'search', query: text };
}

/** `browser.page.v1` を持たない古い PC へ送る URL（検索は Google）。 */
export function legacyNavigateUrl(raw: string): string | undefined {
	const classified = classifyBrowserAddress(raw);
	if (classified === undefined) {
		return undefined;
	}
	return classified.kind === 'url'
		? classified.url
		: `https://www.google.com/search?q=${encodeURIComponent(classified.query.replace(/\s+/g, ' ')).replace(/%20/g, '+')}`;
}

/** URL のホスト名（`www.` は外す）。読めなければ `undefined`。 */
export function addressHost(url: string): string | undefined {
	const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?<host>\[[^\]]*\]|[^/?#:]*)/i.exec(url.trim())?.groups?.host;
	return host !== undefined && host.length > 0 ? host.toLowerCase().replace(/^www\./, '') : undefined;
}

/**
 * アドレス欄に出す文字。題名の表示では題名、無ければホスト名、それも無ければ URL。
 * URL の表示では `https://` を外した URL（`http://` は手元の網と見分けるため残す）。
 */
export function addressLabel(url: string, title: string, mode: AddressDisplayMode): string {
	if (mode === 'title') {
		const trimmed = title.trim();
		return trimmed.length > 0 ? trimmed : addressHost(url) ?? url;
	}
	return url.replace(/^https:\/\//i, '');
}
