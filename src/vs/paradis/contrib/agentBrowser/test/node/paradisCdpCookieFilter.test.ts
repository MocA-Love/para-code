/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCookieAndRewriteDeniedMessage, paradisSanitizeCookieBearingEvent } from '../../node/paradisCdpCookieFilter.js';

suite('paradisCdpCookieFilter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('raw CDP cannot send cookies, write cookies, clear storage or rewrite request URLs', () => {
		const denied = (method: string, params?: Record<string, unknown>) => paradisCookieAndRewriteDeniedMessage(method, params) !== undefined;
		assert.deepStrictEqual([
			denied('Network.setExtraHTTPHeaders', { headers: { 'X-Env': 'test' } }),
			denied('Network.setExtraHTTPHeaders', { headers: { COOKIE: 'a=1' } }),
			denied('Fetch.continueRequest', { requestId: '1' }),
			denied('Fetch.continueRequest', { requestId: '1', url: 'https://elsewhere.example/' }),
			denied('Fetch.continueRequest', { requestId: '1', headers: [{ name: 'Cookie', value: 'a=1' }] }),
			denied('Fetch.fulfillRequest', { requestId: '1', responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }] }),
			denied('Fetch.fulfillRequest', { requestId: '1', responseCode: 200, responseHeaders: [{ name: 'set-cookie', value: 'a=1' }] }),
			denied('Fetch.continueResponse', { requestId: '1', responseHeaders: [{ name: 'Clear-Site-Data', value: '"*"' }] }),
			denied('Fetch.fulfillRequest', { requestId: '1', responseCode: 200, binaryResponseHeaders: 'AA==' }),
			denied('Network.continueInterceptedRequest', { interceptionId: '1' }),
			denied('Page.printToPDF', {}),
		], [false, true, false, true, true, false, true, true, true, true, false]);
	});

	test('cookie headers and cookie lists are removed from network events before they reach the agent', () => {
		assert.deepStrictEqual([
			paradisSanitizeCookieBearingEvent('Network.requestWillBeSentExtraInfo', {
				requestId: '1',
				headers: { Accept: '*/*', Cookie: 'session=secret' },
				associatedCookies: [{ cookie: { name: 'session', value: 'secret' }, blockedReasons: [] }],
			}),
			paradisSanitizeCookieBearingEvent('Network.responseReceivedExtraInfo', {
				requestId: '1',
				headers: { 'content-type': 'text/html', 'set-cookie': 'session=secret; HttpOnly' },
				headersText: 'HTTP/1.1 200 OK\r\nSet-Cookie: session=secret\r\n',
				blockedCookies: [{ cookieLine: 'a=b', blockedReasons: [] }],
				exemptedCookies: [],
			}),
			paradisSanitizeCookieBearingEvent('Fetch.requestPaused', {
				requestId: '1',
				request: { url: 'https://example.com/', headers: { Accept: '*/*' } },
				responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'SET-COOKIE', value: 'session=secret' }],
			}),
			paradisSanitizeCookieBearingEvent('Network.webSocketWillSendHandshakeRequest', { requestId: '1', request: { headers: { Cookie: 'a=1', Origin: 'https://example.com' } } }),
			paradisSanitizeCookieBearingEvent('Audits.issueAdded', { issue: { code: 'CookieIssue', details: { cookieIssueDetails: { rawCookieLine: 'session=secret; bad', cookie: { name: 'session', domain: 'example.com', path: '/' } } } } }),
			paradisSanitizeCookieBearingEvent('Network.responseReceived', { requestId: '1', response: { headers: { 'content-type': 'text/html' } } }),
			paradisSanitizeCookieBearingEvent('Runtime.consoleAPICalled', { args: [{ value: { headers: { Cookie: 'page data' } } }] }),
		], [
			{ requestId: '1', headers: { Accept: '*/*' }, associatedCookies: [] },
			{ requestId: '1', headers: { 'content-type': 'text/html' }, blockedCookies: [], exemptedCookies: [] },
			{ requestId: '1', request: { url: 'https://example.com/', headers: { Accept: '*/*' } }, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] },
			{ requestId: '1', request: { headers: { Origin: 'https://example.com' } } },
			{ issue: { code: 'CookieIssue', details: { cookieIssueDetails: { cookie: { name: 'session', domain: 'example.com', path: '/' } } } } },
			undefined,
			undefined,
		]);
	});
});
