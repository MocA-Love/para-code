/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInstallCapture } from '../../common/paradisBrowserExtensionShim.js';

suite('ParadisBrowserExtensionCapture', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('desktopCapture and tabCapture fail the way Chrome reports errors, only when the manifest asks for them', async () => {
		const run = (permissions: string[]) => {
			const page = { chrome: { runtime: { getManifest: () => ({ permissions }) } } as Record<string, unknown> };
			new Function('globalThis', `(${paradisInstallCapture.toString()})();`)(page);
			return page.chrome as Record<string, Record<string, (...args: unknown[]) => unknown> | undefined> & { runtime: { lastError?: { message: string } } };
		};
		const chrome = run(['desktopCapture', 'tabCapture']);
		const chosen = await new Promise<unknown[]>(resolve => chrome.desktopCapture!.chooseDesktopMedia(['screen'], (id: unknown, options: unknown) => resolve([id, options, chrome.runtime.lastError?.message])));
		const captured = await new Promise<unknown[]>(resolve => chrome.tabCapture!.capture({ video: true }, (stream: unknown) => resolve([stream, chrome.runtime.lastError?.message])));
		const streamId = await (chrome.tabCapture!.getMediaStreamId({}) as Promise<unknown>).then(() => 'resolved', (error: Error) => error.message);
		const tabs = await chrome.tabCapture!.getCapturedTabs();
		const without = run([]);
		const message = 'Para Code does not support screen and tab capture in browser extensions';
		assert.deepStrictEqual({ chosen, captured, streamId, tabs, lastErrorAfter: chrome.runtime.lastError, without: [without.desktopCapture, without.tabCapture] }, {
			chosen: ['', { canRequestAudioTrack: false }, message],
			captured: [null, message],
			streamId: message,
			tabs: [],
			lastErrorAfter: undefined,
			without: [undefined, undefined],
		});
	});
});
