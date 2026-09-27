/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Chromium 系ブラウザの Cookie DB を「読む」node 層。復号のアルゴリズムだけをここに置き、鍵の
// 取得（キーチェーンの確認ダイアログが出る）と取り込み先セッションへの書き込みは electron-main
// 側が持つ。テストはこのファイルの関数を、合成した Cookie DB と既知の鍵で直接叩く。
//
// 安全の決め事（実装で守っていること）:
//  - Cookie DB はロック中でも読めるよう、userData の下へ 0600 で一時コピーして読み、終わったら消す。
//  - 復号した値はこの層から外へ返すだけで、ログ・例外メッセージには載せない。
//  - 期限切れ・接頭辞規則違反の Cookie は写さない。

import type { Database } from '@vscode/sqlite3';
import { createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'crypto';
import { chmod, copyFile, mkdir, readFile, rm, stat } from 'fs/promises';
import { homedir, platform as osPlatform } from 'os';
import { join } from '../../../../base/common/path.js';
import {
	IParadisImportBrowser,
	IParadisImportBrowserProfile,
	ParadisImportBrowserId,
	paradisChromiumExpiry,
	paradisChromiumSameSite,
	paradisCookieHostToDomain,
	paradisCookiePrefixRulesOk,
	paradisCookieSetUrl,
	ParadisElectronSameSite,
	paradisIsDomainCookie,
	paradisIsGoogleSignInHost,
} from '../common/paradisBrowserLoginImport.js';

// #region ブラウザカタログ（プラットフォーム別のパスと鍵の在りか）

/** カタログ1件。パスは userData ルート（Local State やプロファイルディレクトリの親）を指す。 */
interface IParadisBrowserCatalogEntry {
	readonly id: ParadisImportBrowserId;
	readonly label: string;
	/** macOS の `~/Library/Application Support/` からの相対パス。 */
	readonly macRelative: string;
	/** キーチェーンの Safe Storage 項目（service, account）。macOS のみ。 */
	readonly keychain: { readonly service: string; readonly account: string };
	/** Windows の `%LOCALAPPDATA%\` からの相対パス。 */
	readonly winRelative: string;
	/** Linux の `~/.config/` からの相対パス。 */
	readonly linuxRelative: string;
}

const PARADIS_BROWSER_CATALOG: readonly IParadisBrowserCatalogEntry[] = [
	{ id: 'chrome', label: 'Google Chrome', macRelative: 'Google/Chrome', keychain: { service: 'Chrome Safe Storage', account: 'Chrome' }, winRelative: 'Google\\Chrome\\User Data', linuxRelative: 'google-chrome' },
	{ id: 'edge', label: 'Microsoft Edge', macRelative: 'Microsoft Edge', keychain: { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' }, winRelative: 'Microsoft\\Edge\\User Data', linuxRelative: 'microsoft-edge' },
	{ id: 'brave', label: 'Brave', macRelative: 'BraveSoftware/Brave-Browser', keychain: { service: 'Brave Safe Storage', account: 'Brave' }, winRelative: 'BraveSoftware\\Brave-Browser\\User Data', linuxRelative: 'BraveSoftware/Brave-Browser' },
	{ id: 'arc', label: 'Arc', macRelative: 'Arc/User Data', keychain: { service: 'Arc Safe Storage', account: 'Arc' }, winRelative: 'Arc\\User Data', linuxRelative: 'Arc/User Data' },
	{ id: 'vivaldi', label: 'Vivaldi', macRelative: 'Vivaldi', keychain: { service: 'Vivaldi Safe Storage', account: 'Vivaldi' }, winRelative: 'Vivaldi\\User Data', linuxRelative: 'vivaldi' },
	{ id: 'chromium', label: 'Chromium', macRelative: 'Chromium', keychain: { service: 'Chromium Safe Storage', account: 'Chromium' }, winRelative: 'Chromium\\User Data', linuxRelative: 'chromium' },
];

/** 実行環境（テストから差し替えられるように引数で受ける）。 */
export interface IParadisChromiumEnvironment {
	readonly platform: NodeJS.Platform;
	readonly homeDir: string;
	/** macOS 以外の `%LOCALAPPDATA%` / XDG など。省略時は既定パスを組み立てる。 */
	readonly localAppData?: string;
}

/** 既定の実行環境（本番）。 */
export function paradisDefaultChromiumEnvironment(): IParadisChromiumEnvironment {
	return { platform: osPlatform(), homeDir: homedir(), localAppData: process.env['LOCALAPPDATA'] };
}

/** そのブラウザの userData ルート（Local State が置かれる場所）を返す。 */
export function paradisChromiumUserDataRoot(entry: IParadisBrowserCatalogEntry, env: IParadisChromiumEnvironment): string {
	switch (env.platform) {
		case 'darwin':
			return join(env.homeDir, 'Library', 'Application Support', entry.macRelative);
		case 'win32':
			return join(env.localAppData ?? join(env.homeDir, 'AppData', 'Local'), entry.winRelative);
		default:
			return join(env.homeDir, '.config', entry.linuxRelative);
	}
}

// #endregion

// #region プロファイル・DB パス・暗号化方式の判定

interface IParadisLocalState {
	readonly infoCache: ReadonlyMap<string, string>;
	/** os_crypt.encrypted_key（Base64）。macOS では通常空でキーチェーン側にある。 */
	readonly hasEncryptedKey: boolean;
	/** Windows の app-bound encryption（Chrome/Edge 140+）。true なら大半を取り込めない。 */
	readonly appBound: boolean;
}

async function paradisReadLocalState(userDataRoot: string): Promise<IParadisLocalState | undefined> {
	try {
		const raw = await readFile(join(userDataRoot, 'Local State'), 'utf8');
		const parsed = JSON.parse(raw) as {
			profile?: { info_cache?: Record<string, { name?: string }> };
			os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string };
		};
		const infoCache = new Map<string, string>();
		for (const [dir, info] of Object.entries(parsed.profile?.info_cache ?? {})) {
			if (typeof info?.name === 'string' && info.name.length > 0) {
				infoCache.set(dir, info.name);
			}
		}
		return {
			infoCache,
			hasEncryptedKey: typeof parsed.os_crypt?.encrypted_key === 'string',
			appBound: typeof parsed.os_crypt?.app_bound_encrypted_key === 'string',
		};
	} catch {
		return undefined;
	}
}

/** `<profileDir>/Network/Cookies`（新）→ `<profileDir>/Cookies`（旧）の順で存在するパスを返す。 */
async function paradisCookieDbPath(userDataRoot: string, profileDir: string): Promise<string | undefined> {
	const candidates = [join(userDataRoot, profileDir, 'Network', 'Cookies'), join(userDataRoot, profileDir, 'Cookies')];
	for (const candidate of candidates) {
		try {
			if ((await stat(candidate)).isFile()) {
				return candidate;
			}
		} catch {
			// 次の候補へ。
		}
	}
	return undefined;
}

/**
 * ブラウザ1つ分を列挙する。存在するプロファイルとその表示名、取り込み不可の理由を組み立てる。
 * ここでは鍵を読まない（キーチェーンの確認ダイアログを出さない）。
 */
export async function paradisResolveBrowser(entry: IParadisBrowserCatalogEntry, env: IParadisChromiumEnvironment): Promise<IParadisImportBrowser | undefined> {
	const userDataRoot = paradisChromiumUserDataRoot(entry, env);
	const localState = await paradisReadLocalState(userDataRoot);
	if (!localState) {
		return undefined; // 未インストール（Local State が無い）。
	}

	const profiles: IParadisImportBrowserProfile[] = [];
	for (const [dir, name] of localState.infoCache) {
		if (await paradisCookieDbPath(userDataRoot, dir)) {
			profiles.push({ directory: dir, label: name });
		}
	}
	// info_cache に無くても Default に Cookie があることがある（初期状態）。
	if (profiles.length === 0 && await paradisCookieDbPath(userDataRoot, 'Default')) {
		profiles.push({ directory: 'Default', label: localState.infoCache.get('Default') ?? 'Default' });
	}
	if (profiles.length === 0) {
		return undefined;
	}

	let unsupportedReason: string | undefined;
	if (env.platform === 'win32' && localState.appBound) {
		unsupportedReason = 'Windows の Chrome / Edge 140 以降は暗号化の方式（app-bound encryption）が変わり、Para Code からは取り込めません。';
	} else if (env.platform === 'win32') {
		unsupportedReason = 'Windows からの取り込みは現在サポートしていません。';
	} else if (env.platform === 'linux') {
		unsupportedReason = 'Linux からの取り込みは現在サポートしていません。';
	}

	return { id: entry.id, label: entry.label, profiles, ...(unsupportedReason ? { unsupportedReason } : {}) };
}

/** 対応する全ブラウザを列挙する。 */
export async function paradisResolveBrowsers(env: IParadisChromiumEnvironment): Promise<IParadisImportBrowser[]> {
	const resolved: IParadisImportBrowser[] = [];
	for (const entry of PARADIS_BROWSER_CATALOG) {
		const browser = await paradisResolveBrowser(entry, env);
		if (browser) {
			resolved.push(browser);
		}
	}
	return resolved;
}

/** カタログ引き（電子メイン側が鍵の在りか・パスを解くために使う）。 */
export function paradisBrowserCatalogEntry(id: ParadisImportBrowserId): IParadisBrowserCatalogEntry | undefined {
	return PARADIS_BROWSER_CATALOG.find(entry => entry.id === id);
}

// #endregion

// #region DB の一時コピーと読み取り

/**
 * ロック中でも読めるよう、Cookie DB を 0600 の一時ファイルへコピーして、そのパスと後始末関数を返す。
 * WAL/journal の同居ファイルも一緒に写す（写さないと未フラッシュの行が欠ける）。
 * コピー先は `userData/paracode-cookie-import-<rand>/` の下に置き、終わったらディレクトリごと消す。
 */
export async function paradisCopyCookieDb(sourceDbPath: string, userDataPath: string): Promise<{ readonly path: string; readonly dispose: () => Promise<void> }> {
	const scratchDir = join(userDataPath, `paracode-cookie-import-${randomBytes(8).toString('hex')}`);
	await mkdir(scratchDir, { recursive: true, mode: 0o700 });
	const destPath = join(scratchDir, 'Cookies');
	await copyFile(sourceDbPath, destPath);
	await chmod(destPath, 0o600);
	for (const suffix of ['-wal', '-journal', '-shm']) {
		try {
			await copyFile(`${sourceDbPath}${suffix}`, `${destPath}${suffix}`);
			await chmod(`${destPath}${suffix}`, 0o600);
		} catch {
			// その同居ファイルが無いだけ。
		}
	}
	return {
		path: destPath,
		dispose: () => rm(scratchDir, { recursive: true, force: true }).catch(() => undefined),
	};
}

/** Cookie DB の1行（暗号化された値そのものを持つ。復号前）。 */
export interface IParadisRawCookieRow {
	readonly hostKey: string;
	readonly name: string;
	readonly path: string;
	readonly isSecure: boolean;
	readonly isHttpOnly: boolean;
	readonly sameSite: number;
	readonly expiresUtc: number;
	readonly encryptedValue: Buffer;
	readonly plainValue: string;
}

/** Cookie DB の生の行（列名は Chromium のスキーマそのまま）。 */
interface IParadisSqliteCookieRow {
	readonly host_key?: string;
	readonly name?: string;
	readonly value?: string;
	readonly path?: string;
	readonly is_secure?: number;
	readonly is_httponly?: number;
	readonly samesite?: number;
	readonly expires_utc?: number;
	readonly encrypted_value?: Buffer;
}

/** Cookie DB を読み取り専用で開き、必要な列だけ取り出す。復号はしない。 */
export async function paradisReadCookieRows(dbPath: string): Promise<IParadisRawCookieRow[]> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const database: Database = await new Promise((resolve, reject) => {
		const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(db));
	});
	try {
		const rows = await new Promise<IParadisSqliteCookieRow[]>((resolve, reject) => {
			database.all(
				'SELECT host_key, name, value, path, is_secure, is_httponly, samesite, expires_utc, encrypted_value FROM cookies',
				(error, result) => error ? reject(error) : resolve(result as IParadisSqliteCookieRow[]),
			);
		});
		return rows.map(row => ({
			hostKey: String(row.host_key ?? ''),
			name: String(row.name ?? ''),
			path: String(row.path ?? '/'),
			isSecure: Number(row.is_secure ?? 0) !== 0,
			isHttpOnly: Number(row.is_httponly ?? 0) !== 0,
			sameSite: Number(row.samesite ?? -1),
			expiresUtc: Number(row.expires_utc ?? 0),
			encryptedValue: Buffer.isBuffer(row.encrypted_value) ? row.encrypted_value : Buffer.alloc(0),
			plainValue: typeof row.value === 'string' ? row.value : '',
		}));
	} finally {
		await new Promise<void>(resolve => database.close(() => resolve()));
	}
}

