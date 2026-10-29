/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_CHROME_WEB_STORE_ORIGIN, PARADIS_WEB_STORE_CHANNEL, PARADIS_WEB_STORE_EVENT_CHANNEL, PARADIS_WEB_STORE_QUERY } from '../../common/paradisBrowserExtensionWebStore.js';
import { IParadisWebStoreMainWorldBridge, PARADIS_WEB_STORE_PRELOAD_CHANNEL, PARADIS_WEB_STORE_PRELOAD_EVENT_CHANNEL, PARADIS_WEB_STORE_PRELOAD_ORIGIN, PARADIS_WEB_STORE_PRELOAD_QUERY, paradisAdaptWebStoreWording, paradisInstallWebStoreApis, paradisShouldInstallWebStoreBridge } from '../../electron-browser/paradisWebStorePreload.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'Store Ext', version: '1.0' });

suite('ParadisWebStorePreload', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the names it repeats equal to main and the shared constants', () => {
		assert.deepStrictEqual(
			[PARADIS_WEB_STORE_PRELOAD_ORIGIN, PARADIS_WEB_STORE_PRELOAD_CHANNEL, PARADIS_WEB_STORE_PRELOAD_EVENT_CHANNEL, PARADIS_WEB_STORE_PRELOAD_QUERY],
			[PARADIS_CHROME_WEB_STORE_ORIGIN, PARADIS_WEB_STORE_CHANNEL, PARADIS_WEB_STORE_EVENT_CHANNEL, PARADIS_WEB_STORE_QUERY],
		);
	});

	test('asks main only from the store\'s own top-level document', () => {
		const asked: string[] = [];
		const ask = (origin: string, top: boolean) => paradisShouldInstallWebStoreBridge(origin, top, () => { asked.push(origin); return true; });
		assert.deepStrictEqual({
			store: ask(PARADIS_CHROME_WEB_STORE_ORIGIN, true),
			storeIframe: ask(PARADIS_CHROME_WEB_STORE_ORIGIN, false),
			lookAlike: ask('https://chromewebstore.google.com.evil.example', true),
			http: ask('http://chromewebstore.google.com', true),
			legacy: ask('https://chrome.google.com', true),
			refusedByMain: paradisShouldInstallWebStoreBridge(PARADIS_CHROME_WEB_STORE_ORIGIN, true, () => false),
			asked,
		}, { store: true, storeIframe: false, lookAlike: false, http: false, legacy: false, refusedByMain: false, asked: [PARADIS_CHROME_WEB_STORE_ORIGIN] });
	});

	test('installs webstorePrivate with nothing outside its body, with callbacks, promises and lastError like Chrome', async () => {
		const calls: [string, unknown[]][] = [];
		let handler: ((event: string, args: unknown[]) => void) | undefined;
		const bridge: IParadisWebStoreMainWorldBridge = {
			call: async (method, args) => {
				calls.push([method, args]);
				return method === 'beginInstallWithManifest3' ? { value: 'user_cancelled', error: 'User cancelled install' } : { value: 'installable' };
			},
			onEvent: next => { handler = next; },
		};
		const page: { chrome: Record<string, Record<string, unknown>> } = { chrome: {} };
		// executeInMainWorld と同じく、文字にした関数だけを動かす（本体の外を参照していれば落ちる）
		new Function('globalThis', 'bridge', `(${paradisInstallWebStoreApis.toString()})(bridge, '140.0.0.0');`)(page, bridge);
		const store = page.chrome.webstorePrivate as Record<string, (...args: unknown[]) => unknown>;
		const management = page.chrome.management as Record<string, unknown>;
		const lastErrors: unknown[] = [];
		await new Promise<void>(resolve => store.beginInstallWithManifest3({ id: ID, manifest: MANIFEST }, (result: unknown) => {
			lastErrors.push(result, (page.chrome.runtime.lastError as { message?: string } | undefined)?.message);
			resolve();
		}));
		const status = await store.getExtensionStatus(ID);
		const version = await store.getFullChromeVersion();
		const installed: unknown[] = [];
		(management.onInstalled as { addListener(listener: (info: unknown) => void): void }).addListener(info => installed.push(info));
		handler?.('onInstalled', [{ id: ID }]);
		assert.deepStrictEqual({ calls, lastErrors, lastErrorAfter: page.chrome.runtime.lastError, status, version, installed }, {
			calls: [['beginInstallWithManifest3', [{ id: ID, manifest: MANIFEST }]], ['getExtensionStatus', [ID]]],
			lastErrors: ['user_cancelled', 'User cancelled install'],
			lastErrorAfter: undefined,
			status: 'installable',
			version: { version_number: '140.0.0.0' },
			installed: [{ id: ID }],
		});
	});

	test('serializes the wording change without its closure', () => {
		assert.doesNotThrow(() => new Function(`return (${paradisAdaptWebStoreWording.toString()});`)());
	});
});
