/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 他ブラウザからのログイン取り込みの node 層テスト。合成した Chromium Cookie DB（既知の鍵で
// v10 暗号化）で、読み取り・macOS の復号（PBKDF2 saltysalt/1003 + AES-128-CBC）・属性の写し取り・
// 期限切れの除外・接頭辞規則・Google の除外・スキーマ版による接頭辞剥がしを確かめる。本物の
// ブラウザの DB もキーチェーンも一切読まない。

import assert from 'assert';
import type { Database } from '@vscode/sqlite3';
import { createCipheriv, createHash, pbkdf2Sync } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisChromiumExpiry,
	paradisChromiumSameSite,
	paradisCookiePrefixRulesOk,
	paradisCookieSetUrl,
	paradisIsGoogleLoginCookieName,
	paradisIsGoogleLoginHost,
} from '../../common/paradisBrowserLoginImport.js';
import {
	IParadisRawCookieRow,
	paradisDecryptCookieValueV10,
	paradisDeriveMacCookieKey,
	paradisGroupCookieDomains,
	paradisReadCookieDatabase,
	paradisResolveBrowsers,
	paradisToImportableCookie,
} from '../../node/paradisChromiumCookies.js';

const TEST_KEYCHAIN_PASSWORD = 'peanuts-test-safe-storage';
const CHROMIUM_EPOCH_TO_UNIX_SECONDS = 11644473600;

/** 実 Chromium と同じ手順で v10 暗号化する。`hostKey` を渡すとドメインハッシュを平文の先頭に付ける（版 24+）。 */
function encryptV10(value: string, password: string, hostKey?: string): Buffer {
	const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
	const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
	const prefix = hostKey ? createHash('sha256').update(hostKey).digest() : Buffer.alloc(0);
	return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])), cipher.final()]);
}

/** Unix 秒を Chromium の expires_utc（1601 からのマイクロ秒）へ。 */
function toExpiresUtc(unixSeconds: number): number {
	return (unixSeconds + CHROMIUM_EPOCH_TO_UNIX_SECONDS) * 1_000_000;
}

interface ITestCookieRow {
	readonly host_key: string;
	readonly name: string;
	readonly value?: string;
	readonly encrypted_value?: Buffer;
	readonly path?: string;
	readonly is_secure?: number;
	readonly is_httponly?: number;
	readonly samesite?: number;
	readonly expires_utc?: number;
	readonly source_scheme?: number;
	readonly top_frame_site_key?: string;
}

