/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDP ゲートウェイ（paradisCdpFilterProxy.ts）で、エージェントが Cookie を読み書きできないようにする
// 部分（q.html Q69「Cookie の読み書きは全面禁止」）。
//
// - 書き込み・送信: コマンドの引数を見て断る（{@link paradisCookieAndRewriteDeniedMessage}）
// - 読み取り: Network / Fetch / Audits のイベントから、Cookie のヘッダ（Cookie・Set-Cookie）と
//   Cookie の一覧を落とす（{@link paradisSanitizeCookieBearingEvent}）。コマンドの結果でヘッダを返す
//   `Network.loadNetworkResource` はゲートウェイの拒否リストで断る
//
// 守れないもの: ページの JS（`evaluate_script` など）から読める HttpOnly でない `document.cookie`。

/** 送るリクエストに Cookie を載せるヘッダの名前（小文字）。 */
const COOKIE_REQUEST_HEADER_NAMES: ReadonlySet<string> = new Set(['cookie', 'cookie2']);
/** 応答に載せると、共有の保存領域へ書き込む・消すヘッダの名前（小文字）。 */
const STATE_WRITING_RESPONSE_HEADER_NAMES: ReadonlySet<string> = new Set(['set-cookie', 'set-cookie2', 'clear-site-data']);

function headerEntryNames(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value.map(entry => (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : '').toLowerCase());
	}
	if (typeof value === 'object' && value !== null) {
		return Object.keys(value).map(name => name.toLowerCase());
	}
	return undefined;
}

/**
 * 引数まで見て断るコマンド。Cookie の読み書きは全面禁止（q.html Q69）なので、ヘッダ経由で Cookie を
 * 送る・Set-Cookie を返して書き込む抜け道を塞ぐ。Fetch で要求の URL を差し替えると、エージェントの
 * ネットワークの制限（Electron の webRequest で見る元の URL）をすり抜けうるので、差し替えも断る
 * （行き先を変えたいときは para-browser の set_request_rules の redirect を使う。ブラウザが
 * 辿り直すので制限に掛かる）。
 */
export function paradisCookieAndRewriteDeniedMessage(method: string, params: Record<string, unknown> | undefined): string | undefined {
	switch (method) {
		case 'Network.setExtraHTTPHeaders':
			return headerEntryNames(params?.headers)?.some(name => COOKIE_REQUEST_HEADER_NAMES.has(name))
				? `${method} with a Cookie header is not permitted: agents cannot read or write cookies in Para Code.`
				: undefined;
		case 'Fetch.continueRequest':
			if (params?.url !== undefined) {
				return `${method} with "url" is not permitted: rewriting the URL of a paused request could bypass the agent network restrictions. Use the redirect action of the para-browser set_request_rules tool instead.`;
			}
			return headerEntryNames(params?.headers)?.some(name => COOKIE_REQUEST_HEADER_NAMES.has(name))
				? `${method} with a Cookie header is not permitted: agents cannot read or write cookies in Para Code.`
				: undefined;
		case 'Fetch.fulfillRequest':
		case 'Fetch.continueResponse':
			if (params?.binaryResponseHeaders !== undefined) {
				return `${method} with "binaryResponseHeaders" is not permitted; pass "responseHeaders" instead.`;
			}
			return headerEntryNames(params?.responseHeaders)?.some(name => STATE_WRITING_RESPONSE_HEADER_NAMES.has(name))
				? `${method} with a Set-Cookie or Clear-Site-Data header is not permitted: agents cannot write cookies or clear the browser storage shared with the user in Para Code.`
				: undefined;
		case 'Network.continueInterceptedRequest':
		case 'Network.setRequestInterception':
			return `${method} is not permitted; use the Fetch domain (without URL rewriting) or the para-browser set_request_rules tool instead.`;
		default:
			return undefined;
	}
}

