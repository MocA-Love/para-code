/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisApplyHeaderRule,
	paradisBuildRedirectHeaders,
	paradisBuildRespondHeaders,
	paradisFindRequestRule,
	paradisMatchUrlPattern,
	paradisParseHeaderMap,
	paradisParseHighlightRect,
	paradisParseHttpCredentials,
	paradisParsePageOverridesRequest,
	paradisParsePdfOptions,
	paradisParseRequestRules,
	paradisRedactToolArgumentsText,
	paradisRedactToolInputSecrets,
	paradisSanitizePdfFileName,
} from '../../common/paradisBrowserPageOps.js';

suite('paradisBrowserPageOps', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('request headers refuse cookies, connection headers, proxy headers and line breaks', () => {
		const verdicts = [
			{ 'X-Test': '1', Authorization: 'Bearer a' },
			{ Cookie: 'a=1' },
			{ cookie2: 'a=1' },
			{ 'Set-Cookie': 'a=1' },
			{ Host: 'evil.example' },
			{ 'Proxy-Authorization': 'Basic x' },
			{ 'X-Test': 'a\r\nCookie: b=1' },
			{ 'bad name': '1' },
			{ 'X-A': '1', 'x-a': '2' },
		].map(headers => paradisParseHeaderMap(headers, 'request', 'headers').ok);
		assert.deepStrictEqual(verdicts, [true, false, false, false, false, false, false, false, false]);
	});

	test('response headers are an allowlist without Set-Cookie, storage clearing or caching', () => {
		const verdicts = [
			{ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Mock': '1' },
			{ 'Set-Cookie': 'a=1' },
			{ 'Clear-Site-Data': '"*"' },
			{ 'Strict-Transport-Security': 'max-age=1' },
			{ 'Cache-Control': 'max-age=999' },
		].map(headers => paradisParseHeaderMap(headers, 'response', 'response_headers').ok);
		assert.deepStrictEqual(verdicts, [true, false, false, false, false]);
	});

	test('credentials: https or loopback http only, origin normalized, no user info', () => {
		const results = [
			{ origin: 'https://intranet.example.com/path?x', username: 'u', password: 'p' },
			{ origin: 'http://localhost:8080', username: 'u', password: '' },
			{ origin: 'http://intranet.example.com', username: 'u', password: 'p' },
			{ origin: 'https://a:b@example.com', username: 'u', password: 'p' },
			{ origin: 'https://example.com', username: 'a:b', password: 'p' },
			{ origin: 'https://example.com', username: 'u', password: 'p\n' },
		].map(value => {
			const parsed = paradisParseHttpCredentials(value);
			return parsed.ok ? parsed.value.origin : false;
		});
		assert.deepStrictEqual(results, ['https://intranet.example.com', 'http://localhost:8080', false, false, false, false]);
	});

	test('request rules are validated and keep their order', () => {
		const parsed = paradisParseRequestRules([
			{ url_pattern: '*://ads.example.com/*', action: 'block' },
			{ url_pattern: '*/api/*', action: 'set_headers', set_headers: { 'X-Env': 'test' }, remove_headers: ['X-Debug'] },
			{ url_pattern: '*/old', action: 'redirect', redirect_url: 'https://example.com/new' },
			{ url_pattern: '*/mock.json', action: 'respond', status: 200, body: '{}', response_headers: { 'Content-Type': 'application/json' } },
		]);
		assert.ok(parsed.ok);
		assert.deepStrictEqual(parsed.value.map(rule => rule.action), ['block', 'set_headers', 'redirect', 'respond']);

		const rejected = [
			[{ url_pattern: '*', action: 'set_headers', set_headers: { Cookie: 'a=1' } }],
			[{ url_pattern: '*', action: 'set_headers', remove_headers: ['cookie'] }],
			[{ url_pattern: '*', action: 'redirect', redirect_url: 'file:///etc/passwd' }],
			[{ url_pattern: '*', action: 'respond', status: 302 }],
			[{ url_pattern: '*', action: 'respond', response_headers: { 'Set-Cookie': 'a=1' } }],
			[{ url_pattern: '', action: 'block' }],
			[{ url_pattern: '*', action: 'rewrite' }],
			[{ url_pattern: '*', action: 'block', extra: 1 }],
			new Array(21).fill({ url_pattern: '*', action: 'block' }),
		].map(rules => paradisParseRequestRules(rules).ok);
		assert.deepStrictEqual(rejected, [false, false, false, false, false, false, false, false, false]);
	});

	test('URL patterns follow the Fetch wildcard rules', () => {
		const cases: [string, string][] = [
			['*://api.example.com/*', 'https://api.example.com/v1/users'],
			['*://api.example.com/*', 'https://api.example.com.evil.test/'],
			['https://example.com/a?c', 'https://example.com/abc'],
			['https://example.com/a\\?c', 'https://example.com/a?c'],
			['https://example.com/a\\?c', 'https://example.com/abc'],
			['*.js', 'https://cdn.example.com/app.js'],
			['*.js', 'https://cdn.example.com/app.json'],
		];
		assert.deepStrictEqual(cases.map(([pattern, url]) => paradisMatchUrlPattern(pattern, url)), [true, false, true, true, false, true, false]);
	});

	test('URL patterns with many wildcards finish in linear time and keep the wildcard rules', () => {
		const started = Date.now();
		const redos = paradisMatchUrlPattern('*a'.repeat(500) + 'b', 'https://x/' + 'a'.repeat(4000));
		const elapsed = Date.now() - started;
		const cases: [string, string][] = [
			['**', ''],
			['*', 'https://example.com/'],
			['a*b*c', 'axxbyyc'],
			['a*b*c', 'axxbyycd'],
			['*a*a*b', 'https://x/aaab'],
			['https://example.com/a\\', 'https://example.com/a\\'],
			['https://example.com/\\*', 'https://example.com/x'],
			['?', ''],
		];
		assert.deepStrictEqual({
			redos,
			fast: elapsed < 1000,
			cases: cases.map(([pattern, url]) => paradisMatchUrlPattern(pattern, url)),
		}, {
			redos: false,
			fast: true,
			cases: [true, true, true, false, true, true, false, false],
		});
	});

	test('the first matching rule wins, and header rules never touch cookies', () => {
		const parsed = paradisParseRequestRules([
			{ url_pattern: '*/api/*', action: 'set_headers', set_headers: { 'X-Env': 'test' }, remove_headers: ['X-Debug'] },
			{ url_pattern: '*', action: 'block' },
		]);
		assert.ok(parsed.ok);
		const rule = paradisFindRequestRule(parsed.value, 'https://example.com/api/x');
		assert.strictEqual(rule?.action, 'set_headers');
		assert.deepStrictEqual(paradisApplyHeaderRule({ Accept: '*/*', 'X-Debug': '1', 'x-env': 'prod', Cookie: 'keep=1' }, rule!), [
			{ name: 'Accept', value: '*/*' },
			{ name: 'Cookie', value: 'keep=1' },
			{ name: 'X-Env', value: 'test' },
		]);
		assert.strictEqual(paradisFindRequestRule(parsed.value, 'https://example.com/other')?.action, 'block');
	});

	test('built responses are never cacheable and redirects go through Location', () => {
		const parsed = paradisParseRequestRules([
			{ url_pattern: '*', action: 'respond', status: 404, body: 'x', response_headers: { 'X-Mock': '1' } },
			{ url_pattern: '*', action: 'redirect', redirect_url: 'https://example.com/new' },
		]);
		assert.ok(parsed.ok);
		assert.deepStrictEqual(paradisBuildRespondHeaders(parsed.value[0]), [
			{ name: 'X-Mock', value: '1' },
			{ name: 'Content-Type', value: 'text/plain; charset=utf-8' },
			{ name: 'Cache-Control', value: 'no-store' },
		]);
		assert.deepStrictEqual(paradisBuildRedirectHeaders(parsed.value[1]), [
			{ name: 'Location', value: 'https://example.com/new' },
			{ name: 'Cache-Control', value: 'no-store' },
		]);
	});

	test('electron-main re-validates the internal request shape', () => {
		const rules = paradisParseRequestRules([{ url_pattern: '*/a', action: 'set_headers', set_headers: { 'X-A': '1' } }]);
		assert.ok(rules.ok);
		const extraHeaders = { headers: { 'X-B': '2' }, origins: ['https://example.com'] };
		const roundTrip = paradisParsePageOverridesRequest(JSON.parse(JSON.stringify({ extraHeaders, credentials: null, rules: rules.value })));
		assert.ok(roundTrip.ok);
		assert.deepStrictEqual(roundTrip.value, { extraHeaders, credentials: null, rules: rules.value });
		const smuggled = paradisParsePageOverridesRequest({ extraHeaders: { headers: { Cookie: 'a=1' }, origins: [] } });
		assert.strictEqual(smuggled.ok, false);
		const badOrigin = paradisParsePageOverridesRequest({ extraHeaders: { headers: { 'X-B': '2' }, origins: ['javascript:alert(1)'] } });
		assert.strictEqual(badOrigin.ok, false);
		assert.strictEqual(smuggled.ok, false);
		const smuggledRule = paradisParsePageOverridesRequest({ rules: [{ urlPattern: '*', action: 'respond', responseHeaders: { 'Set-Cookie': 'a=1' } }] });
		assert.strictEqual(smuggledRule.ok, false);
	});

	test('PDF file names cannot escape the download folder and always end in .pdf', () => {
		assert.deepStrictEqual([
			paradisSanitizePdfFileName('../../etc/passwd', 'x'),
			paradisSanitizePdfFileName('report.PDF', 'x'),
			paradisSanitizePdfFileName('  ...  ', 'Page Title: A/B'),
			paradisSanitizePdfFileName('a\u202eb\u0000c', 'x'),
			paradisSanitizePdfFileName(undefined, ''),
			paradisSanitizePdfFileName('nul', 'x'),
			paradisSanitizePdfFileName('CON.report', 'x'),
			paradisSanitizePdfFileName('com\u00b9', 'x'),
			paradisSanitizePdfFileName('x'.repeat(300), 'x').length,
		], ['_.._etc_passwd.pdf', 'report.pdf', 'Page Title_ A_B.pdf', 'abc.pdf', 'page.pdf', 'nul_.pdf', 'CON_.report.pdf', 'com\u00b9_.pdf', 120]);
		const options = paradisParsePdfOptions({ landscape: true, paper_format: 'Letter', page_ranges: '1-2, 5' }, 'Title');
		assert.ok(options.ok);
		assert.deepStrictEqual(options.value, { fileName: 'Title.pdf', landscape: true, printBackground: true, paperFormat: 'Letter', scale: 1, pageRanges: '1-2, 5' });
		assert.strictEqual(paradisParsePdfOptions({ page_ranges: '1; rm -rf' }, 'x').ok, false);
	});

	test('highlight rectangles must be finite and not empty', () => {
		assert.deepStrictEqual([
			paradisParseHighlightRect({ x: 1, y: 2, width: 3, height: 4 }),
			paradisParseHighlightRect({ x: 1, y: 2, width: 0, height: 4 }),
			paradisParseHighlightRect({ x: Number.NaN, y: 2, width: 3, height: 4 }),
			paradisParseHighlightRect(null),
		], [{ x: 1, y: 2, width: 3, height: 4 }, undefined, undefined, undefined]);
	});

	test('credential passwords are hidden from displayed tool inputs', () => {
		const input = { origin: 'https://example.com', username: 'u', password: 'secret' };
		assert.deepStrictEqual([
			paradisRedactToolInputSecrets('mcp__para-browser__set_http_credentials', input),
			paradisRedactToolInputSecrets('set_http_credentials', input),
			paradisRedactToolInputSecrets('mcp__para-browser__set_extra_http_headers', input),
			paradisRedactToolArgumentsText('mcp__para-browser__set_http_credentials', JSON.stringify(input)),
			paradisRedactToolArgumentsText('mcp__para-browser__set_http_credentials', '{broken secret'),
		], [
			{ origin: 'https://example.com', username: 'u', password: '[hidden]' },
			{ origin: 'https://example.com', username: 'u', password: '[hidden]' },
			input,
			'{"origin":"https://example.com","username":"u","password":"[hidden]"}',
			'[hidden]',
		]);
	});
});
