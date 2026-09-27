/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCookieAndRewriteDeniedMessage } from '../../node/paradisCdpFilterProxy.js';

suite('paradisCdpFilterProxy cookie and URL rewrite checks', () => {
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
});
