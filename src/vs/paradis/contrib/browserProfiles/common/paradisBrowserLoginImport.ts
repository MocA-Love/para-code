/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 他のブラウザ（Chromium 系）からログイン状態を取り込む機能の、renderer ⇔ electron-main 契約と
// プラットフォーム非依存の純粋関数。
//
// ここには「鍵」も「復号した値」も一切通さない。鍵の取得と復号は electron-main / node 層に閉じ、
// この共通層が扱うのは「どのブラウザ・どのプロファイル・どのドメインか」という選択情報と、
// 取り込む Cookie の属性（secure/httpOnly/sameSite/期限/名前接頭辞の規則）を正しく写すための
// 判定だけ。UI（renderer）とサービス（main）はこのファイルの型でだけやり取りする。

/** main 側チャネル名（プロファイル本体の {@link PARADIS_BROWSER_PROFILE_CHANNEL} とは別に立てる）。 */
export const PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL = 'paradisBrowserLoginImport';

/** 取り込み元として対応する Chromium 系ブラウザの識別子。 */
export type ParadisImportBrowserId = 'chrome' | 'edge' | 'brave' | 'arc' | 'vivaldi' | 'chromium';

/** そのプラットフォームで取り込みが技術的に不可能な理由（UI がそのまま出せる日本語）。 */
export type ParadisImportUnsupportedReason = string;

/** 取り込み元ブラウザ1つ分。プロファイルまで含めて main が列挙する（鍵は読まない）。 */
export interface IParadisImportBrowser {
	readonly id: ParadisImportBrowserId;
	/** 表示名（"Google Chrome" 等）。 */
	readonly label: string;
	/** そのブラウザのプロファイル（Default / Profile 1 …）。空なら未インストール。 */
	readonly profiles: readonly IParadisImportBrowserProfile[];
	/**
	 * このブラウザから取り込めない理由（あれば）。Windows の app-bound encryption（Chrome/Edge
	 * 140+）や、鍵の方式が未対応のときに入る。`undefined` なら取り込める。
	 */
	readonly unsupportedReason?: ParadisImportUnsupportedReason;
}

/** 取り込み元ブラウザのプロファイル1つ分。 */
export interface IParadisImportBrowserProfile {
	/** ディレクトリ名（"Default" / "Profile 1"）。取り込みリクエストのキー。 */
	readonly directory: string;
	/** 表示名（Local State の info_cache 由来。無ければディレクトリ名）。 */
	readonly label: string;
}

/** {@link IParadisBrowserLoginImportMainService.listSources} の戻り。 */
export interface IParadisImportSourceListing {
	readonly browsers: readonly IParadisImportBrowser[];
}

/** 取り込み候補のドメイン1件（＝Cookie の host_key を先頭ドット除去でまとめたもの）。 */
export interface IParadisImportDomainGroup {
	/** 表示・選択キー（例 "github.com"）。先頭ドットは落としてある。 */
	readonly domain: string;
	/** そのドメインの Cookie 件数（期限切れは数えない）。 */
	readonly cookieCount: number;
	/** 取り込めるか。Google のサインインドメイン等は false。 */
	readonly importable: boolean;
	/** 取り込めない場合の短い理由（UI のグレーアウト脇に出す）。 */
	readonly reason?: string;
}

/** {@link IParadisBrowserLoginImportMainService.listDomains} の戻り。 */
export interface IParadisImportDomainListing {
	readonly domains: readonly IParadisImportDomainGroup[];
	/**
	 * このプロファイル全体が取り込み不可な理由（あれば）。ドメイン一覧は空になる。
	 * Windows の app-bound encryption 等で立つ。
	 */
	readonly unsupportedReason?: ParadisImportUnsupportedReason;
	/**
	 * 取り込み実行時にキーチェーンの確認ダイアログが出るか（macOS で true）。UI は取り込む前に
	 * 「今回だけ許可を押してください」という案内を出すのに使う。
	 */
	readonly needsKeychainConsent: boolean;
}