// #endregion

// #region 復号（macOS の v10）

/** macOS の Safe Storage パスワードから AES-128 鍵を導出する（PBKDF2 saltysalt / 1003回 / SHA1）。 */
export function paradisDeriveMacCookieKey(safeStoragePassword: string): Buffer {
	return pbkdf2Sync(safeStoragePassword, 'saltysalt', 1003, 16, 'sha1');
}

/** 復号後の平文の先頭に付く 32 バイト（Chromium 127+ の HMAC / schema 24+ のドメインハッシュ）。 */
const CHROMIUM_COOKIE_PREFIX_LEN = 32;

/**
 * 平文の先頭 32 バイトが「そのドメインの SHA-256」か（DB schema 24+）。空値のときは平文が
 * ハッシュだけになるので、一致しても長さで value 扱いへ倒れる（下の {@link paradisStripCookiePrefix}）。
 */
function paradisHasHostKeyHashPrefix(plaintext: Buffer, hostKey: string): boolean {
	return plaintext.length >= CHROMIUM_COOKIE_PREFIX_LEN
		&& plaintext.subarray(0, CHROMIUM_COOKIE_PREFIX_LEN).equals(createHash('sha256').update(hostKey).digest());
}

/**
 * 平文の先頭 32 バイトが Chromium 127+ の HMAC 接頭辞か（ハッシュは約半分が非印字なので、
 * 先頭 32 バイトに非印字が 8 個以上あれば接頭辞と判断する）。
 */
