/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_EXTENSION_API_EVENTS_URL } from '../../common/paradisBrowserExtensionApiWire.js';
import { paradisBrowserExtensionShimSource } from '../../common/paradisBrowserExtensionShimSource.js';

type Api = Record<string, Record<string, unknown>>;

/** 詰め物を、拡張機能の worker にあるものだけで動かす（本体の外を参照していれば落ちる）。 */
function runShim(permissions: readonly string[]): Api {
	const chrome: Api = { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getManifest: () => ({ manifest_version: 3, permissions }) }, extension: {} };
	class ServiceWorkerGlobalScope { }
	const context = Object.setPrototypeOf({
		chrome, console, setTimeout, TextDecoder, ServiceWorkerGlobalScope,
		fetch: async (url: string) => url.endsWith('token.json') ? { ok: true, json: async () => ({ token: 't' }) } : url.startsWith(PARADIS_EXTENSION_API_EVENTS_URL) ? { ok: false } : { ok: true, text: async () => '{"ok":true}' },
	}, ServiceWorkerGlobalScope.prototype);
	new Function('globalThis', paradisBrowserExtensionShimSource())(context);
	return chrome;
}

suite('ParadisBrowserExtensionInertApis', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds the APIs some extensions read at start, in forms that do not pretend to work', async () => {
		const without = runShim([]);
		const chrome = runShim(['identity', 'debugger', 'privacy']);
		const identity = chrome.identity as Record<string, (...args: unknown[]) => unknown>;
		const debuggerApi = chrome.debugger as Record<string, (...args: unknown[]) => unknown>;
		const extension = chrome.extension as Record<string, (...args: unknown[]) => Promise<unknown>>;
		const callbackError = await new Promise<unknown>(resolve => identity.getAuthToken({ interactive: true }, () => resolve((chrome.runtime.lastError as { message: string } | undefined)?.message)));
		assert.deepStrictEqual({
			without: [typeof without.identity, typeof without.debugger, typeof without.privacy],
			callbackError,
			lastErrorAfter: chrome.runtime.lastError,
			promiseError: await (identity.getAuthToken({}) as Promise<unknown>).then(() => 'resolved', (error: Error) => error.message),
			redirect: identity.getRedirectURL('done'),
			profile: await identity.getProfileUserInfo(),
			signInEvent: typeof (identity.onSignInChanged as unknown as { addListener: unknown }).addListener,
			attach: await (debuggerApi.attach({ tabId: 1 }, '1.3') as Promise<unknown>).then(() => 'attached', (error: Error) => error.message),
			debuggerEvent: typeof (debuggerApi.onEvent as unknown as { addListener: unknown }).addListener,
			passwordSaving: await ((chrome.privacy as Record<string, Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>>).services.passwordSavingEnabled.get({})),
			fileScheme: await extension.isAllowedFileSchemeAccess(),
			incognito: await extension.isAllowedIncognitoAccess(),
		}, {
			without: ['undefined', 'undefined', 'undefined'],
			callbackError: 'Para Code does not support signing in to Google from browser extensions',
			lastErrorAfter: undefined,
			promiseError: 'Para Code does not support signing in to Google from browser extensions',
			redirect: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/done',
			profile: { email: '', id: '' },
			signInEvent: 'function',
			attach: 'Para Code does not let browser extensions attach a debugger',
			debuggerEvent: 'function',
			// chrome.privacy は main につなぐ形（paradisInstallPrivacy）。Para Code に無い設定は変えられないと答える
			passwordSaving: { value: false, levelOfControl: 'not_controllable' },
			fileScheme: false,
			incognito: false,
		});
	});
});
