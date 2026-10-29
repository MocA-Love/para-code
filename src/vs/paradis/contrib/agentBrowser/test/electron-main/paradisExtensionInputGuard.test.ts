/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_EXTENSION_INPUT_DENIED_MESSAGE, ParadisInputGuardWebContents, paradisExtensionInputRefusal, paradisGuardUpstreamAutomationInput } from '../../electron-main/paradisExtensionInputGuard.js';

const EXTENSION_MENU = 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/menu.html';

/** A page with, from left to right: an extension's menu iframe (x < 100), a web iframe (x < 200), an iframe without src (x < 300), a button. */
function fakePage(withExtensionFrame: boolean, focusedFrameUrl?: string) {
	const calls: string[] = [];
	const main = { url: 'https://example.test/' } as { url: string; framesInSubtree: unknown[] };
	main.framesInSubtree = withExtensionFrame ? [main, { url: EXTENSION_MENU }] : [main];
	const webContents = { mainFrame: main, focusedFrame: focusedFrameUrl ? { url: focusedFrameUrl } : null } as unknown as ParadisInputGuardWebContents;
	const send = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
		calls.push(method);
		if (method === 'DOM.getNodeForLocation') {
			const x = params.x as number;
			if (x > 1000) {
				throw new Error('No node found at given location');
			}
			return { backendNodeId: x < 100 ? 1 : x < 200 ? 2 : x < 300 ? 3 : 4 };
		}
		const id = params.backendNodeId;
		return {
			node: id === 1 ? { nodeName: 'IFRAME', attributes: ['style', 'border:0', 'src', EXTENSION_MENU] }
				: id === 2 ? { nodeName: 'IFRAME', attributes: ['src', 'https://pay.example/'] }
					: id === 3 ? { nodeName: 'IFRAME', attributes: [] }
						: { nodeName: 'BUTTON', attributes: [] },
		};
	};
	return { webContents, send, calls };
}

suite('paradisExtensionInputGuard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('refuses presses, taps, drops and keys that reach an extension frame, and asks nothing when the tab has none', async () => {
		const page = fakePage(true);
		const refused = async (method: string, params: object) => await paradisExtensionInputRefusal(page.webContents, page.send, method, params) === PARADIS_EXTENSION_INPUT_DENIED_MESSAGE;
		const results = {
			pressOnMenu: await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 10 }),
			releaseOnMenu: await refused('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 10 }),
			moveOnMenu: await refused('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: 10 }),
			pressOnWebFrame: await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 10 }),
			pressOnBlankFrame: await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 250, y: 10 }),
			pressOnButton: await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 350, y: 10 }),
			pressOutside: await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2000, y: 10 }),
			tapOnMenu: await refused('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 350, y: 1 }, { x: 50, y: 1 }] }),
			dropOnMenu: await refused('Input.dispatchDragEvent', { type: 'drop', x: 50, y: 10, data: { items: [], dragOperationsMask: 1 } }),
			keyOnPage: await refused('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }),
		};
		const quiet = fakePage(false);
		const withoutExtensionFrame = await paradisExtensionInputRefusal(quiet.webContents, quiet.send, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 10 });
		const focused = fakePage(false, EXTENSION_MENU);
		const keyInMenu = await paradisExtensionInputRefusal(focused.webContents, focused.send, 'Input.insertText', { text: 'secret' });
		assert.deepStrictEqual({ results, withoutExtensionFrame, asked: quiet.calls, keyInMenu }, {
			results: {
				pressOnMenu: true, releaseOnMenu: true, moveOnMenu: false, pressOnWebFrame: false, pressOnBlankFrame: true,
				pressOnButton: false, pressOutside: false, tapOnMenu: true, dropOnMenu: true, keyOnPage: false,
			},
			withoutExtensionFrame: undefined,
			asked: [],
			keyInMenu: PARADIS_EXTENSION_INPUT_DENIED_MESSAGE,
		});
	});

	test('guards input that upstream sends through the BrowserView debugger, on the page and on its own page session', async () => {
		const page = fakePage(true);
		let interceptor: ((method: string, params: unknown, session: unknown) => Promise<unknown> | undefined) | undefined;
		const sent: Array<{ method: string; sessionId?: string }> = [];
		const upstreamDebugger = {
			targetId: 'page-target',
			registerCommandInterceptor: (value: typeof interceptor) => { interceptor = value; },
			sendCommandRaw: async (method: string, params?: unknown, sessionId?: string) => {
				if (method.startsWith('DOM.')) {
					return page.send(method, params as Record<string, unknown>);
				}
				sent.push({ method, sessionId });
				return {};
			},
		};
		const view = { webContents: page.webContents, debugger: upstreamDebugger };
		paradisGuardUpstreamAutomationInput(view);
		paradisGuardUpstreamAutomationInput(view);
		const outcome = async (result: Promise<unknown> | undefined) => result === undefined ? 'passed through' : result.then(() => 'sent', (error: Error) => error.message === PARADIS_EXTENSION_INPUT_DENIED_MESSAGE ? 'refused' : 'error');
		const pageSession = { sessionId: 'S1', targetId: 'page-target' };
		const frameSession = { sessionId: 'S2', targetId: 'oopif-target' };
		const results = [
			await outcome(interceptor!('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 1 }, pageSession)),
			await outcome(interceptor!('Input.dispatchMouseEvent', { type: 'mousePressed', x: 350, y: 1 }, pageSession)),
			await outcome(interceptor!('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 1 }, undefined)),
			await outcome(interceptor!('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 1 }, frameSession)),
			await outcome(interceptor!('Runtime.evaluate', { expression: '1' }, pageSession)),
		];
		assert.deepStrictEqual({ results, sent }, {
			results: ['refused', 'sent', 'refused', 'passed through', 'passed through'],
			sent: [{ method: 'Input.dispatchMouseEvent', sessionId: 'S1' }],
		});
	});
});
