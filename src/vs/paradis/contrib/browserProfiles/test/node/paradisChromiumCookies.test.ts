/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 他ブラウザからのログイン取り込みの node 層テスト。合成した Chromium Cookie DB（既知の鍵で
// v10 暗号化）で、読み取り・macOS の復号（PBKDF2 saltysalt/1003 + AES-128-CBC）・属性の写し取り・
// 期限切れの除外・接頭辞規則を確かめる。本物のブラウザの DB もキーチェーンも一切読まない。

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
	paradisIsGoogleSignInHost,
} from '../../common/paradisBrowserLoginImport.js';
import {
	IParadisRawCookieRow,
	paradisDecryptCookieValueV10,
	paradisDeriveMacCookieKey,
	paradisGroupCookieDomains,
	paradisReadCookieRows,
	paradisResolveBrowsers,
	paradisToImportableCookie,
} from '../../node/paradisChromiumCookies.js';

const TEST_KEYCHAIN_PASSWORD = 'peanuts-test-safe-storage';
const CHROMIUM_EPOCH_TO_UNIX_SECONDS = 11644473600;

/** 実 Chromium と同じ手順で v10 暗号化する（Orca の合成 DB ヘルパーと同一手順）。 */
function encryptV10(value: string, password: string, hostKey?: string): Buffer {
	const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
	const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
	const prefix = hostKey ? createHash('sha256').update(hostKey).digest() : Buffer.alloc(0);
	return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.concat([prefix, Buffer.from(value, 'latin1')])), cipher.final()]);
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
}

