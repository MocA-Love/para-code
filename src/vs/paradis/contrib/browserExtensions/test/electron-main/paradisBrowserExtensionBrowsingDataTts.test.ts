/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_EXTENSION_API_CALL_URL, paradisDecodeExtensionWire, paradisEncodeExtensionWire, paradisExtensionApiUrl } from '../../common/paradisBrowserExtensionApiWire.js';
import { IParadisShimBridge, PARADIS_SHIM_TTS_NAMESPACE, paradisInstallTts } from '../../common/paradisBrowserExtensionShim.js';
import { ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { paradisBrowsingDataRemoval, paradisRegisterBrowsingDataApis } from '../../electron-main/paradisBrowserExtensionBrowsingData.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const silentLog = { warn: () => { } };

function outcome(run: () => unknown): unknown {
	try {
		return run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

suite('ParadisBrowserExtensionBrowsingData', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('removes only web data, never the data of extensions, and refuses what it cannot do exactly', () => {
		const extensions = [`chrome-extension://${ID}`];
		assert.deepStrictEqual({
			all: outcome(() => paradisBrowsingDataRemoval({ since: 0 }, { cookies: true, localStorage: true, cache: true }, extensions)),
			origins: outcome(() => paradisBrowsingDataRemoval({ origins: ['https://tracker.example/path', `chrome-extension://${ID}`] }, { cookies: true }, extensions)),
			excluded: outcome(() => paradisBrowsingDataRemoval({ excludeOrigins: ['https://keep.example'] }, { indexedDB: true }, extensions)),
			onlyExtensions: outcome(() => paradisBrowsingDataRemoval({ origins: [`chrome-extension://${ID}`] }, { cookies: true }, extensions)),
			since: outcome(() => paradisBrowsingDataRemoval({ since: Date.now() - 3600_000 }, { cookies: true }, extensions)),
			extensionType: outcome(() => paradisBrowsingDataRemoval({ originTypes: { extension: true } }, { localStorage: true }, extensions)),
			history: outcome(() => paradisBrowsingDataRemoval({}, { cookies: true, history: true, passwords: true }, extensions)),
			both: outcome(() => paradisBrowsingDataRemoval({ origins: ['https://a.example'], excludeOrigins: ['https://b.example'] }, { cookies: true }, extensions)),
			extensionPage: outcome(() => paradisBrowsingDataRemoval({ origins: [`chrome-extension://${ID}/options.html`, 'https://a.example:8443/x'] }, { cookies: true }, extensions)),
			opaque: outcome(() => paradisBrowsingDataRemoval({ origins: ['data:text/plain,x'] }, { cookies: true }, extensions)),
			noWeb: outcome(() => paradisBrowsingDataRemoval({ originTypes: { unprotectedWeb: false, protectedWeb: true } }, { cookies: true }, extensions)),
		}, {
			all: { dataTypes: ['cookies', 'localStorage', 'cache'], excludeOrigins: extensions },
			origins: { dataTypes: ['cookies'], origins: ['https://tracker.example'] },
			excluded: { dataTypes: ['indexedDB'], excludeOrigins: ['https://keep.example', ...extensions] },
			onlyExtensions: 'Para Code does not let browser extensions remove the data of extensions',
			since: 'Para Code can only remove browsing data from all time (since: 0)',
			extensionType: 'Para Code does not let browser extensions remove the data of extensions',
			history: 'Para Code cannot remove this browsing data: history, passwords',
			both: 'origins and excludeOrigins cannot be used together',
			// chrome-extension:// は URL の origin が "null" になるので protocol で見分けて外す
			extensionPage: { dataTypes: ['cookies'], origins: ['https://a.example:8443'] },
			opaque: 'Invalid origin: data:text/plain,x',
			// 普通のウェブを外されたら何も消さない
			noWeb: { dataTypes: [], excludeOrigins: extensions },
		});
	});

	test('clears only the caller\'s own session', async () => {
		const cleared: { session: string; options: unknown }[] = [];
		const sessions: { session: ParadisApiSession; handler?: (request: Request) => Promise<Response> }[] = [];
		const make = (name: string) => {
			const entry: { session: ParadisApiSession; handler?: (request: Request) => Promise<Response> } = { session: undefined! };
			entry.session = {
				storagePath: `/tmp/${name}`,
				protocol: { handle: (_scheme: string, next: (request: Request) => Promise<Response>) => { entry.handler = next; }, unhandle: () => { entry.handler = undefined; } },
				extensions: { getExtension: (id: string) => id === ID ? { id, version: '1', manifest: { manifest_version: 3, permissions: ['browsingData'] }, name: 'E', path: '/x' } : null, on: () => undefined, removeListener: () => undefined },
				serviceWorkers: { startWorkerForScope: async () => { throw new Error('none'); }, getWorkerFromVersionID: () => undefined, on: () => undefined, removeListener: () => undefined },
				clearData: async (options: unknown) => { cleared.push({ session: name, options }); },
			} as unknown as ParadisApiSession;
			sessions.push(entry);
			return entry;
		};
		const host = new ParadisExtensionApiHost(silentLog);
		paradisRegisterBrowsingDataApis(host, () => [`chrome-extension://${ID}`]);
		const profile = make('profile');
		make('other-place');
		const attached = sessions.map((entry, index) => host.attachSession(entry.session, index === 0 ? 'profile:0123456789ab' : 'default'));
		try {
			const request = new Request(paradisExtensionApiUrl(PARADIS_EXTENSION_API_CALL_URL, host.tokenFor(ID), 'worker'), { method: 'POST', body: paradisEncodeExtensionWire({ request: { type: 'call', namespace: 'browsingData', method: 'removeCookies', args: [{ since: 0 }] } }) });
			Object.defineProperty(request, 'initiatorOrigin', { value: `chrome-extension://${ID}` });
			const reply = paradisDecodeExtensionWire(await (await profile.handler!(request)).text());
			assert.deepStrictEqual({ reply, cleared }, {
				reply: { ok: true },
				cleared: [{ session: 'profile', options: { dataTypes: ['cookies'], excludeOrigins: [`chrome-extension://${ID}`] } }],
			});
		} finally {
			for (const entry of attached) {
				entry.dispose();
			}
			host.dispose();
		}
	});
});

suite('ParadisBrowserExtensionTts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps onEvent in the extension, sends only plain options to main, and delivers the events of that utterance', async () => {
		const calls: [string, unknown[]][] = [];
		let handler: ((namespace: string, event: string, args: unknown[]) => void) | undefined;
		const listened: string[] = [];
		const bridge: IParadisShimBridge = {
			call: async (namespace, method, args) => {
				calls.push([`${namespace}.${method}`, args]);
				return { ok: true, value: method === 'getVoices' ? [{ voiceName: 'Kyoko', lang: 'ja-JP', remote: false }] : undefined };
			},
			listen: (_namespace, event) => listened.push(event),
			onEvent: next => { handler = next; },
		};
		const page = { chrome: { runtime: { getManifest: () => ({ permissions: ['tts'] }) } } as Record<string, unknown> };
		new Function('globalThis', 'bridge', 'namespace', `(${paradisInstallTts.toString()})(bridge, namespace);`)(page, bridge, PARADIS_SHIM_TTS_NAMESPACE);
		const tts = page.chrome.tts as Record<string, (...args: unknown[]) => unknown>;
		const events: unknown[] = [];
		await new Promise<void>(resolve => tts.speak('こんにちは', { lang: 'ja-JP', rate: 1.2, onEvent: (event: unknown) => events.push(event), desiredEventTypes: ['end'] }, () => resolve()));
		const requestId = (calls[0][1] as unknown[])[0] as string;
		handler?.(PARADIS_SHIM_TTS_NAMESPACE, 'onUtteranceEvent', [requestId, { type: 'start', charIndex: 0 }]);
		handler?.(PARADIS_SHIM_TTS_NAMESPACE, 'onUtteranceEvent', [requestId, { type: 'end', charIndex: 5 }]);
		handler?.(PARADIS_SHIM_TTS_NAMESPACE, 'onUtteranceEvent', [requestId, { type: 'end', charIndex: 5 }]);
		handler?.(PARADIS_SHIM_TTS_NAMESPACE, 'onUtteranceEvent', ['another', { type: 'start' }]);
		assert.deepStrictEqual({
			speak: calls[0][0], text: (calls[0][1] as unknown[])[1], options: (calls[0][1] as unknown[])[2],
			events, listened,
			voices: await tts.getVoices(),
		}, {
			speak: `${PARADIS_SHIM_TTS_NAMESPACE}.speak`, text: 'こんにちは', options: { lang: 'ja-JP', rate: 1.2 },
			// 終わった後の知らせ・ほかの読み上げの知らせは届けない
			events: [{ type: 'start', charIndex: 0 }, { type: 'end', charIndex: 5 }],
			listened: ['onUtteranceEvent'],
			voices: [{ voiceName: 'Kyoko', lang: 'ja-JP', remote: false }],
		});
	});
});
