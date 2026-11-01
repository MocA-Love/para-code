/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSummarizeManifest } from '../../electron-main/paradisBrowserExtensionsMain.js';
import { paradisPickWorkerTarget, paradisRewriteDevToolsHandshake } from '../../electron-main/paradisBrowserExtensionWorkerDevTools.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'a'.repeat(64);

suite('ParadisBrowserExtensionWorkerDevTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks the service worker target of the extension from /json/list', () => {
		const list = [
			{ id: 'AA01', type: 'page', url: `chrome-extension://${ID}/popup.html` },
			{ id: 'BB00', type: 'service_worker', url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/bg.js' },
			{ id: 'CC01', type: 'service_worker', url: `chrome-extension://${ID}/paracode-background.js` },
		];
		assert.deepStrictEqual([paradisPickWorkerTarget(list, ID), paradisPickWorkerTarget(list.slice(0, 2), ID), paradisPickWorkerTarget({}, ID)], ['CC01', undefined, undefined]);
	});

	test('relays only the DevTools window\'s own WebSocket, and drops its Origin and Host for the debugging port', () => {
		const tokens = new Map([[TOKEN, 'ABC123']]);
		const head = (path: string, origin: string | undefined) => [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1:5555', ...(origin !== undefined ? [`Origin: ${origin}`] : []), 'Upgrade: websocket', 'Sec-WebSocket-Key: k'].join('\r\n');
		assert.deepStrictEqual([
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/ABC123`, 'devtools://devtools'), 9222, tokens),
			// a web page (other Origin), no Origin, an unknown token, and another target are refused
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/ABC123`, 'https://example.com'), 9222, tokens),
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/ABC123`, undefined), 9222, tokens),
			paradisRewriteDevToolsHandshake(head(`/${'b'.repeat(64)}/devtools/page/ABC123`, 'devtools://devtools'), 9222, tokens),
			paradisRewriteDevToolsHandshake(head(`/${TOKEN}/devtools/page/DEF456`, 'devtools://devtools'), 9222, tokens),
		], [
			'GET /devtools/page/ABC123 HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\n\r\n',
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('summarizes the permissions, sites and service worker of a manifest for the manager screen', () => {
		assert.deepStrictEqual(paradisSummarizeManifest({
			permissions: ['storage', 'tabs', '<all_urls>'],
			optional_permissions: ['tabs', 'debugger'],
			host_permissions: ['https://example.com/*'],
			content_scripts: [{ matches: ['https://example.com/*', 'https://a.test/*'] }, null],
			background: { service_worker: 'bg.js' },
		}), {
			manifest: {
				permissions: ['storage', 'tabs', '<all_urls>'],
				optional_permissions: ['tabs', 'debugger'],
				host_permissions: ['https://example.com/*'],
				content_scripts: [{ matches: ['https://example.com/*', 'https://a.test/*'] }, null],
				background: { service_worker: 'bg.js' },
			},
			permissions: ['storage', 'tabs', 'debugger'],
			hostPermissions: ['<all_urls>', 'https://example.com/*', 'https://a.test/*'],
			hasWorker: true,
		});
	});
});