async function createCookieDb(dbPath: string, rows: readonly ITestCookieRow[], schemaVersion = 23): Promise<void> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const db: Database = await new Promise((resolve, reject) => {
		const database = new sqlite3.Database(dbPath, error => error ? reject(error) : resolve(database));
	});
	const run = (sql: string, params: unknown[] = []) => new Promise<void>((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
	try {
		await run(`CREATE TABLE meta (key TEXT NOT NULL UNIQUE, value TEXT)`);
		await run(`INSERT INTO meta (key, value) VALUES ('version', ?)`, [String(schemaVersion)]);
		await run(`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, source_scheme INTEGER DEFAULT 0, top_frame_site_key TEXT DEFAULT '')`);
		for (const row of rows) {
			await run(
				`INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, top_frame_site_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[row.host_key, row.name, row.value ?? '', row.encrypted_value ?? Buffer.alloc(0), row.path ?? '/', row.expires_utc ?? 0, row.is_secure ?? 0, row.is_httponly ?? 0, row.samesite ?? -1, row.source_scheme ?? 0, row.top_frame_site_key ?? ''],
			);
		}
	} finally {
		await new Promise<void>(resolve => db.close(() => resolve()));
	}
}

suite('Paradis Chromium cookie import (node)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let scratch: string;
	setup(() => { scratch = mkdtempSync(join(tmpdir(), 'paracode-cookie-test-')); });
	teardown(() => rmSync(scratch, { recursive: true, force: true }));

	test('samesite / expiry / prefix rules / google / set url', () => {
		const now = Math.floor(Date.now() / 1000);
		assert.deepStrictEqual(
			[paradisChromiumSameSite(-1), paradisChromiumSameSite(0), paradisChromiumSameSite(1), paradisChromiumSameSite(2), paradisChromiumSameSite(9)],
			['unspecified', 'no_restriction', 'lax', 'strict', 'unspecified'],
		);
		assert.deepStrictEqual(paradisChromiumExpiry(0, now), { kind: 'session' });
		assert.deepStrictEqual(paradisChromiumExpiry(toExpiresUtc(now - 10), now), { kind: 'expired' });
		// expires_utc は int64 で JS の安全整数を超えるため、変換後は秒単位で近似一致を見る。
		const future = paradisChromiumExpiry(toExpiresUtc(now + 100), now);
		assert.ok(future.kind === 'active' && Math.abs(future.expirationDate - (now + 100)) < 1);

		assert.strictEqual(paradisCookiePrefixRulesOk('__Host-x', { secure: true, path: '/', domainCookie: false }), true);
		assert.strictEqual(paradisCookiePrefixRulesOk('__Host-x', { secure: true, path: '/app', domainCookie: false }), false);
		assert.strictEqual(paradisCookiePrefixRulesOk('__Host-x', { secure: true, path: '/', domainCookie: true }), false);
		assert.strictEqual(paradisCookiePrefixRulesOk('__Secure-x', { secure: false, path: '/', domainCookie: false }), false);
		assert.strictEqual(paradisCookiePrefixRulesOk('plain', { secure: false, path: '/x', domainCookie: true }), true);

		// H1/N7: Google のログインは、accounts だけでなく .google.com / .youtube.com / 国別、
		// googlemail / blogger / youtubekids / googlesource、.google TLD も除外する。
		assert.deepStrictEqual(
			['.google.com', 'accounts.google.com', '.google.co.jp', 'www.google.com.br', '.youtube.com', 'mail.google.com',
				'.googlemail.com', '.blogger.com', '.youtubekids.com', '.googlesource.com', 'domains.google'].map(paradisIsGoogleLoginHost),
			[true, true, true, true, true, true, true, true, true, true, true],
		);
		assert.deepStrictEqual(['github.com', 'mygoogle.com', 'example.com'].map(paradisIsGoogleLoginHost), [false, false, false]);
		// N7: Cookie 名の網（Google ドメインでのみ使う）。__Secure-OSID と SIDCC も含める。
		assert.deepStrictEqual(
			['SAPISID', '__Secure-1PSID', '__Secure-OSID', 'SIDCC', 'session'].map(paradisIsGoogleLoginCookieName),
			[true, true, true, true, false],
		);

		assert.strictEqual(paradisCookieSetUrl('.github.com', '/', true), 'https://github.com/');
		assert.strictEqual(paradisCookieSetUrl('localhost', 'app', false), 'http://localhost/app');
		// L11: source_scheme=2 なら is_secure=0 でも https で書く。
		assert.strictEqual(paradisCookieSetUrl('shop.example.com', '/', false, 2), 'https://shop.example.com/');
	});

	test('decrypts v10; schema >= 24 strips the domain hash, < 24 does not; wrong key fails', () => {
		const key = paradisDeriveMacCookieKey(TEST_KEYCHAIN_PASSWORD);
		// 版 23: 接頭辞なし。非 ASCII を含む値もそのまま復号できる（推測で先頭を削らない）。
		assert.strictEqual(paradisDecryptCookieValueV10(encryptV10('テスト値テスト値テスト値', TEST_KEYCHAIN_PASSWORD), key, '.github.com', 23), 'テスト値テスト値テスト値');
		// 版 24: ハッシュ接頭辞を剥がす。剥がした後の非 ASCII も壊れない。
		assert.strictEqual(paradisDecryptCookieValueV10(encryptV10('トークン', TEST_KEYCHAIN_PASSWORD, '.github.com'), key, '.github.com', 24), 'トークン');
		// 版 24 なのにハッシュが無い値は壊れ値として捨てる（Chromium と同じ）。
		assert.strictEqual(paradisDecryptCookieValueV10(encryptV10('no-prefix', TEST_KEYCHAIN_PASSWORD), key, '.github.com', 24), undefined);
		// 鍵が違えば復号は失敗し、値は返さない。
		assert.strictEqual(paradisDecryptCookieValueV10(encryptV10('x', TEST_KEYCHAIN_PASSWORD), paradisDeriveMacCookieKey('wrong'), '.github.com', 23), undefined);
	});

	test('reads a synthetic DB, excludes Google and partitioned/expired cookies, imports only valid selected ones', async () => {
		const now = Math.floor(Date.now() / 1000);
		const dbPath = join(scratch, 'Cookies');
		await createCookieDb(dbPath, [
			{ host_key: '.github.com', name: 'gh_session', encrypted_value: encryptV10('gh-value', TEST_KEYCHAIN_PASSWORD), is_secure: 1, is_httponly: 1, samesite: 1, expires_utc: toExpiresUtc(now + 1000) },
			{ host_key: '.github.com', name: 'expired', encrypted_value: encryptV10('old', TEST_KEYCHAIN_PASSWORD), expires_utc: toExpiresUtc(now - 1000) },
			// H1: Google のセッションは .google.com / .youtube.com / 国別のいずれも取り込まない。
			{ host_key: '.google.com', name: 'SID', encrypted_value: encryptV10('nope', TEST_KEYCHAIN_PASSWORD), expires_utc: toExpiresUtc(now + 1000) },
			{ host_key: '.youtube.com', name: 'LOGIN_INFO', encrypted_value: encryptV10('nope', TEST_KEYCHAIN_PASSWORD), expires_utc: toExpiresUtc(now + 1000) },
			{ host_key: '.google.co.jp', name: 'SID', encrypted_value: encryptV10('nope', TEST_KEYCHAIN_PASSWORD), expires_utc: toExpiresUtc(now + 1000) },
			// M3: Partitioned Cookie（CHIPS）は取り込まない。
			{ host_key: '.example.com', name: 'chips', encrypted_value: encryptV10('p', TEST_KEYCHAIN_PASSWORD), top_frame_site_key: 'https://other.example', expires_utc: toExpiresUtc(now + 1000) },
			{ host_key: 'app.example.com', name: '__Host-sess', encrypted_value: encryptV10('host-value', TEST_KEYCHAIN_PASSWORD), path: '/', is_secure: 1, expires_utc: toExpiresUtc(now + 1000) },
			{ host_key: 'app.example.com', name: '__Host-bad', encrypted_value: encryptV10('bad', TEST_KEYCHAIN_PASSWORD), path: '/nested', is_secure: 1, expires_utc: toExpiresUtc(now + 1000) },
			// N4: Google と無関係なサイトの `SID` は普通の Cookie として取り込む（名前だけで落とさない）。
			{ host_key: '.someapp.test', name: 'SID', encrypted_value: encryptV10('app-sid', TEST_KEYCHAIN_PASSWORD), expires_utc: toExpiresUtc(now + 1000) },
			// N5: v10 でない暗号化行（例: linux の v11）は件数からも外す。
			{ host_key: '.legacy.test', name: 'x', encrypted_value: Buffer.concat([Buffer.from('v11'), Buffer.from('unreadable')]), expires_utc: toExpiresUtc(now + 1000) },
		], 23);

		const { schemaVersion, rows } = await paradisReadCookieDatabase(dbPath);
		assert.strictEqual(schemaVersion, 23);
		const groups = paradisGroupCookieDomains(rows, now);
		assert.deepStrictEqual(groups.get('github.com'), { count: 1, importable: true });
		assert.deepStrictEqual(groups.get('google.com'), { count: 1, importable: false, reason: 'Google のログインは取り込めません' });
		assert.deepStrictEqual(groups.get('youtube.com'), { count: 1, importable: false, reason: 'Google のログインは取り込めません' });
		assert.deepStrictEqual(groups.get('google.co.jp'), { count: 1, importable: false, reason: 'Google のログインは取り込めません' });
		// example.com は CHIPS の1件だけなので候補は0、app.example.com は __Host-sess の1件だけ。
		assert.deepStrictEqual(groups.get('example.com'), { count: 0, importable: true });
		assert.deepStrictEqual(groups.get('app.example.com'), { count: 1, importable: true });
		// N4: 無関係なサイトの SID は候補として数える。N5: v11 は候補に入れない（count 0）。
		assert.deepStrictEqual(groups.get('someapp.test'), { count: 1, importable: true });
		assert.deepStrictEqual(groups.get('legacy.test'), { count: 0, importable: true });

		const key = paradisDeriveMacCookieKey(TEST_KEYCHAIN_PASSWORD);
		const decrypt = (row: IParadisRawCookieRow) => paradisDecryptCookieValueV10(row.encryptedValue, key, row.hostKey, schemaVersion);
		const selected = new Set(['github.com', 'google.com', 'youtube.com', 'google.co.jp', 'example.com', 'app.example.com', 'someapp.test', 'legacy.test']);
		const imported = rows.map(row => paradisToImportableCookie(row, selected, decrypt, now)).filter((cookie): cookie is NonNullable<typeof cookie> => cookie !== undefined);

		assert.deepStrictEqual(imported.map(cookie => `${cookie.name}@${cookie.url}`).sort(), [
			'SID@http://someapp.test/',
			'__Host-sess@https://app.example.com/',
			'gh_session@https://github.com/',
		]);
		const gh = imported.find(cookie => cookie.name === 'gh_session')!;
		assert.deepStrictEqual(
			{ domain: gh.domain, secure: gh.secure, httpOnly: gh.httpOnly, sameSite: gh.sameSite, hasExpiry: gh.expirationDate !== undefined, value: gh.value },
			{ domain: '.github.com', secure: true, httpOnly: true, sameSite: 'lax', hasExpiry: true, value: 'gh-value' },
		);
	});

	test('imports unencrypted cookies from the value column', async () => {
		const now = Math.floor(Date.now() / 1000);
		const dbPath = join(scratch, 'Cookies');
		await createCookieDb(dbPath, [
			{ host_key: '.plain.com', name: 'p', value: 'plain-value', expires_utc: toExpiresUtc(now + 1000) },
		], 23);
		const { rows } = await paradisReadCookieDatabase(dbPath);
		const decrypt = () => undefined; // 暗号化なし。value 列を使うはず。
		const imported = rows.map(row => paradisToImportableCookie(row, new Set(['plain.com']), decrypt, now)).filter(Boolean);
		assert.strictEqual(imported.length, 1);
		assert.strictEqual(imported[0]!.value, 'plain-value');
	});

	test('resolves a Chrome install from a fake macOS profile tree without touching real browsers', async () => {
		const home = join(scratch, 'home');
		const userDataRoot = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
		mkdirSync(join(userDataRoot, 'Default', 'Network'), { recursive: true });
		writeFileSync(join(userDataRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Default': { name: '仕事用' } } }, os_crypt: { encrypted_key: 'unused-on-mac' } }));
		await createCookieDb(join(userDataRoot, 'Default', 'Network', 'Cookies'), [
			{ host_key: '.github.com', name: 'x', encrypted_value: encryptV10('v', TEST_KEYCHAIN_PASSWORD), expires_utc: 0 },
		], 24);

		const browsers = await paradisResolveBrowsers({ platform: 'darwin', homeDir: home });
		const chrome = browsers.find(browser => browser.id === 'chrome');
		assert.ok(chrome, 'Chrome should be resolved from the fake tree');
		assert.strictEqual(chrome!.unsupportedReason, undefined);
		assert.deepStrictEqual(chrome!.profiles, [{ directory: 'Default', label: '仕事用' }]);
	});
});