function paradisHasHmacPrefix(plaintext: Buffer): boolean {
	if (plaintext.length <= CHROMIUM_COOKIE_PREFIX_LEN) {
		return false;
	}
	let nonPrintable = 0;
	for (let i = 0; i < CHROMIUM_COOKIE_PREFIX_LEN; i++) {
		if (plaintext[i] < 0x20 || plaintext[i] > 0x7e) {
			nonPrintable++;
		}
	}
	return nonPrintable >= 8;
}

/** 付いていれば先頭 32 バイトを剥がす。付いていなければそのまま返す。 */
export function paradisStripCookiePrefix(plaintext: Buffer, hostKey: string): Buffer {
	return paradisHasHostKeyHashPrefix(plaintext, hostKey) || paradisHasHmacPrefix(plaintext)
		? plaintext.subarray(CHROMIUM_COOKIE_PREFIX_LEN)
		: plaintext;
}

/**
 * v10 形式の暗号化 Cookie を復号する。
 *
 * - 先頭 3 バイトは 'v10'。残りが AES-128-CBC の暗号文（IV は 16 個の空白）。PKCS#7 パディング。
 * - 復号後、新しめの Chrome は「そのドメインの SHA-256」または HMAC の 32 バイトを平文の先頭に
 *   付ける。付いていれば剥がす（{@link paradisStripCookiePrefix}）。
 * - 復号に失敗した値は `undefined`。値そのものはここでも呼び出し側でもログに出さない。
 */