/** 取り込みリクエスト。ユーザーが選んだ範囲だけを載せる。 */
export interface IParadisImportRequest {
	readonly browserId: ParadisImportBrowserId;
	/** 取り込み元プロファイルのディレクトリ名。 */
	readonly sourceDirectory: string;
	/** 取り込み先。**名前付きプロファイルの id だけ**（global/workspace/ephemeral は渡さない）。 */
	readonly destinationProfileId: string;
	/** 取り込むドメイン（{@link IParadisImportDomainGroup.domain}）。空なら何もしない。 */
	readonly domains: readonly string[];
}

/** 取り込み結果。復号した値そのものは一切含めない（件数だけ）。 */
export interface IParadisImportResult {
	/** 取り込み先へ書けた Cookie の件数。 */
	readonly importedCookies: number;
	/** 少なくとも1件書けたドメインの数。 */
	readonly importedDomains: number;
	/** 期限切れ・接頭辞規則違反などで写さなかった件数。 */
	readonly skipped: number;
	/** 復号または書き込みに失敗したドメイン（UI が名前を出せるように）。 */
	readonly failedDomains: readonly string[];
	/** 取り込んだうち期限なし（セッション）Cookie の件数。再起動で消える場合があると案内するため。 */
	readonly sessionCookies?: number;
	/** 全体が失敗したときの理由（例: キーチェーンの許可が下りなかった）。 */
	readonly error?: string;
}

/**
 * main が公開する面。`ProxyChannel.fromService` でそのまま channel になる。
 *
 * **この面はユーザーの操作（内蔵ブラウザのプロファイルメニュー）からしか呼ばれない。**
 * MCP（エージェント）には一切公開しない。Cookie の読み書きをエージェントへ許さない既存方針を
 * 変えないため、renderer 側にもエージェントが辿れる導線を作らない。
 */
export interface IParadisBrowserLoginImportMainService {
	/** 取り込み元ブラウザとそのプロファイルを列挙する（鍵は読まない・確認ダイアログは出ない）。 */
	listSources(): Promise<IParadisImportSourceListing>;
	/** 選んだブラウザ・プロファイルのドメインと件数を返す（復号しない・確認ダイアログは出ない）。 */
	listDomains(browserId: ParadisImportBrowserId, sourceDirectory: string): Promise<IParadisImportDomainListing>;
	/** 実際に取り込む。ここで初めて鍵を読み（macOS は確認ダイアログ）、復号し、取り込み先へ書く。 */
	importCookies(request: IParadisImportRequest): Promise<IParadisImportResult>;
}

// #region 純粋関数（プラットフォーム非依存）

/** Chromium の `cookies.samesite` 列の値を Electron の `cookies.set` の値へ写す。 */
export type ParadisElectronSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict';

/**
 * Chromium の samesite（-1 unspecified / 0 none / 1 lax / 2 strict）を Electron の値へ。
 * 未知の値は 'unspecified' に倒す（元より緩めない）。
 */
export function paradisChromiumSameSite(value: number): ParadisElectronSameSite {
	switch (value) {
		case 0: return 'no_restriction';
		case 1: return 'lax';
		case 2: return 'strict';
		default: return 'unspecified';
	}
}

/** Windows FILETIME（1601-01-01 からのマイクロ秒）を Unix 秒へ。 */
const CHROMIUM_EPOCH_TO_UNIX_SECONDS = 11644473600;

/** {@link paradisChromiumExpiry} の結果（`kind` で判別する）。 */
export type ParadisCookieExpiry =
	| { readonly kind: 'session' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'active'; readonly expirationDate: number };

/**
 * Chromium の `expires_utc`（1601 からのマイクロ秒）を「取り込みに使う期限」へ変換する。
 * - `0` はセッション Cookie（期限なし）。`{ kind: 'session' }`。
 * - 既に過ぎている期限は `{ kind: 'expired' }`。呼び出し側は取り込まない。
 * - それ以外は `{ kind: 'active', expirationDate }`（Unix 秒。Electron の `expirationDate`）。
 */
export function paradisChromiumExpiry(expiresUtc: number, nowSeconds: number = Date.now() / 1000): ParadisCookieExpiry {
	if (!isFinite(expiresUtc) || expiresUtc <= 0) {
		return { kind: 'session' };
	}
	const unixSeconds = expiresUtc / 1_000_000 - CHROMIUM_EPOCH_TO_UNIX_SECONDS;
	if (unixSeconds <= nowSeconds) {
		return { kind: 'expired' };
	}
	return { kind: 'active', expirationDate: unixSeconds };
}

