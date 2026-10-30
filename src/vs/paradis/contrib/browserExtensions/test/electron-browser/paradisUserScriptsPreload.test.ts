/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_USER_SCRIPTS_CALL, PARADIS_USER_SCRIPTS_EVENT, PARADIS_USER_SCRIPTS_QUERY, PARADIS_USER_SCRIPTS_RECHECK } from '../../common/paradisBrowserExtensionUserScripts.js';
import { IParadisUserScriptsWorldBridge, PARADIS_USER_SCRIPTS_BRIDGE_KEY, PARADIS_USER_SCRIPTS_PRELOAD_CALL, PARADIS_USER_SCRIPTS_PRELOAD_EVENT, PARADIS_USER_SCRIPTS_PRELOAD_QUERY, PARADIS_USER_SCRIPTS_PRELOAD_RECHECK, paradisInstallUserScriptWorldApis, paradisReadUserScriptsAnswer, paradisShouldAskForUserScripts } from '../../electron-browser/paradisUserScriptsPreload.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';

suite('ParadisUserScriptsPreload', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the names it repeats equal to main, asks only from web documents and reads only well-formed answers', () => {
		const script = { runAt: 'document_start', world: 5, code: 'x', url: 'chrome-extension://id/a.js' };
		const world = { world: 5, extensionId: ID, csp: '', messaging: true, name: 'n' };
		assert.deepStrictEqual({
			names: [PARADIS_USER_SCRIPTS_PRELOAD_QUERY, PARADIS_USER_SCRIPTS_PRELOAD_RECHECK, PARADIS_USER_SCRIPTS_PRELOAD_CALL, PARADIS_USER_SCRIPTS_PRELOAD_EVENT],
			asks: ['https:', 'http:', 'chrome-extension:', 'about:', 'file:'].map(paradisShouldAskForUserScripts),
			ok: paradisReadUserScriptsAnswer({ worlds: [world], scripts: [script] }) !== undefined,
			empty: paradisReadUserScriptsAnswer({ worlds: [], scripts: [] }),
			badRunAt: paradisReadUserScriptsAnswer({ worlds: [world], scripts: [{ ...script, runAt: 'later' }] }),
			badWorld: paradisReadUserScriptsAnswer({ worlds: [world], scripts: [{ ...script, world: 'ISOLATED' }] }),
			nothing: paradisReadUserScriptsAnswer(undefined),
		}, {
			names: [PARADIS_USER_SCRIPTS_QUERY, PARADIS_USER_SCRIPTS_RECHECK, PARADIS_USER_SCRIPTS_CALL, PARADIS_USER_SCRIPTS_EVENT],
			asks: [true, true, false, false, false],
			ok: true, empty: undefined, badRunAt: undefined, badWorld: undefined, nothing: undefined,
		});
	});

	test('gives the user script world only messaging to its own extension, through the bridge', async () => {
		const sent: unknown[][] = [];
		let connectedId = '';
		let deliver: ((event: { kind: string; portId: string; message?: unknown; error?: string }) => void) | undefined;
		const bridge: IParadisUserScriptsWorldBridge = {
			sendMessage: async message => { sent.push(['sendMessage', message]); return { value: { echo: message } }; },
			connect: async (portId, name) => { connectedId = portId; sent.push(['connect', name]); return {}; },
			postMessage: (_portId, message) => sent.push(['postMessage', message]),
			disconnect: () => sent.push(['disconnect']),
			onEvent: handler => { deliver = handler; },
		};
		const world: Record<string, unknown> = { [PARADIS_USER_SCRIPTS_BRIDGE_KEY]: bridge };
		new Function('globalThis', 'extensionId', 'key', `(${paradisInstallUserScriptWorldApis.toString()})(extensionId, key);`)(world, ID, PARADIS_USER_SCRIPTS_BRIDGE_KEY);
		const runtime = (world.chrome as { runtime: Record<string, (...args: unknown[]) => unknown> }).runtime;
		const reply = await runtime.sendMessage({ hi: 1 });
		const toOther = await (runtime.sendMessage('ponmlkjihgfedcbaponmlkjihgfedcba', 1) as Promise<unknown>).then(() => 'sent', (error: Error) => error.message);
		const port = runtime.connect({ name: 'p' }) as { name: string; postMessage(message: unknown): void; onMessage: { addListener(listener: (message: unknown) => void): void }; onDisconnect: { addListener(listener: () => void): void } };
		port.postMessage({ queued: true });
		await Promise.resolve();
		await Promise.resolve();
		const received: unknown[] = [];
		port.onMessage.addListener(message => received.push(message));
		let disconnected = false;
		port.onDisconnect.addListener(() => { disconnected = true; });
		deliver?.({ kind: 'message', portId: 'unknown', message: 'ignored' });
		deliver?.({ kind: 'message', portId: connectedId, message: { pong: 1 } });
		deliver?.({ kind: 'disconnect', portId: connectedId });
		deliver?.({ kind: 'message', portId: connectedId, message: 'after disconnect' });
		assert.deepStrictEqual({
			bridgeGone: world[PARADIS_USER_SCRIPTS_BRIDGE_KEY],
			id: runtime.id,
			url: (runtime.getURL as (path: string) => string)('/a/b.html'),
			reply, toOther, name: port.name, sent, received, disconnected,
			incognito: (world.chrome as { extension: { inIncognitoContext: boolean } }).extension.inIncognitoContext,
		}, {
			bridgeGone: undefined,
			id: ID,
			url: `chrome-extension://${ID}/a/b.html`,
			reply: { echo: { hi: 1 } },
			toOther: 'User scripts can only send messages to their own extension.',
			name: 'p',
			sent: [['sendMessage', { hi: 1 }], ['connect', 'p'], ['postMessage', { queued: true }]],
			received: [{ pong: 1 }],
			disconnected: true,
			incognito: false,
		});
	});
});