export function paradisDecryptCookieValueV10(encryptedValue: Buffer, macKey: Buffer, hostKey: string): string | undefined {
	if (encryptedValue.length < 3 || encryptedValue.subarray(0, 3).toString('ascii') !== 'v10') {
		// 平文（暗号化されていない）や app-bound（v20）Cookie はこの経路では扱わない。
		return undefined;
	}
	const ciphertext = encryptedValue.subarray(3);
	if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
		return undefined;
	}
	try {
		const iv = Buffer.alloc(16, ' ');
		const decipher = createDecipheriv('aes-128-cbc', macKey, iv);
		decipher.setAutoPadding(true);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		return paradisStripCookiePrefix(plaintext, hostKey).toString('utf8');
	} catch {
		return undefined;
	}
}

// #endregion

// #region ドメイン集計・取り込み用の正規化

/** ドメイン集計（復号しない）。Google のサインインホストは importable=false にする。 */
export function paradisGroupCookieDomains(rows: readonly IParadisRawCookieRow[], nowSeconds: number = Date.now() / 1000): Map<string, { count: number; importable: boolean; reason?: string }> {
	const groups = new Map<string, { count: number; importable: boolean; reason?: string }>();
	for (const row of rows) {
		if (paradisChromiumExpiry(row.expiresUtc, nowSeconds).kind === 'expired') {
			continue;
		}
		const domain = paradisCookieHostToDomain(row.hostKey);
		if (domain.length === 0) {
			continue;
		}
		const existing = groups.get(domain);
		if (existing) {
			existing.count++;
			continue;
		}
		groups.set(domain, paradisIsGoogleSignInHost(row.hostKey)
			? { count: 1, importable: false, reason: 'Google のログインは取り込めません' }
			: { count: 1, importable: true });
	}
	return groups;
}