/** 読み取りでも落とす、Cookie を載せるヘッダの名前（小文字）。 */
const COOKIE_HEADER_NAMES: ReadonlySet<string> = new Set(['cookie', 'cookie2', 'set-cookie', 'set-cookie2']);
/** ヘッダの組を持つキー。オブジェクト（名前 → 値）か、{ name, value } の配列。 */
const HEADER_CONTAINER_KEYS: ReadonlySet<string> = new Set(['headers', 'requestHeaders', 'responseHeaders']);
/** 生のヘッダの文字列（Cookie の行を含みうる）。丸ごと落とす（任意の項目）。 */
const HEADER_TEXT_KEYS: ReadonlySet<string> = new Set(['headersText', 'requestHeadersText']);
/** Cookie そのものの一覧（値を含む）。空の配列にする（必須の項目なので消さない）。 */
const COOKIE_LIST_KEYS: ReadonlySet<string> = new Set(['associatedCookies', 'blockedCookies', 'exemptedCookies', 'cookies']);
/** Audits の Cookie の問題に載る、解釈できなかった Set-Cookie の生の行。 */
const COOKIE_LINE_KEYS: ReadonlySet<string> = new Set(['rawCookieLine']);
/** 中を見るイベントの domain。 */
const COOKIE_BEARING_EVENT_DOMAINS = ['Network.', 'Fetch.', 'Audits.'] as const;
const MAX_SANITIZE_DEPTH = 8;

function sanitizeHeaderContainer(value: unknown): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		const kept = value.filter(entry => !(typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' && COOKIE_HEADER_NAMES.has((entry as { name: string }).name.trim().toLowerCase())));
		return kept.length === value.length ? { value, changed: false } : { value: kept, changed: true };
	}
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>);
		const kept = entries.filter(([name]) => !COOKIE_HEADER_NAMES.has(name.trim().toLowerCase()));
		return kept.length === entries.length ? { value, changed: false } : { value: Object.fromEntries(kept), changed: true };
	}
	return { value, changed: false };
}

function sanitizeValue(value: unknown, depth: number): { value: unknown; changed: boolean } {
	if (depth > MAX_SANITIZE_DEPTH || typeof value !== 'object' || value === null) {
		return { value, changed: false };
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(item => {
			const result = sanitizeValue(item, depth + 1);
			changed ||= result.changed;
			return result.value;
		});
		return changed ? { value: next, changed } : { value, changed: false };
	}
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (HEADER_TEXT_KEYS.has(key) || COOKIE_LINE_KEYS.has(key)) {
			changed = true;
			continue;
		}
		if (COOKIE_LIST_KEYS.has(key) && Array.isArray(item)) {
			changed ||= item.length > 0;
			next[key] = [];
			continue;
		}
		if (HEADER_CONTAINER_KEYS.has(key)) {
			const result = sanitizeHeaderContainer(item);
			changed ||= result.changed;
			next[key] = result.value;
			continue;
		}
		const result = sanitizeValue(item, depth + 1);
		changed ||= result.changed;
		next[key] = result.value;
	}
	return changed ? { value: next, changed } : { value, changed: false };
}

/**
 * Network / Fetch / Audits のイベントから Cookie を落とした params を返す。何も落とさなければ undefined
 * （呼び出し側は元のフレームをそのまま送れる）。落とすのは次のもの:
 * - `headers` / `requestHeaders` / `responseHeaders` の Cookie・Cookie2・Set-Cookie・Set-Cookie2
 *   （`requestWillBeSentExtraInfo`、`responseReceivedExtraInfo`、`Fetch.requestPaused` の Response 段、
 *   WebSocket の握手など）
 * - `headersText` / `requestHeadersText`（生のヘッダの文字列）
 * - `associatedCookies` / `blockedCookies` / `exemptedCookies` / `cookies`（空の配列にする）
 * - Audits の `rawCookieLine`
 */
export function paradisSanitizeCookieBearingEvent(method: string, params: unknown): Record<string, unknown> | undefined {
	if (!COOKIE_BEARING_EVENT_DOMAINS.some(domain => method.startsWith(domain))) {
		return undefined;
	}
	const result = sanitizeValue(params, 0);
	return result.changed ? result.value as Record<string, unknown> : undefined;
}
