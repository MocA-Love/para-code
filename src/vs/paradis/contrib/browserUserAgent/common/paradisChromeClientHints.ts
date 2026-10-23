/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの User-Agent Client Hints（`navigator.userAgentData` と `Sec-CH-UA` 系のヘッダー）を、
// 同じ版の Google Chrome と同じ値にするための純粋関数。
//
// Electron は Chromium の無印ビルドなので、brands に "Google Chrome" が入らない（`Chromium` と GREASE の
// 2 つだけ）。UA の文字列は Chrome を名乗るのに brands が食い違うと、Google のログインなどで
// 「埋め込みのブラウザ」と見なされる。並びと GREASE の文字は Chromium の
// `components/embedder_support/user_agent_utils.cc`（GenerateBrandVersionList /
// GetGreasedUserAgentBrandVersion / GetRandomOrder、Chromium 150）と同じ計算で作る。
// electron-main（CDP とヘッダー）と node（CDP ゲートウェイ）の両方から使うので common に置く。

/** CDP の `Emulation.UserAgentBrandVersion` と同じ形。 */
export interface IParadisUserAgentBrandVersion {
	readonly brand: string;
	readonly version: string;
}

/**
 * CDP の `Emulation.UserAgentMetadata` と同じ形。brands 以外（platform・platformVersion・architecture など）は
 * Electron がその PC で出している本来の値をそのまま使う。
 */
export interface IParadisUserAgentMetadata {
	readonly brands: readonly IParadisUserAgentBrandVersion[];
	readonly fullVersionList: readonly IParadisUserAgentBrandVersion[];
	readonly fullVersion: string;
	readonly platform: string;
	readonly platformVersion: string;
	readonly architecture: string;
	readonly model: string;
	readonly mobile: boolean;
	readonly bitness: string;
	readonly wow64: boolean;
	readonly formFactors: readonly string[];
}

/** `navigator.userAgentData.getHighEntropyValues()` から取る、brands 以外の本来の値。 */
export type IParadisNativeClientHints = Omit<IParadisUserAgentMetadata, 'brands' | 'fullVersionList' | 'fullVersion'>;

/** 本来の値を取るときに `getHighEntropyValues()` へ渡す名前。 */
export const PARADIS_NATIVE_CLIENT_HINT_NAMES: readonly string[] = ['platformVersion', 'architecture', 'model', 'bitness', 'wow64', 'formFactors'];

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const THREE_ORDERS: readonly (readonly number[])[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/**
 * Google Chrome の brands と fullVersionList を返す。`fullVersion` は `150.0.7871.250` の形
 * （Electron の `process.versions.chrome`）。解釈できない版なら undefined。
 */
export function paradisChromeBrandLists(fullVersion: string): { readonly brands: readonly IParadisUserAgentBrandVersion[]; readonly fullVersionList: readonly IParadisUserAgentBrandVersion[] } | undefined {
	const match = /^(?<major>\d+)(?:\.\d+){3}$/.exec(fullVersion);
	if (!match?.groups) {
		return undefined;
	}
	const majorVersion = match.groups.major;
	const seed = Number(majorVersion);
	const greaseBrand = `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`;
	const greaseMajor = GREASE_VERSIONS[seed % GREASE_VERSIONS.length];
	const order = THREE_ORDERS[seed % THREE_ORDERS.length];
	const shuffle = (list: IParadisUserAgentBrandVersion[]): IParadisUserAgentBrandVersion[] => {
		const shuffled: IParadisUserAgentBrandVersion[] = new Array(list.length);
		for (let i = 0; i < list.length; i++) {
			shuffled[order[i]] = list[i];
		}
		return shuffled;
	};
	return {
		brands: shuffle([
			{ brand: greaseBrand, version: greaseMajor },
			{ brand: 'Chromium', version: majorVersion },
			{ brand: 'Google Chrome', version: majorVersion },
		]),
		fullVersionList: shuffle([
			{ brand: greaseBrand, version: `${greaseMajor}.0.0.0` },
			{ brand: 'Chromium', version: fullVersion },
			{ brand: 'Google Chrome', version: fullVersion },
		]),
	};
}

/** CDP の `setUserAgentOverride` に渡す metadata を組み立てる。 */
export function paradisChromeUserAgentMetadata(fullVersion: string, native: IParadisNativeClientHints): IParadisUserAgentMetadata | undefined {
	const lists = paradisChromeBrandLists(fullVersion);
	if (!lists) {
		return undefined;
	}
	return { ...lists, fullVersion, ...native };
}

/**
 * `getHighEntropyValues()` の戻り値を本来の値として読む。足りない・型が違うときは undefined
 * （CDP は platform・platformVersion・architecture・model を必須にしているので、推測で埋めない）。
 */
export function paradisReadNativeClientHints(value: unknown): IParadisNativeClientHints | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.platform !== 'string' || typeof v.platformVersion !== 'string' || typeof v.architecture !== 'string' || typeof v.model !== 'string' || typeof v.mobile !== 'boolean') {
		return undefined;
	}
	const formFactors = Array.isArray(v.formFactors) && v.formFactors.every(f => typeof f === 'string') ? v.formFactors as string[] : ['Desktop'];
	return {
		platform: v.platform,
		platformVersion: v.platformVersion,
		architecture: v.architecture,
		model: v.model,
		mobile: v.mobile,
		bitness: typeof v.bitness === 'string' ? v.bitness : '64',
		wow64: v.wow64 === true,
		formFactors,
	};
}

