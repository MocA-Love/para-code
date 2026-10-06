/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の追加のブラウザ操作（追加ヘッダ・HTTP 認証・リクエストのルール・PDF・
// クリックでのダウンロード・ハイライト）の shared process ⇔ electron-main の契約と、両側で
// 同じものを使う検証・照合の関数。
//
// 検証は shared process（エージェントへ読める英文のエラーを返すため）と electron-main（受け取った
// 値を信用しないため）の両方で同じ関数を通す。どちらも失敗は英文 1 行にする。
//
// Cookie の読み書きは全面禁止（q.html Q69）。ここで扱うヘッダの名前は、送る側（Cookie）も
// 受け取る側（Set-Cookie）も通さない。

/** 追加ヘッダ（タブ全体）の上限。 */
export const PARADIS_PAGE_OPS_MAX_HEADERS = 32;
const PARADIS_PAGE_OPS_MAX_HEADER_NAME_LENGTH = 128;
const PARADIS_PAGE_OPS_MAX_HEADER_VALUE_LENGTH = 4096;
/** 1 タブに置けるリクエストのルールの数。 */
export const PARADIS_PAGE_OPS_MAX_RULES = 20;
const PARADIS_PAGE_OPS_MAX_PATTERN_LENGTH = 1024;
const PARADIS_PAGE_OPS_MAX_URL_LENGTH = 2048;
/** `respond` のルールで返せる本文の上限（UTF-8 のバイト数）。 */
export const PARADIS_PAGE_OPS_MAX_BODY_BYTES = 256 * 1024;
const PARADIS_PAGE_OPS_MAX_USERNAME_LENGTH = 256;
const PARADIS_PAGE_OPS_MAX_PASSWORD_LENGTH = 1024;
/** PDF のファイル名（拡張子込み）の上限。 */
const PARADIS_PAGE_OPS_MAX_FILE_NAME_LENGTH = 120;
/** ハイライトを出しておける最長の時間。 */
export const PARADIS_PAGE_OPS_MAX_HIGHLIGHT_MS = 30_000;
export const PARADIS_PAGE_OPS_DEFAULT_HIGHLIGHT_MS = 3_000;

/**
 * 送るリクエストに足す・書き換える・消すことを許さないヘッダ。Cookie は Q69 の決め事、残りは
 * 接続そのものを壊すもの（長さ・転送方式・接続先）と、プロキシの資格情報。
 */
const PARADIS_FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
	'cookie', 'cookie2', 'set-cookie', 'set-cookie2',
	'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect',
]);

/**
 * `respond` のルールで返してよい応答ヘッダ（許可リスト）。
 *
 * 載せていないものは断る。Set-Cookie（Cookie の書き込み）、Clear-Site-Data（共有の保存領域を消す）、
 * Strict-Transport-Security / Alt-Svc / NEL / Report-To（ブラウザに残り続ける設定）、キャッシュの
 * 指示（作った応答が共有のキャッシュに残って、利用者の他のタブへ出る）がその代表。キャッシュは
 * こちらで常に `no-store` を付ける。
 */
const PARADIS_ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
	'content-type', 'content-language', 'content-disposition', 'vary',
	'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers',
	'access-control-allow-methods', 'access-control-expose-headers', 'access-control-max-age',
]);

/** HTTP のヘッダ名に使える文字（RFC 9110 の token）。 */
const PARADIS_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type ParadisPageOpsParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function fail<T>(error: string): ParadisPageOpsParseResult<T> {
	return { ok: false, error };
}

function ok<T>(value: T): ParadisPageOpsParseResult<T> {
	return { ok: true, value };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** ヘッダの値に使えない文字（改行・NUL）。改行を許すと別のヘッダを差し込める。 */
function hasForbiddenHeaderValueCharacter(value: string): boolean {
	return /[\r\n\0]/.test(value);
}

/** 送るリクエストのヘッダ名として使ってよいか（大文字小文字は区別しない）。 */
export function paradisIsForbiddenRequestHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return PARADIS_FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith('proxy-');
}

/** 作った応答に載せてよいヘッダ名か（大文字小文字は区別しない）。 */
export function paradisIsAllowedResponseHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return PARADIS_ALLOWED_RESPONSE_HEADERS.has(lower) || lower.startsWith('x-');
}

/**
 * ヘッダの組（名前 → 値）を検証して写す。`kind` は送るリクエストか作る応答か。
 * 同じ名前（大文字小文字違い）が2つあれば断る。
 */
export function paradisParseHeaderMap(value: unknown, kind: 'request' | 'response', label: string): ParadisPageOpsParseResult<Readonly<Record<string, string>>> {
	if (value === undefined) {
		return ok(Object.freeze({}));
	}
	if (!isPlainRecord(value)) {
		return fail(`${label} must be an object that maps header names to string values.`);
	}
	const entries = Object.entries(value);
	if (entries.length > PARADIS_PAGE_OPS_MAX_HEADERS) {
		return fail(`${label} can have at most ${PARADIS_PAGE_OPS_MAX_HEADERS} headers.`);
	}
	const seen = new Set<string>();
	const result: Record<string, string> = {};
	for (const [name, headerValue] of entries) {
		if (name.length === 0 || name.length > PARADIS_PAGE_OPS_MAX_HEADER_NAME_LENGTH || !PARADIS_HEADER_NAME.test(name)) {
			return fail(`${label}: "${name.slice(0, 64)}" is not a valid HTTP header name.`);
		}
		const lower = name.toLowerCase();
		if (seen.has(lower)) {
			return fail(`${label}: the header "${name}" appears more than once (header names are case-insensitive).`);
		}
		seen.add(lower);
		if (kind === 'request' && paradisIsForbiddenRequestHeader(name)) {
			return fail(`${label}: the header "${name}" cannot be set. Cookies cannot be read or written by agents in Para Code, and connection-level headers are managed by the browser.`);
		}
		if (kind === 'response' && !paradisIsAllowedResponseHeader(name)) {
			return fail(`${label}: the response header "${name}" is not allowed. Allowed: Content-Type, Content-Language, Content-Disposition, Vary, Access-Control-* and X-* headers (Set-Cookie and headers the browser would remember are never allowed; caching is always disabled).`);
		}
		if (typeof headerValue !== 'string' || headerValue.length > PARADIS_PAGE_OPS_MAX_HEADER_VALUE_LENGTH || hasForbiddenHeaderValueCharacter(headerValue)) {
			return fail(`${label}: the value of "${name}" must be a string of at most ${PARADIS_PAGE_OPS_MAX_HEADER_VALUE_LENGTH} characters without line breaks.`);
		}
		result[name] = headerValue;
	}
	return ok(Object.freeze(result));
}