async function createCookieDb(dbPath: string, rows: readonly ITestCookieRow[]): Promise<void> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const db: Database = await new Promise((resolve, reject) => {
		const database = new sqlite3.Database(dbPath, error => error ? reject(error) : resolve(database));
	});
	try {
		await new Promise<void>((resolve, reject) => db.exec(
			`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`,
			error => error ? reject(error) : resolve(),
		));
		for (const row of rows) {
			await new Promise<void>((resolve, reject) => db.run(
				`INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[row.host_key, row.name, row.value ?? '', row.encrypted_value ?? Buffer.alloc(0), row.path ?? '/', row.expires_utc ?? 0, row.is_secure ?? 0, row.is_httponly ?? 0, row.samesite ?? -1],
				error => error ? reject(error) : resolve(),
			));
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

	test('samesite / expiry / prefix rules / google host / set url', () => {
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

		assert.strictEqual(paradisIsGoogleSignInHost('accounts.google.com'), true);
		assert.strictEqual(paradisIsGoogleSignInHost('.accounts.google.com'), true);
		assert.strictEqual(paradisIsGoogleSignInHost('mail.google.com'), false);

		assert.strictEqual(paradisCookieSetUrl('.github.com', '/', true), 'https://github.com/');
		assert.strictEqual(paradisCookieSetUrl('localhost', 'app', false), 'http://localhost/app');
	});

	test('decrypts v10 with and without the host-key hash prefix', () => {
		const key = paradisDeriveMacCookieKey(TEST_KEYCHAIN_PASSWORD);
		assert.strictEqual(paradisDecryptCookieValueV10(encryptV10('session-token', TEST_KEYCHAIN_PASSWORD), key, '.github.com'), 'session-token');
		assert.strictEqual(paradisDecryptCookieValueV10(encryptV10('token2', TEST_KEYCHAIN_PASSWORD, '.github.com'), key, '.github.com'), 'token2');
		// 鍵が違えば復号は失敗し、値は返さない（undefined）。
		assert.strictEqual(paradisDecryptCookieValueV10(encryptV10('x', TEST_KEYCHAIN_PASSWORD), paradisDeriveMacCookieKey('wrong'), '.github.com'), undefined);
	});

	test('reads a synthetic DB, groups domains, and only imports selected, valid, non-expired cookies', async () => {
		{
			const now = Math.floor(Date.now() / 1000);
			const dbPath = join(scratch, 'Cookies');
			await createCookieDb(dbPath, [
				{ host_key: '.github.com', name: 'gh_session', encrypted_value: encryptV10('gh-value', TEST_KEYCHAIN_PASSWORD, '.github.com'), is_secure: 1, is_httponly: 1, samesite: 1, expires_utc: toExpiresUtc(now + 1000) },
				{ host_key: '.github.com', name: 'expired', encrypted_value: encryptV10('old', TEST_KEYCHAIN_PASSWORD, '.github.com'), expires_utc: toExpiresUtc(now - 1000) },
				{ host_key: 'accounts.google.com', name: 'SID', encrypted_value: encryptV10('nope', TEST_KEYCHAIN_PASSWORD), expires_utc: toExpiresUtc(now + 1000) },
				{ host_key: 'app.example.com', name: '__Host-sess', encrypted_value: encryptV10('host-value', TEST_KEYCHAIN_PASSWORD), path: '/', is_secure: 1, expires_utc: toExpiresUtc(now + 1000) },
				{ host_key: 'app.example.com', name: '__Host-bad', encrypted_value: encryptV10('bad', TEST_KEYCHAIN_PASSWORD), path: '/nested', is_secure: 1, expires_utc: toExpiresUtc(now + 1000) },
			]);

			const rows = await paradisReadCookieRows(dbPath);
			const groups = paradisGroupCookieDomains(rows, now);
			assert.deepStrictEqual(groups.get('github.com'), { count: 1, importable: true });
			assert.deepStrictEqual(groups.get('accounts.google.com'), { count: 1, importable: false, reason: 'Google のログインは取り込めません' });
			assert.deepStrictEqual(groups.get('app.example.com'), { count: 2, importable: true });

			const key = paradisDeriveMacCookieKey(TEST_KEYCHAIN_PASSWORD);
			const decrypt = (row: IParadisRawCookieRow) => paradisDecryptCookieValueV10(row.encryptedValue, key, row.hostKey);
			const selected = new Set(['github.com', 'accounts.google.com', 'app.example.com']);
			const imported = rows.map(row => paradisToImportableCookie(row, selected, decrypt, now)).filter((cookie): cookie is NonNullable<typeof cookie> => cookie !== undefined);

			assert.deepStrictEqual(imported.map(cookie => `${cookie.name}@${cookie.url}`).sort(), [
				'__Host-sess@https://app.example.com/',
				'gh_session@https://github.com/',
			]);
			const gh = imported.find(cookie => cookie.name === 'gh_session')!;
			assert.deepStrictEqual(
				{ domain: gh.domain, secure: gh.secure, httpOnly: gh.httpOnly, sameSite: gh.sameSite, hasExpiry: gh.expirationDate !== undefined, value: gh.value },
				{ domain: '.github.com', secure: true, httpOnly: true, sameSite: 'lax', hasExpiry: true, value: 'gh-value' },
			);
		}
	});

	test('resolves a Chrome install from a fake macOS profile tree without touching real browsers', async () => {
		const home = join(scratch, 'home');
		const userDataRoot = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
		mkdirSync(join(userDataRoot, 'Default', 'Network'), { recursive: true });
		writeFileSync(join(userDataRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Default': { name: '仕事用' } } }, os_crypt: { encrypted_key: 'unused-on-mac' } }));
		await createCookieDb(join(userDataRoot, 'Default', 'Network', 'Cookies'), [
			{ host_key: '.github.com', name: 'x', encrypted_value: encryptV10('v', TEST_KEYCHAIN_PASSWORD, '.github.com'), expires_utc: 0 },
		]);

		const browsers = await paradisResolveBrowsers({ platform: 'darwin', homeDir: home });
		const chrome = browsers.find(browser => browser.id === 'chrome');
		assert.ok(chrome, 'Chrome should be resolved from the fake tree');
		assert.strictEqual(chrome!.unsupportedReason, undefined);
		assert.deepStrictEqual(chrome!.profiles, [{ directory: 'Default', label: '仕事用' }]);
	});
});