/** host_key（先頭ドットあり/なし）を表示・選択用のドメインへ正規化する。 */
export function paradisCookieHostToDomain(hostKey: string): string {
	return hostKey.replace(/^\./, '').toLowerCase();
}

/** その host_key がドメイン Cookie（先頭ドット付き＝サブドメインへも送る）か。 */
export function paradisIsDomainCookie(hostKey: string): boolean {
	return hostKey.startsWith('.');
}

/**
 * Google のログインが置かれるドメインか（登録可能ドメイン = eTLD+1 単位で判定）。
 *
 * Google のセッション本体（`SID` など）は `accounts.google.com` ではなく `.google.com` に
 * 置かれ、`.youtube.com` や国別の `.google.co.jp` にも写しがある。ホスト完全一致では漏れるので、
 * ブランドのラベル（`google` / `youtube` / `googleusercontent` / `gmail`）が登録可能ドメインの
 * SLD に来るものを、そのサブドメインごとすべて取り込み不可にする。過剰にブロックする側（安全側）に倒す。
 */
export function paradisIsGoogleLoginHost(host: string): boolean {
	const domain = paradisCookieHostToDomain(host);
	// 末尾が `<brand>.<tld>` または `<brand>.<ccSLD>.<cctld>`（google.co.jp / google.com.br 等）。
	return /(^|\.)(google|youtube|googleusercontent|gmail)\.([a-z]{2,4}\.)?[a-z]{2,}$/.test(domain);
}

/**
 * Google のログインセッションに使う Cookie 名か。ドメイン判定を擦り抜けた場合の二段目の網。
 * どちらか一方に当たれば取り込まない。
 */
const PARADIS_GOOGLE_LOGIN_COOKIE_NAMES: ReadonlySet<string> = new Set([
	'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LSID', 'OSID', 'ACCOUNT_CHOOSER', 'LOGIN_INFO',
	'__Host-GAPS', '__Host-1PLSID', '__Host-3PLSID',
]);

export function paradisIsGoogleLoginCookieName(name: string): boolean {
	return PARADIS_GOOGLE_LOGIN_COOKIE_NAMES.has(name)
		|| (name.startsWith('__Secure-') && /(PSID|PAPISID)/.test(name));
}

/** ホストか Cookie 名のどちらかが Google のログインに当たるか。 */
export function paradisIsGoogleLoginCookie(host: string, name: string): boolean {
	return paradisIsGoogleLoginHost(host) || paradisIsGoogleLoginCookieName(name);
}

/**
 * `__Host-` / `__Secure-` 接頭辞の規則を満たすか。満たさない Cookie は取り込み先で正しく
 * 設定できない（ブラウザ側で拒否される）ので写さない。
 * - `__Secure-`: Secure 必須。
 * - `__Host-`: Secure 必須・path は "/"・ドメイン Cookie でない（ホスト限定）こと。
 */
export function paradisCookiePrefixRulesOk(name: string, attrs: {
	readonly secure: boolean;
	readonly path: string;
	readonly domainCookie: boolean;
}): boolean {
	if (name.startsWith('__Host-')) {
		return attrs.secure && attrs.path === '/' && !attrs.domainCookie;
	}
	if (name.startsWith('__Secure-')) {
		return attrs.secure;
	}
	return true;
}

/** Chromium の `source_scheme` 列（2 = kSecure）。 */
export const PARADIS_CHROMIUM_SOURCE_SCHEME_SECURE = 2;

/**
 * Electron の `cookies.set` へ渡す url を作る。Secure Cookie、または元が https で設定された
 * Cookie（`source_scheme = 2`）は https、それ以外は http。scheme-bound cookie を壊さないため。
 * ドメイン Cookie（先頭ドット）はホスト部分をドット無しにし、`domain` 側で範囲を伝える。
 */
export function paradisCookieSetUrl(hostKey: string, path: string, secure: boolean, sourceScheme?: number): string {
	const https = secure || sourceScheme === PARADIS_CHROMIUM_SOURCE_SCHEME_SECURE;
	const host = paradisCookieHostToDomain(hostKey);
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return `${https ? 'https' : 'http'}://${host}${normalizedPath}`;
}

// #endregion