/** 消すヘッダ名の一覧を検証する。 */
function parseHeaderNameList(value: unknown, label: string): ParadisPageOpsParseResult<readonly string[]> {
	if (value === undefined) {
		return ok(Object.freeze([]));
	}
	if (!Array.isArray(value) || value.length > PARADIS_PAGE_OPS_MAX_HEADERS) {
		return fail(`${label} must be an array of at most ${PARADIS_PAGE_OPS_MAX_HEADERS} header names.`);
	}
	const names: string[] = [];
	for (const name of value) {
		if (typeof name !== 'string' || name.length === 0 || name.length > PARADIS_PAGE_OPS_MAX_HEADER_NAME_LENGTH || !PARADIS_HEADER_NAME.test(name)) {
			return fail(`${label}: every entry must be a valid HTTP header name.`);
		}
		if (paradisIsForbiddenRequestHeader(name)) {
			return fail(`${label}: the header "${name}" cannot be removed. Cookies cannot be read or written by agents in Para Code, and connection-level headers are managed by the browser.`);
		}
		names.push(name);
	}
	return ok(Object.freeze(names));
}

// --- HTTP 認証 ---------------------------------------------------------------------------------

/** タブに置く HTTP 認証の資格情報。パスワードは electron-main のメモリにだけ置き、返さない。 */
export interface IParadisHttpCredentials {
	/** 答えてよい相手（scheme://host[:port]）。これ以外の相手の求めには答えない。 */
	readonly origin: string;
	readonly username: string;
	readonly password: string;
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

/**
 * 資格情報を答える相手を検証して origin に揃える。https のほか、手元（loopback）の http だけを
 * 認める（平文の http で Basic 認証を送ると、途中の経路で読める）。
 */
export function paradisParseCredentialOrigin(value: unknown): ParadisPageOpsParseResult<string> {
	if (typeof value !== 'string' || value.length === 0 || value.length > PARADIS_PAGE_OPS_MAX_URL_LENGTH) {
		return fail('"origin" must be the site that asks for the login, for example "https://intranet.example.com".');
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail(`"origin" is not a valid URL: ${value.slice(0, 200)}`);
	}
	if (url.username || url.password) {
		return fail('"origin" must not contain a user name or password; pass them as "username" and "password".');
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
		return fail('"origin" must use https (plain http is only accepted for localhost), because the login would otherwise be sent unencrypted.');
	}
	return ok(url.origin);
}

/** HTTP 認証の資格情報を検証する。 */
export function paradisParseHttpCredentials(value: unknown): ParadisPageOpsParseResult<IParadisHttpCredentials> {
	if (!isPlainRecord(value)) {
		return fail('Credentials must be an object with "origin", "username" and "password".');
	}
	const origin = paradisParseCredentialOrigin(value.origin);
	if (!origin.ok) {
		return origin;
	}
	const { username, password } = value;
	if (typeof username !== 'string' || username.length === 0 || username.length > PARADIS_PAGE_OPS_MAX_USERNAME_LENGTH || /[\r\n\0:]/.test(username)) {
		return fail(`"username" must be a non-empty string of at most ${PARADIS_PAGE_OPS_MAX_USERNAME_LENGTH} characters, without line breaks or ":".`);
	}
	if (typeof password !== 'string' || password.length > PARADIS_PAGE_OPS_MAX_PASSWORD_LENGTH || /[\r\n\0]/.test(password)) {
		return fail(`"password" must be a string of at most ${PARADIS_PAGE_OPS_MAX_PASSWORD_LENGTH} characters without line breaks.`);
	}
	return ok(Object.freeze({ origin: origin.value, username, password }));
}

// --- リクエストのルール -------------------------------------------------------------------------

export type ParadisRequestRuleAction = 'block' | 'set_headers' | 'redirect' | 'respond';

/** リクエストのルール1件。上から順に照合し、最初に当たったものだけを使う。 */
export interface IParadisRequestRule {
	/** Chromium の Fetch と同じ書き方（`*` は0文字以上、`?` はちょうど1文字、`\` で打ち消す）。 */
	readonly urlPattern: string;
	readonly action: ParadisRequestRuleAction;
	/** `set_headers`: 足す・上書きするヘッダ。 */
	readonly setHeaders?: Readonly<Record<string, string>>;
	/** `set_headers`: 消すヘッダの名前。 */
	readonly removeHeaders?: readonly string[];
	/** `redirect`: 行き先（http / https）。307 の応答として返し、ブラウザに辿らせる。 */
	readonly redirectUrl?: string;
	/** `respond`: 状態コード（200〜299・400〜599）。 */
	readonly status?: number;
	/** `respond`: 本文（テキスト）。 */
	readonly body?: string;
	/** `respond`: 応答ヘッダ（許可リストのものだけ）。 */
	readonly responseHeaders?: Readonly<Record<string, string>>;
}

function parseHttpUrl(value: unknown, label: string): ParadisPageOpsParseResult<string> {
	if (typeof value !== 'string' || value.length === 0 || value.length > PARADIS_PAGE_OPS_MAX_URL_LENGTH) {
		return fail(`${label} must be an absolute http(s) URL of at most ${PARADIS_PAGE_OPS_MAX_URL_LENGTH} characters.`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail(`${label} is not a valid URL: ${value.slice(0, 200)}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return fail(`${label} must use http or https.`);
	}
	if (url.username || url.password) {
		return fail(`${label} must not contain a user name or password.`);
	}
	return ok(url.href);
}

function parseRule(value: unknown, index: number): ParadisPageOpsParseResult<IParadisRequestRule> {
	const label = `rules[${index}]`;
	if (!isPlainRecord(value)) {
		return fail(`${label} must be an object.`);
	}
	const known = new Set(['url_pattern', 'action', 'set_headers', 'remove_headers', 'redirect_url', 'status', 'body', 'response_headers']);
	const unknownKey = Object.keys(value).find(key => !known.has(key));
	if (unknownKey !== undefined) {
		return fail(`${label}: unknown field "${unknownKey.slice(0, 64)}".`);
	}
	const urlPattern = value.url_pattern;
	if (typeof urlPattern !== 'string' || urlPattern.length === 0 || urlPattern.length > PARADIS_PAGE_OPS_MAX_PATTERN_LENGTH || /[\r\n\0]/.test(urlPattern)) {
		return fail(`${label}.url_pattern must be a non-empty URL pattern (for example "*://api.example.com/v1/*"; "*" matches any characters, "?" exactly one).`);
	}
	const action = value.action;
	switch (action) {
		case 'block':
			return ok(Object.freeze({ urlPattern, action }));
		case 'set_headers': {
			const setHeaders = paradisParseHeaderMap(value.set_headers, 'request', `${label}.set_headers`);
			if (!setHeaders.ok) {
				return setHeaders;
			}
			const removeHeaders = parseHeaderNameList(value.remove_headers, `${label}.remove_headers`);
			if (!removeHeaders.ok) {
				return removeHeaders;
			}
			if (Object.keys(setHeaders.value).length === 0 && removeHeaders.value.length === 0) {
				return fail(`${label}: a "set_headers" rule needs "set_headers" and/or "remove_headers".`);
			}
			return ok(Object.freeze({ urlPattern, action, setHeaders: setHeaders.value, removeHeaders: removeHeaders.value }));
		}
		case 'redirect': {
			const redirectUrl = parseHttpUrl(value.redirect_url, `${label}.redirect_url`);
			return redirectUrl.ok ? ok(Object.freeze({ urlPattern, action, redirectUrl: redirectUrl.value })) : redirectUrl;
		}
		case 'respond': {
			const status = value.status ?? 200;
			if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) {
				return fail(`${label}.status must be an integer from 200-299 or 400-599 (use a "redirect" rule for redirects).`);
			}
			const body = value.body ?? '';
			if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > PARADIS_PAGE_OPS_MAX_BODY_BYTES) {
				return fail(`${label}.body must be text of at most ${PARADIS_PAGE_OPS_MAX_BODY_BYTES / 1024} KiB.`);
			}
			const responseHeaders = paradisParseHeaderMap(value.response_headers, 'response', `${label}.response_headers`);
			if (!responseHeaders.ok) {
				return responseHeaders;
			}
			return ok(Object.freeze({ urlPattern, action, status, body, responseHeaders: responseHeaders.value }));
		}
		default:
			return fail(`${label}.action must be one of "block", "set_headers", "redirect", "respond".`);
	}
}

/** リクエストのルールの一覧を検証する（空の一覧は「すべて外す」）。 */
export function paradisParseRequestRules(value: unknown): ParadisPageOpsParseResult<readonly IParadisRequestRule[]> {
	if (!Array.isArray(value)) {
		return fail('"rules" must be an array (an empty array removes all rules).');
	}
	if (value.length > PARADIS_PAGE_OPS_MAX_RULES) {
		return fail(`At most ${PARADIS_PAGE_OPS_MAX_RULES} request rules can be active on a tab.`);
	}
	const rules: IParadisRequestRule[] = [];
	for (const [index, raw] of value.entries()) {
		const rule = parseRule(raw, index);
		if (!rule.ok) {
			return rule;
		}
		rules.push(rule.value);
	}
	return ok(Object.freeze(rules));
}

/**
 * ルールと照らす URL の長さの上限。これより長い URL（大きな data を埋めた GET など）はどのルールにも当てず、
 * そのまま流す。照合の手間は URL の長さに比例するので、Fetch の paused ごとに electron-main を止めないため。
 */
export const PARADIS_PAGE_OPS_MAX_MATCH_URL_LENGTH = 64 * 1024;
/** 1 回の照合で `?` を含む区切りを1文字ずつ比べる回数の上限。超えたら当たらないことにする（同じ理由）。 */
const MAX_MATCH_COMPARISONS = 4_000_000;

/** `*` で区切った1区切り。`undefined` は `?`（ちょうど1文字）。 */
type UrlPatternSegment = readonly (string | undefined)[];

function splitUrlPattern(pattern: string): UrlPatternSegment[] {
	const segments: (string | undefined)[][] = [[]];
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		const current = segments[segments.length - 1];
		if (char === '\\' && i + 1 < pattern.length) {
			current.push(pattern[++i]);
		} else if (char === '*') {
			segments.push([]);
		} else if (char === '?') {
			current.push(undefined);
		} else {
			current.push(char);
		}
	}
	return segments;
}

/**
 * Chromium の Fetch の urlPattern と同じ規則で URL を照合する（`*` は0文字以上、`?` はちょうど1文字、
 * `\` の次の文字はそのまま）。Chromium が止めたリクエストに、どのルールを当てるかを決めるのに使う。
 *
 * 正規表現にすると `*a*a*a…b` のような指定でバックトラックが爆発し、Fetch の paused ごとに electron-main が
 * 止まる。そこで `*` で区切り、先頭と末尾の区切りはその位置で、間の区切りは左から順にいちばん手前で探す
 * （戻らない）。`?` の無い区切りは `indexOf` で探す。長すぎる URL（{@link PARADIS_PAGE_OPS_MAX_MATCH_URL_LENGTH}）と、
 * `?` の区切りの比較が上限を超えたときは当たらないことにする。
 */
export function paradisMatchUrlPattern(pattern: string, url: string): boolean {
	if (url.length > PARADIS_PAGE_OPS_MAX_MATCH_URL_LENGTH) {
		return false;
	}
	let budget = MAX_MATCH_COMPARISONS;
	const matchesAt = (segment: UrlPatternSegment, at: number): boolean => {
		for (let j = 0; j < segment.length; j++) {
			const expected = segment[j];
			if (expected !== undefined && expected !== url[at + j]) {
				return false;
			}
		}
		return true;
	};
	/** `from` 以降で、`end` までに収まるいちばん手前の位置（無ければ -1、上限を超えたら undefined）。 */
	const find = (segment: UrlPatternSegment, from: number, end: number): number | undefined => {
		if (!segment.includes(undefined)) {
			const at = url.indexOf(segment.join(''), from);
			return at >= 0 && at + segment.length <= end ? at : -1;
		}
		for (let at = from; at + segment.length <= end; at++) {
			budget -= segment.length;
			if (budget < 0) {
				return undefined;
			}
			if (matchesAt(segment, at)) {
				return at;
			}
		}
		return -1;
	};
	const segments = splitUrlPattern(pattern);
	const first = segments[0];
	if (segments.length === 1) {
		return first.length === url.length && matchesAt(first, 0);
	}
	const last = segments[segments.length - 1];
	if (first.length + last.length > url.length || !matchesAt(first, 0) || !matchesAt(last, url.length - last.length)) {
		return false;
	}
	let position = first.length;
	const end = url.length - last.length;
	for (let index = 1; index < segments.length - 1; index++) {
		const segment = segments[index];
		if (segment.length === 0) {
			continue;
		}
		const at = find(segment, position, end);
		if (at === undefined || at < 0) {
			return false;
		}
		position = at + segment.length;
	}
	return true;
}

/** 止めたリクエストに当てるルール（最初に当たったもの）。 */
export function paradisFindRequestRule(rules: readonly IParadisRequestRule[], url: string): IParadisRequestRule | undefined {
	return rules.find(rule => paradisMatchUrlPattern(rule.urlPattern, url));
}

/**
 * `set_headers` のルールを、元のリクエストのヘッダへ当てた結果（Fetch.continueRequest の `headers`）。
 * Cookie は元の一覧にあっても触らない（この段階では通常まだ入っていない）。
 */
export function paradisApplyHeaderRule(original: Readonly<Record<string, string>>, rule: IParadisRequestRule): { name: string; value: string }[] {
	const removed = new Set((rule.removeHeaders ?? []).map(name => name.toLowerCase()));
	const overridden = new Set(Object.keys(rule.setHeaders ?? {}).map(name => name.toLowerCase()));
	const headers: { name: string; value: string }[] = [];
	for (const [name, value] of Object.entries(original)) {
		const lower = name.toLowerCase();
		if (removed.has(lower) && !paradisIsForbiddenRequestHeader(name)) {
			continue;
		}
		if (overridden.has(lower) && !paradisIsForbiddenRequestHeader(name)) {
			continue;
		}
		headers.push({ name, value });
	}
	for (const [name, value] of Object.entries(rule.setHeaders ?? {})) {
		if (!paradisIsForbiddenRequestHeader(name)) {
			headers.push({ name, value });
		}
	}
	return headers;
}

/** `respond` のルールの応答ヘッダ（Fetch.fulfillRequest の `responseHeaders`）。キャッシュは常に止める。 */
export function paradisBuildRespondHeaders(rule: IParadisRequestRule): { name: string; value: string }[] {
	const headers: { name: string; value: string }[] = [];
	let hasContentType = false;
	for (const [name, value] of Object.entries(rule.responseHeaders ?? {})) {
		if (!paradisIsAllowedResponseHeader(name)) {
			continue;
		}
		hasContentType ||= name.toLowerCase() === 'content-type';
		headers.push({ name, value });
	}
	if (!hasContentType) {
		headers.push({ name: 'Content-Type', value: 'text/plain; charset=utf-8' });
	}
	headers.push({ name: 'Cache-Control', value: 'no-store' });
	return headers;
}

/** `redirect` のルールの応答ヘッダ。ブラウザは Location を辿り直す（その要求にもネットワークの制限が掛かる）。 */
export function paradisBuildRedirectHeaders(rule: IParadisRequestRule, requestOrigin?: string): { name: string; value: string }[] {
	const headers = [
		{ name: 'Location', value: rule.redirectUrl ?? '' },
		{ name: 'Cache-Control', value: 'no-store' },
	];
	// 別 origin の fetch / XHR がこの 307 を辿れるよう、要求元の origin を CORS で許す（リダイレクトの応答
	// そのものも CORS の検査を受ける）。辿った先の応答は、その先のサーバーの CORS で決まる。
	if (requestOrigin !== undefined && /^https?:\/\/[^\s/]+$/.test(requestOrigin)) {
		headers.push({ name: 'Access-Control-Allow-Origin', value: requestOrigin }, { name: 'Access-Control-Allow-Credentials', value: 'true' }, { name: 'Vary', value: 'Origin' });
	}
	return headers;
}

// --- タブの状態（エージェントへ返す要約） -------------------------------------------------------

/** タブに掛かっている上書きの要約。ヘッダの値とパスワードは返さない。 */
export interface IParadisPageOverridesSummary {
	readonly extraHeaderNames: readonly string[];
	/** 追加ヘッダを付ける相手（origin）。 */
	readonly extraHeaderOrigins?: readonly string[];
	/** HTTP 認証を答える相手。置いていなければ undefined。 */
	readonly credentialsOrigin?: string;
	readonly rules: readonly { readonly urlPattern: string; readonly action: ParadisRequestRuleAction; readonly matched: number }[];
}

// --- electron-main への要求 ----------------------------------------------------------------------

/** 追加ヘッダの上限の相手の数。 */
export const PARADIS_PAGE_OPS_MAX_HEADER_ORIGINS = 10;

/**
 * 追加ヘッダと、それを付ける相手。`origins` が空なら、electron-main が掛けた時点のトップフレームの
 * origin だけにする（ページが読み込む第三者のホストへ出さないため）。
 */
export interface IParadisExtraHeaders {
	readonly headers: Readonly<Record<string, string>>;
	readonly origins: readonly string[];
}

/** 追加ヘッダを付ける相手の一覧を検証して origin に揃える（http / https のみ）。 */
export function paradisParseHeaderOrigins(value: unknown): ParadisPageOpsParseResult<readonly string[]> {
	if (value === undefined) {
		return ok(Object.freeze([]));
	}
	if (!Array.isArray(value) || value.length > PARADIS_PAGE_OPS_MAX_HEADER_ORIGINS) {
		return fail(`"origins" must be an array of at most ${PARADIS_PAGE_OPS_MAX_HEADER_ORIGINS} origins such as "https://staging.example.com".`);
	}
	const origins = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const url = parseHttpUrl(entry, `origins[${index}]`);
		if (!url.ok) {
			return url;
		}
		origins.add(new URL(url.value).origin);
	}
	return ok(Object.freeze([...origins]));
}

function parseExtraHeaders(value: unknown): ParadisPageOpsParseResult<IParadisExtraHeaders> {
	if (!isPlainRecord(value)) {
		return fail('invalid extra headers');
	}
	const headers = paradisParseHeaderMap(value.headers, 'request', 'headers');
	if (!headers.ok) {
		return headers;
	}
	const origins = paradisParseHeaderOrigins(value.origins);
	if (!origins.ok) {
		return origins;
	}
	return ok(Object.freeze({ headers: headers.value, origins: origins.value }));
}

/**
 * 止めたリクエストに追加ヘッダを足した結果（Fetch.continueRequest の `headers`）。
 * 相手の origin が一覧に無ければ undefined（何も足さない）。
 */
export function paradisApplyExtraHeaders(original: Readonly<Record<string, string>>, url: string, extra: IParadisExtraHeaders): { name: string; value: string }[] | undefined {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		return undefined;
	}
	if (!extra.origins.includes(origin)) {
		return undefined;
	}
	const overridden = new Set(Object.keys(extra.headers).map(name => name.toLowerCase()));
	const headers: { name: string; value: string }[] = [];
	for (const [name, value] of Object.entries(original)) {
		if (!overridden.has(name.toLowerCase())) {
			headers.push({ name, value });
		}
	}
	for (const [name, value] of Object.entries(extra.headers)) {
		if (!paradisIsForbiddenRequestHeader(name)) {
			headers.push({ name, value });
		}
	}
	return headers;
}

/**
 * タブへの上書きの要求。値のある項目だけを置き換える（`null` はその項目を外す）。
 * shared process と electron-main の間を JSON で渡す。
 */
export interface IParadisPageOverridesRequest {
	readonly extraHeaders?: IParadisExtraHeaders | null;
	readonly credentials?: IParadisHttpCredentials | null;
	readonly rules?: readonly IParadisRequestRule[] | null;
}

export type ParadisPageOpsFailure =
	/** 共有しているタブが見つからない（閉じた・共有が終わった）。 */
	| 'unavailable'
	/** 同じタブに別のペインが上書きを掛けている。 */
	| 'ownedByAnotherPane'
	/** 共有が入れ替わった後に届いた古い要求。 */
	| 'stale'
	/** 値が不正。 */
	| 'invalid'
	/** ブラウザ側の処理に失敗した。 */
	| 'failed'
	/**
	 * 呼んだペインだけが使う保存領域のタブではない（利用者のタブ、ワークスペースで共有するエージェントの
	 * 保存領域、別のペインや利用者も使っているプロファイル）。ネットワークの上書きは、そのペイン専用の
	 * 保存領域（`open_browser_tab` の `private`）か、そのペインが作ってほかが使っていないプロファイルの
	 * タブにだけ掛ける。
	 */
	| 'userStorage';

/**
 * そのペイン専用の保存領域（メモリだけ、ペインごと）の affinity。エージェントの保存領域（Agent スコープ）を
 * この affinity で作ると、ほかのペイン・利用者のタブと保存領域（Cookie・認証のキャッシュ・HTTP キャッシュ）を
 * 分け合わない。`ownerKey` はペイントークンから shared process が作る不透明な名前。
 */
export function paradisPaneStorageAffinity(ownerKey: string): string {
	return `paradis-pane-${ownerKey}`;
}

/** {@link paradisPaneStorageAffinity} の形か（renderer が shared process から受け取った値を確かめる）。 */
export function paradisIsPaneStorageAffinity(value: unknown): value is string {
	return typeof value === 'string' && /^paradis-pane-[0-9a-f]{16,64}$/.test(value);
}

/** タブの保存領域が誰のものか（electron-main の判定）。 */
export type IParadisPageStorageDescription =
	/** 呼んだペイン専用の保存領域。 */
	| { readonly kind: 'pane' }
	/** エージェントが作った印の付いたプロファイル。そのペインが作ってほかが使っていないかは renderer が確かめる。 */
	| { readonly kind: 'profile'; readonly profileId: string }
	/** それ以外（利用者のタブ、共有の保存領域）。 */
	| { readonly kind: 'user' };

export type IParadisPageOverridesResult =
	| { readonly ok: true; readonly summary: IParadisPageOverridesSummary }
	| { readonly ok: false; readonly reason: ParadisPageOpsFailure; readonly message?: string };

// --- 遷移・再読み込みの後も動くスクリプト（add_init_script） ------------------------------------------

/** 1 本のスクリプトの上限（文字数）。 */
export const PARADIS_INIT_SCRIPT_MAX_CHARS = 100_000;
/** 1 枚のタブに 1 つのペインが置けるスクリプトの数。 */
export const PARADIS_INIT_SCRIPT_MAX_PER_TAB = 10;
const PARADIS_INIT_SCRIPT_MAX_LABEL_LENGTH = 80;

/** add_init_script の中身（shared process から electron-main へ JSON で渡す）。 */
export interface IParadisInitScriptRequest {
	readonly source: string;
	/** 一覧に出す短い名前。 */
	readonly label: string;
	/** いま開いているページでもすぐ動かすか。 */
	readonly runNow: boolean;
}

/** タブに置いたスクリプト（中身は返さない）。 */
export interface IParadisInitScriptInfo {
	/** remove_init_script に渡す名前（`s1` など）。 */
	readonly id: string;
	readonly label: string;
	/** スクリプトの文字数。 */
	readonly chars: number;
	/** 置いた時刻（ミリ秒）。 */
	readonly addedAt: number;
}

export type IParadisInitScriptsResult =
	| {
		readonly ok: true;
		/** 呼んだペインがこのタブに置いているスクリプト。 */
		readonly scripts: readonly IParadisInitScriptInfo[];
		/** ほかのペインがこのタブに置いているスクリプトの数。 */
		readonly otherPanes: number;
		readonly added?: IParadisInitScriptInfo;
		readonly removed?: number;
	}
	| { readonly ok: false; readonly reason: ParadisPageOpsFailure; readonly message?: string };

/** add_init_script の引数を読む（shared process と electron-main の両方で使う）。 */
export function paradisParseInitScriptRequest(value: unknown): ParadisPageOpsParseResult<IParadisInitScriptRequest> {
	if (!isPlainRecord(value)) {
		return fail('invalid request');
	}
	const { source, label, runNow } = value;
	if (typeof source !== 'string' || source.trim().length === 0 || source.length > PARADIS_INIT_SCRIPT_MAX_CHARS) {
		return fail(`"source" must be non-empty JavaScript of at most ${PARADIS_INIT_SCRIPT_MAX_CHARS} characters.`);
	}
	if (label !== undefined && (typeof label !== 'string' || label.length > PARADIS_INIT_SCRIPT_MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label))) {
		return fail(`"label" must be a single line of at most ${PARADIS_INIT_SCRIPT_MAX_LABEL_LENGTH} characters.`);
	}
	if (runNow !== undefined && typeof runNow !== 'boolean') {
		return fail('"run_now" must be true or false.');
	}
	const fallbackLabel = source.trim().replace(/\s+/g, ' ').slice(0, 40);
	return { ok: true, value: Object.freeze({ source, label: typeof label === 'string' && label.trim().length > 0 ? label.trim() : fallbackLabel, runNow: runNow === true }) };
}

/** electron-main が受け取った要求を検証し直す（shared process を信用しない）。 */
export function paradisParsePageOverridesRequest(value: unknown): ParadisPageOpsParseResult<IParadisPageOverridesRequest> {
	if (!isPlainRecord(value)) {
		return fail('invalid request');
	}
	const request: { extraHeaders?: IParadisExtraHeaders | null; credentials?: IParadisHttpCredentials | null; rules?: readonly IParadisRequestRule[] | null } = {};
	if (value.extraHeaders !== undefined) {
		if (value.extraHeaders === null) {
			request.extraHeaders = null;
		} else {
			const extra = parseExtraHeaders(value.extraHeaders);
			if (!extra.ok) {
				return extra;
			}
			request.extraHeaders = extra.value;
		}
	}
	if (value.credentials !== undefined) {
		if (value.credentials === null) {
			request.credentials = null;
		} else {
			const credentials = paradisParseHttpCredentials(value.credentials);
			if (!credentials.ok) {
				return credentials;
			}
			request.credentials = credentials.value;
		}
	}
	if (value.rules !== undefined) {
		if (value.rules === null) {
			request.rules = null;
		} else {
			// electron-main には内部形（camelCase）で届くので、検証用に外の形へ戻してから通す。
			const rules = Array.isArray(value.rules) ? value.rules.map(paradisRuleToToolShape) : value.rules;
			const parsed = paradisParseRequestRules(rules);
			if (!parsed.ok) {
				return parsed;
			}
			request.rules = parsed.value;
		}
	}
	return ok(Object.freeze(request));
}

/** 内部形のルールをツールの引数の形（snake_case）へ戻す。electron-main で同じ検証を通すため。 */
function paradisRuleToToolShape(rule: unknown): unknown {
	if (!isPlainRecord(rule)) {
		return rule;
	}
	const shape: Record<string, unknown> = { url_pattern: rule.urlPattern, action: rule.action };
	if (rule.setHeaders !== undefined) {
		shape.set_headers = rule.setHeaders;
	}
	if (rule.removeHeaders !== undefined) {
		shape.remove_headers = rule.removeHeaders;
	}
	if (rule.redirectUrl !== undefined) {
		shape.redirect_url = rule.redirectUrl;
	}
	if (rule.status !== undefined) {
		shape.status = rule.status;
	}
	if (rule.body !== undefined) {
		shape.body = rule.body;
	}
	if (rule.responseHeaders !== undefined) {
		shape.response_headers = rule.responseHeaders;
	}
	return shape;
}

// --- PDF ---------------------------------------------------------------------------------------

export type ParadisPdfPaperFormat = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'Tabloid';
const PARADIS_PDF_PAPER_FORMATS: readonly ParadisPdfPaperFormat[] = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid'];

export interface IParadisPdfOptions {
	/** 保存するファイル名（拡張子込み、整えたもの）。 */
	readonly fileName: string;
	readonly landscape: boolean;
	readonly printBackground: boolean;
	readonly paperFormat: ParadisPdfPaperFormat;
	readonly scale: number;
	/** `1-5, 8` の形。空なら全ページ。 */
	readonly pageRanges: string;
}

export type IParadisPdfResult =
	| { readonly ok: true; readonly path: string; readonly fileName: string; readonly bytes: number }
	| { readonly ok: false; readonly reason: ParadisPageOpsFailure; readonly message?: string };

/**
 * 保存するファイル名を整える。パスの区切り・制御文字・双方向制御・OS が使えない文字を落とし、
 * 末尾の点と空白を落とし、拡張子を `.pdf` にそろえる。空になったら `fallback` を使う。
 */
export function paradisSanitizePdfFileName(value: unknown, fallback: string): string {
	const clean = (raw: string) => raw
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
		.replace(/[<>:"/\\|?*]/g, '_')
		.trim()
		.replace(/[.\s]+$/, '')
		.replace(/^\.+/, '');
	let base = typeof value === 'string' ? clean(value) : '';
	if (base.toLowerCase().endsWith('.pdf')) {
		base = base.slice(0, -4).replace(/[.\s]+$/, '');
	}
	if (base.length === 0) {
		base = clean(fallback);
	}
	if (base.length === 0) {
		base = 'page';
	}
	// Windows の予約名（CON、NUL、COM1 など。拡張子が付いていても、上付き数字でも予約名）は、
	// 最初の点の前に印を付けて避ける。
	const reserved = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i.exec(base);
	if (reserved) {
		base = `${reserved[1]}_${base.slice(reserved[1].length)}`;
	}
	const maxBase = PARADIS_PAGE_OPS_MAX_FILE_NAME_LENGTH - 4;
	if (base.length > maxBase) {
		base = base.slice(0, maxBase).replace(/[.\s]+$/, '');
	}
	return `${base}.pdf`;
}

/** PDF の指定を検証する（ツールの引数の形から）。 */
export function paradisParsePdfOptions(value: unknown, fallbackName: string): ParadisPageOpsParseResult<IParadisPdfOptions> {
	const args = isPlainRecord(value) ? value : {};
	const landscape = args.landscape ?? false;
	const printBackground = args.print_background ?? true;
	const paperFormat = args.paper_format ?? 'A4';
	const scale = args.scale ?? 1;
	const pageRanges = args.page_ranges ?? '';
	if (typeof landscape !== 'boolean' || typeof printBackground !== 'boolean') {
		return fail('"landscape" and "print_background" must be booleans.');
	}
	if (typeof paperFormat !== 'string' || !(PARADIS_PDF_PAPER_FORMATS as readonly string[]).includes(paperFormat)) {
		return fail(`"paper_format" must be one of ${PARADIS_PDF_PAPER_FORMATS.join(', ')}.`);
	}
	if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 2) {
		return fail('"scale" must be a number from 0.1 to 2.');
	}
	if (typeof pageRanges !== 'string' || pageRanges.length > 100 || !/^[\d\s,-]*$/.test(pageRanges)) {
		return fail('"page_ranges" must look like "1-5, 8, 11-13".');
	}
	if (args.file_name !== undefined && typeof args.file_name !== 'string') {
		return fail('"file_name" must be a string.');
	}
	return ok(Object.freeze({
		fileName: paradisSanitizePdfFileName(args.file_name, fallbackName),
		landscape,
		printBackground,
		paperFormat: paperFormat as ParadisPdfPaperFormat,
		scale,
		pageRanges: pageRanges.trim(),
	}));
}

// --- クリックでのダウンロード --------------------------------------------------------------------

export type IParadisAgentDownloadResult =
	| {
		readonly ok: true;
		readonly started: true;
		readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
		readonly fileName: string;
		/** 保存先。利用者が保存先を選ぶ設定のときは、選ぶまで空。 */
		readonly path: string;
		readonly receivedBytes: number;
		readonly totalBytes: number;
	}
	| { readonly ok: true; readonly started: false }
	| { readonly ok: false; readonly reason: ParadisPageOpsFailure; readonly message?: string };

// --- ハイライト --------------------------------------------------------------------------------

/** ビューポートの CSS ピクセルでの長方形。 */
export interface IParadisHighlightRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** ハイライトする長方形を検証する（0 以上、有限、大きすぎない）。 */
export function paradisParseHighlightRect(value: unknown): IParadisHighlightRect | undefined {
	if (!isPlainRecord(value)) {
		return undefined;
	}
	const { x, y, width, height } = value;
	const valid = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= 100_000;
	return valid(x, -100_000) && valid(y, -100_000) && valid(width, 1) && valid(height, 1)
		? Object.freeze({ x, y, width, height })
		: undefined;
}

// --- 呼び出し元の識別 ----------------------------------------------------------------------------

/** 上書きの持ち主（ペイン）を electron-main へ渡すときの不透明な名前。トークンそのものは渡さない。 */
export function paradisIsPageOpsOwnerKey(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value);
}

// --- electron-main の口 ------------------------------------------------------------------------

/**
 * shared process から `PARADIS_CDP_TARGET_CHANNEL` 経由で呼ぶ、追加のブラウザ操作の口。
 * どれも exact descriptor で指したタブにだけ効き、descriptor が古ければ `unavailable` を返す。
 */
export interface IParadisCdpPageOpsService {
	/**
	 * タブへの上書き（追加ヘッダ・HTTP 認証・リクエストのルール）を置き換える。`requestJson` は
	 * {@link IParadisPageOverridesRequest}。プロファイルのタブは、renderer がそのペインのものと確かめた
	 * `confirmedProfileId` が一致するときだけ受け付ける。
	 */
	/**
	 * `storageOwnerKey` は、そのペイン専用の保存領域かを確かめるときの持ち主（ペインのトークンから作る）。
	 * 上書きの持ち主（`ownerKey`）はタブごとなので、省略すると `ownerKey` を使う（これまでの呼び方）。
	 */
	applyExactViewPageOverrides(descriptor: unknown, ownerKey: unknown, generation: unknown, requestJson: unknown, confirmedProfileId: unknown, storageOwnerKey?: unknown): Promise<IParadisPageOverridesResult>;
	/** タブの保存領域が、呼んだペイン専用か・エージェントのプロファイルか・それ以外か。 */
	describeExactViewStorage(descriptor: unknown, ownerKey: unknown, storageOwnerKey?: unknown): Promise<IParadisPageStorageDescription>;
	/** タブに掛かっている上書きの要約（値とパスワードは含まない）。 */
	getExactViewPageOverrides(descriptor: unknown, ownerKey: unknown): Promise<IParadisPageOverridesResult>;
	/** 持ち主の共有が入れ替わった。`generation` より前に掛けたものを外す。 */
	releasePageOverridesOwner(ownerKey: unknown, generation: unknown): Promise<void>;
	/** タブを PDF にしてダウンロードのフォルダへ置く。`optionsJson` は {@link IParadisPdfOptions}。 */
	printExactViewToPdf(descriptor: unknown, optionsJson: unknown): Promise<IParadisPdfResult>;
	/** このタブで次に始まるダウンロードを待つと登録する。登録の id（タブが無ければ null）。 */
	expectExactViewDownload(descriptor: unknown, startTimeoutMs: unknown): Promise<string | null>;
	/** 登録したダウンロードが始まって終わるのを待つ。 */
	awaitExactViewDownload(expectationId: unknown, settleTimeoutMs: unknown): Promise<IParadisAgentDownloadResult>;
	/** 登録したダウンロードを待つのをやめる。 */
	cancelExactViewDownload(expectationId: unknown): Promise<void>;
	/** ハイライトを出す（`rect` が null なら消す）。 */
	highlightExactView(descriptor: unknown, rect: unknown, durationMs: unknown): Promise<boolean>;
	/**
	 * 遷移・再読み込みの後も動くスクリプトをタブに置く。`requestJson` は {@link IParadisInitScriptRequest}。
	 * 持ち主の共有が入れ替わる・タブを手放す・タブが閉じると外れる。
	 */
	addExactViewInitScript(descriptor: unknown, ownerKey: unknown, generation: unknown, requestJson: unknown): Promise<IParadisInitScriptsResult>;
	/** 持ち主が置いたスクリプトを外す（`id` が null ならすべて）。 */
	removeExactViewInitScripts(descriptor: unknown, ownerKey: unknown, id: unknown): Promise<IParadisInitScriptsResult>;
	/** 持ち主がタブに置いているスクリプトの一覧。 */
	listExactViewInitScripts(descriptor: unknown, ownerKey: unknown): Promise<IParadisInitScriptsResult>;
}

// --- 資格情報を表示に出さない -------------------------------------------------------------------

/** 資格情報を引数に持つツール（MCP のサーバー名が前に付いていても当てる）。 */
const PARADIS_SECRET_BEARING_TOOL = /(?:^|__|\.|\/)set_http_credentials$/;
const PARADIS_HIDDEN_SECRET = '[hidden]';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ツールの入力から資格情報（set_http_credentials の password）を伏せた写しを返す。
 * hook の tool_input・会話の記録の tool_use をモバイルやデスクトップの画面へ出す前に通す。
 * 該当しない入力はそのまま返す。
 */
export function paradisRedactToolInputSecrets(toolName: unknown, input: unknown): unknown {
	if (typeof toolName !== 'string' || !PARADIS_SECRET_BEARING_TOOL.test(toolName) || !isObjectRecord(input) || input.password === undefined) {
		return input;
	}
	return { ...input, password: PARADIS_HIDDEN_SECRET };
}

/** JSON 文字列のツールの引数（Codex の function_call）から資格情報を伏せる。読めなければ全体を伏せる。 */
export function paradisRedactToolArgumentsText(toolName: unknown, argumentsText: string): string {
	if (typeof toolName !== 'string' || !PARADIS_SECRET_BEARING_TOOL.test(toolName)) {
		return argumentsText;
	}
	try {
		return JSON.stringify(paradisRedactToolInputSecrets(toolName, JSON.parse(argumentsText)));
	} catch {
		return PARADIS_HIDDEN_SECRET;
	}
}