/** `Sec-CH-UA` / `Sec-CH-UA-Full-Version-List` の値（structured header の文字列リスト）にする。 */
export function paradisSerializeClientHintBrands(list: readonly IParadisUserAgentBrandVersion[]): string {
	const quote = (s: string) => `"${s.replace(/[\\"]/g, c => `\\${c}`)}"`;
	return list.map(({ brand, version }) => `${quote(brand)};v=${quote(version)}`).join(', ');
}

/**
 * リクエストヘッダーのうち brands を表す 3 つ（`sec-ch-ua`・`sec-ch-ua-full-version-list`・
 * `sec-ch-ua-full-version`）を Google Chrome の値に置き換える。既にあるものだけを置き換え、無いものは足さない
 * （高エントロピーのヒントはサイトが `Accept-CH` で求めたときだけ送られるため）。
 *
 * 置き換えるのは User-Agent が `expectedUserAgent`（この内蔵ブラウザが名乗る UA）と同じとき、または Electron の
 * 既定の UA（`Electron/` 入り）のとき。後者は Service Worker のリクエストで、Electron はセッションの UA ではなく
 * アプリ全体の既定の UA を付けるので、User-Agent もこの内蔵ブラウザの UA に直す。
 * デバイスのエミュレーション（スマホの UA など）中のリクエストは、その UA に合った値のまま残す。
 * `rewriteDefaultUserAgent` が false のとき（端末のエミュレーション中）は、後者を直さない。
 * 変えるものが無ければ undefined。
 */
export function paradisRewriteClientHintHeaders(headers: Record<string, string>, expectedUserAgent: string, fullVersion: string, rewriteDefaultUserAgent = true): Record<string, string> | undefined {
	const userAgentKey = Object.keys(headers).find(k => k.toLowerCase() === 'user-agent');
	if (!userAgentKey || (headers[userAgentKey] !== expectedUserAgent && !(rewriteDefaultUserAgent && /\sElectron\//.test(headers[userAgentKey])))) {
		return undefined;
	}
	const lists = paradisChromeBrandLists(fullVersion);
	if (!lists) {
		return undefined;
	}
	const replacements: Record<string, string> = {
		'sec-ch-ua': paradisSerializeClientHintBrands(lists.brands),
		'sec-ch-ua-full-version-list': paradisSerializeClientHintBrands(lists.fullVersionList),
		'sec-ch-ua-full-version': `"${fullVersion}"`,
	};
	let next: Record<string, string> | undefined;
	if (headers[userAgentKey] !== expectedUserAgent) {
		next = { ...headers, [userAgentKey]: expectedUserAgent };
	}
	for (const key of Object.keys(headers)) {
		const replacement = replacements[key.toLowerCase()];
		if (replacement !== undefined && headers[key] !== replacement) {
			next ??= { ...headers };
			next[key] = replacement;
		}
	}
	return next;
}

const USER_AGENT_OVERRIDE_METHODS = new Set(['Network.setUserAgentOverride', 'Emulation.setUserAgentOverride']);

/**
 * LLM のブラウザ操作（chrome-devtools-mcp の puppeteer）は、接続するたびに `Network.setUserAgentOverride` で
 * Electron の既定の UA（`Electron/` 入り・Client Hints 無し）を送る。そのまま通すと、Para Code が付けた
 * Chrome の UA と Client Hints がそのタブで上書きされる。
 *
 * そこで、`Electron/` を含む UA の上書きは「この接続では上書きしない」（空の UA。Chromium はその接続の上書きを
 * 外し、Para Code が付けた値に戻る）へ置き換える。LLM が自分で選んだ UA（スマホなど）はそのまま通す。
 * 置き換えが要らなければ undefined。
 */
export function paradisNeutralizeDefaultUserAgentOverride(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!USER_AGENT_OVERRIDE_METHODS.has(method) || typeof params?.userAgent !== 'string' || !/\sElectron\//.test(params.userAgent)) {
		return undefined;
	}
	return typeof params.acceptLanguage === 'string' ? { userAgent: '', acceptLanguage: params.acceptLanguage } : { userAgent: '' };
}