/** 取り込み先へ書ける形にした Cookie（Electron の `cookies.set` にそのまま渡せる）。 */
export interface IParadisImportableCookie {
	readonly url: string;
	readonly name: string;
	readonly value: string;
	readonly domain?: string;
	readonly path: string;
	readonly secure: boolean;
	readonly httpOnly: boolean;
	readonly sameSite: ParadisElectronSameSite;
	readonly expirationDate?: number;
}

/**
 * 1行を「取り込める Cookie」へ変換する。取り込めない場合（期限切れ・接頭辞規則違反・Google・
 * 選択外ドメイン・復号失敗）は `undefined`。復号は渡された関数に委ねる（テストで差し替え可能）。
 */
export function paradisToImportableCookie(
	row: IParadisRawCookieRow,
	selectedDomains: ReadonlySet<string>,
	decrypt: (row: IParadisRawCookieRow) => string | undefined,
	nowSeconds: number = Date.now() / 1000,
): IParadisImportableCookie | undefined {
	const domain = paradisCookieHostToDomain(row.hostKey);
	if (!selectedDomains.has(domain) || paradisIsGoogleSignInHost(row.hostKey)) {
		return undefined;
	}
	const expiry = paradisChromiumExpiry(row.expiresUtc, nowSeconds);
	if (expiry.kind === 'expired') {
		return undefined;
	}
	const domainCookie = paradisIsDomainCookie(row.hostKey);
	if (!paradisCookiePrefixRulesOk(row.name, { secure: row.isSecure, path: row.path, domainCookie })) {
		return undefined;
	}
	const value = decrypt(row);
	if (value === undefined) {
		return undefined;
	}
	return {
		url: paradisCookieSetUrl(row.hostKey, row.path, row.isSecure),
		name: row.name,
		value,
		...(domainCookie ? { domain: row.hostKey } : {}),
		path: row.path,
		secure: row.isSecure,
		httpOnly: row.isHttpOnly,
		sameSite: paradisChromiumSameSite(row.sameSite),
		...(expiry.kind === 'active' ? { expirationDate: expiry.expirationDate } : {}),
	};
}

// #endregion
