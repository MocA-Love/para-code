/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import assert from 'assert';
import { EventEmitter } from 'events';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisInputGuardTab, PARADIS_EXTENSION_FRAME_DENIED_MESSAGE, PARADIS_EXTENSION_INPUT_DENIED_MESSAGE, ParadisFrameTargetTracker, ParadisInputGuardWebContents, paradisExtensionInputRefusal, paradisGuardExtensionInput, paradisInputGuardTab, paradisInterceptUpstreamCommand } from '../../electron-main/paradisExtensionInputGuard.js';

const EXTENSION_MENU = 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/menu.html';

interface IFakeElement {
	/** Document rectangle (CSS pixels of that document). */
	readonly left: number; readonly top: number; readonly width: number; readonly height: number;
	readonly nodeName: string;
	readonly attributes?: string[];
	/** For a frame owner of an out-of-process frame: its frame id. */
	readonly frameId?: string;
}

interface IFakeDocument {
	readonly scrollY: number;
	/** Same-process frames of this document (frame id -> URL), as Page.getFrameTree lists them. */
	readonly localFrames?: Record<string, string>;
	/** Topmost first. */
	readonly elements: IFakeElement[];
}

/**
 * Behaves like Chromium as measured on Electron 43.7.7: DOM.getNodeForLocation takes document coordinates and
 * returns the frame owner of an out-of-process frame (and the node inside a same-process frame, e.g. BODY of an
 * about:blank iframe); DOM.getBoxModel gives the content quad in viewport coordinates.
 */
function fakeTab(documents: Record<string, IFakeDocument>, targets: Record<string, { url: string; sessionId?: string }>, options: { extensionFrameInTab?: boolean; focusedFrameUrl?: string; attachable?: Record<string, Record<string, { url: string; sessionId?: string }>> } = {}) {
	const asked: string[] = [];
	const main = { url: 'https://example.test/' } as { url: string; framesInSubtree: unknown[] };
	main.framesInSubtree = options.extensionFrameInTab === false ? [main] : [main, { url: EXTENSION_MENU }];
	const webContents = { mainFrame: main, focusedFrame: options.focusedFrameUrl ? { url: options.focusedFrameUrl } : null } as unknown as ParadisInputGuardWebContents;
	const nodes: IFakeElement[] = [];
	const tab: IParadisInputGuardTab = {
		webContents,
		frameTarget: frameId => targets[frameId],
		...(options.attachable ? {
			attachChildren: async (sessionId: string) => {
				asked.push(`Target.setAutoAttach@${sessionId}`);
				Object.assign(targets, options.attachable![sessionId] ?? {});
			},
		} : {}),
		send: async (method, params, sessionId) => {
			asked.push(`${method}@${sessionId ?? 'page'}`);
			const doc = documents[sessionId ?? 'page'];
			switch (method) {
				case 'Page.getLayoutMetrics':
					return { cssVisualViewport: { pageX: 0, pageY: doc.scrollY, scale: 1 } };
				case 'DOM.getNodeForLocation': {
					const x = params.x as number;
					const y = params.y as number;
					const element = doc.elements.find(e => x >= e.left && x < e.left + e.width && y >= e.top && y < e.top + e.height);
					if (!element) {
						throw new Error('No node found at given location');
					}
					nodes.push(element);
					return { backendNodeId: nodes.length - 1 };
				}
				case 'DOM.describeNode': {
					const element = nodes[params.backendNodeId as number];
					return { node: { nodeName: element.nodeName, attributes: element.attributes ?? [], ...(element.frameId ? { frameId: element.frameId } : {}) } };
				}
				case 'Page.getFrameTree':
					return { frameTree: { frame: { id: 'MAIN', url: 'https://example.test/' }, childFrames: Object.entries(doc.localFrames ?? {}).map(([id, url]) => ({ frame: { id, url } })) } };
				case 'DOM.getBoxModel': {
					const element = nodes[params.backendNodeId as number];
					const left = element.left;
					const top = element.top - doc.scrollY;
					return { model: { content: [left, top, left + element.width, top, left + element.width, top + element.height, left, top + element.height] } };
				}
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	return { tab, asked };
}

const BODY: IFakeElement = { left: 0, top: 0, width: 5000, height: 5000, nodeName: 'BODY' };

suite('paradisExtensionInputGuard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hit-tests in document coordinates on a scrolled page', async () => {
		// The menu is at document y 750..850; the page is scrolled by 600, so it shows at viewport y 150..250.
		const { tab } = fakeTab({ page: { scrollY: 600, elements: [{ left: 100, top: 750, width: 200, height: 100, nodeName: 'IFRAME', attributes: ['src', EXTENSION_MENU], frameId: 'EXT1' }, { left: 0, top: 0, width: 50, height: 5000, nodeName: 'INPUT' }, BODY] } }, { EXT1: { url: EXTENSION_MENU } });
		const press = async (x: number, y: number) => await paradisExtensionInputRefusal(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }) !== undefined;
		assert.deepStrictEqual({
			menuOnScreen: await press(150, 200),
			sameViewportPointUnscrolledWouldBe: await press(150, 760),
			input: await press(20, 200),
		}, { menuOnScreen: true, sameViewportPointUnscrolledWouldBe: false, input: false });
	});

	test('judges a frame by the URL it shows, not its src, and looks into out-of-process web frames', async () => {
		const page: IFakeDocument = {
			scrollY: 0, localFrames: { LOCAL: 'about:blank' }, elements: [
				// src is a web page, but the frame moved itself to an extension page.
				{ left: 0, top: 0, width: 100, height: 100, nodeName: 'IFRAME', attributes: ['src', 'https://example.test/nav'], frameId: 'MOVED' },
				// A cross-origin login widget with an extension menu inside it at its own (100..300, 100..200).
				{ left: 200, top: 0, width: 500, height: 400, nodeName: 'IFRAME', attributes: ['src', 'https://widget.example/'], frameId: 'WIDGET' },
				// A same-process about:blank frame: Chromium answers with the node inside it, and with the frame
				// element itself on its border.
				{ left: 0, top: 500, width: 100, height: 100, nodeName: 'BODY' },
				{ left: 0, top: 490, width: 100, height: 10, nodeName: 'IFRAME', attributes: [], frameId: 'LOCAL' },
				BODY,
			],
		};
		const widget: IFakeDocument = { scrollY: 0, elements: [{ left: 100, top: 100, width: 200, height: 100, nodeName: 'IFRAME', attributes: ['src', EXTENSION_MENU], frameId: 'EXT2' }, { left: 0, top: 0, width: 50, height: 50, nodeName: 'INPUT' }, BODY] };
		const { tab } = fakeTab({ page, 'S-WIDGET': widget }, { MOVED: { url: EXTENSION_MENU, sessionId: 'S-MOVED' }, WIDGET: { url: 'https://widget.example/', sessionId: 'S-WIDGET' }, EXT2: { url: EXTENSION_MENU } });
		const press = async (x: number, y: number) => await paradisExtensionInputRefusal(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }) !== undefined;
		assert.deepStrictEqual({
			movedFrame: await press(50, 50),
			menuInsideWidget: await press(200 + 150, 150),
			inputInsideWidget: await press(200 + 20, 20),
			blankFrame: await press(50, 550),
			blankFrameBorder: await press(50, 495),
			page: await press(800, 800),
		}, { movedFrame: true, menuInsideWidget: true, inputInsideWidget: false, blankFrame: false, blankFrameBorder: false, page: false });
	});

	test('looks past the second level by auto-attaching the frame it is in', async () => {
		// page -> WIDGET (attached by upstream) -> DEEP (not attached until asked) -> extension menu
		const page: IFakeDocument = { scrollY: 0, elements: [{ left: 0, top: 0, width: 700, height: 500, nodeName: 'IFRAME', attributes: ['src', 'https://a.example/'], frameId: 'WIDGET' }, BODY] };
		const widget: IFakeDocument = { scrollY: 0, elements: [{ left: 0, top: 0, width: 700, height: 500, nodeName: 'IFRAME', attributes: ['src', 'https://b.example/'], frameId: 'DEEP' }, BODY] };
		const deep: IFakeDocument = { scrollY: 0, elements: [{ left: 100, top: 100, width: 200, height: 100, nodeName: 'IFRAME', attributes: [], frameId: 'EXT3' }, BODY] };
		const { tab, asked } = fakeTab({ page, 'S-WIDGET': widget, 'S-DEEP': deep }, { WIDGET: { url: 'https://a.example/', sessionId: 'S-WIDGET' } }, {
			attachable: { 'S-WIDGET': { DEEP: { url: 'https://b.example/', sessionId: 'S-DEEP' } }, 'S-DEEP': { EXT3: { url: EXTENSION_MENU } } },
		});
		const press = async (x: number, y: number) => await paradisExtensionInputRefusal(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }) !== undefined;
		assert.deepStrictEqual({
			outsideTheMenu: await press(400, 400),
			onTheMenu: await press(150, 150),
			autoAttached: asked.filter(call => call.startsWith('Target.setAutoAttach')),
		}, { outsideTheMenu: false, onTheMenu: true, autoAttached: ['Target.setAutoAttach@S-WIDGET', 'Target.setAutoAttach@S-DEEP'] });
	});

	test('treats an out-of-process frame it cannot look into as the extension only when the tab has one, and asks nothing without one', async () => {
		const page: IFakeDocument = { scrollY: 0, elements: [{ left: 0, top: 0, width: 100, height: 100, nodeName: 'IFRAME', attributes: ['src', 'https://example.test/'], frameId: 'UNKNOWN' }, BODY] };
		const withExtension = fakeTab({ page }, {});
		const without = fakeTab({ page }, {}, { extensionFrameInTab: false });
		const press = { type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1 };
		assert.deepStrictEqual({
			withExtension: await paradisExtensionInputRefusal(withExtension.tab, 'Input.dispatchMouseEvent', press),
			without: await paradisExtensionInputRefusal(without.tab, 'Input.dispatchMouseEvent', press),
			askedWithout: without.asked,
		}, { withExtension: PARADIS_EXTENSION_INPUT_DENIED_MESSAGE, without: undefined, askedWithout: [] });
	});

	test('moves the release of a press it let through off the extension UI, refuses keys into an extension frame, and covers taps and drops', async () => {
		const page: IFakeDocument = { scrollY: 0, elements: [{ left: 0, top: 0, width: 100, height: 100, nodeName: 'IFRAME', attributes: [], frameId: 'EXT1' }, BODY] };
		const { tab } = fakeTab({ page }, { EXT1: { url: EXTENSION_MENU } });
		const refused = async (method: string, params: object) => await paradisExtensionInputRefusal(tab, method, params) !== undefined;
		const results = [
			// Pressed outside the menu, released over it: the release must go, or the button stays down in the page.
			await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 500, button: 'left', clickCount: 1 }),
			await refused('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 }),
			// Pressed on the menu: both refused.
			await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1 }),
			await refused('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 }),
			await refused('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: 50 }),
			await refused('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 1 }, { x: 50, y: 1 }] }),
			await refused('Input.dispatchDragEvent', { type: 'drop', x: 50, y: 50, data: { items: [], dragOperationsMask: 1 } }),
			await refused('Input.insertText', { text: 'a' }),
		];
		const focused = fakeTab({ page }, {}, { focusedFrameUrl: EXTENSION_MENU });
		results.push(await paradisExtensionInputRefusal(focused.tab, 'Input.insertText', { text: 'secret' }) !== undefined);
		assert.deepStrictEqual(results, [false, false, true, true, false, true, true, false, true]);

		// The release is moved back to where the button went down; a release with no press of its button is judged where it is.
		const moved = fakeTab({ page }, { EXT1: { url: EXTENSION_MENU } });
		const verdicts = [
			await paradisGuardExtensionInput(moved.tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 500, button: 'left', clickCount: 1 }),
			await paradisGuardExtensionInput(moved.tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 600, button: 'right', clickCount: 1 }),
			await paradisGuardExtensionInput(moved.tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 }),
			// The right button was pressed and never released through the guard; a later lone left release on the menu is refused.
			await paradisGuardExtensionInput(moved.tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 }),
			await paradisGuardExtensionInput(moved.tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'right', clickCount: 1 }),
		];
		assert.deepStrictEqual(verdicts.map(verdict => verdict.refusal !== undefined ? 'refused' : verdict.params ? `moved to ${verdict.params.x},${verdict.params.y}` : 'sent'), [
			'sent', 'sent', 'moved to 500,500', 'refused', 'moved to 600,600',
		]);
	});

	test('upstream commands: page input is judged, extension frame sessions are refused, the rest passes through, and the guard is released with the view', async () => {
		const page: IFakeDocument = { scrollY: 0, elements: [{ left: 0, top: 0, width: 100, height: 100, nodeName: 'IFRAME', attributes: [], frameId: 'EXT1' }, BODY] };
		const { tab } = fakeTab({ page }, { EXT1: { url: EXTENSION_MENU } });
		const tracker = new ParadisFrameTargetTracker();
		tracker.onMessage('Target.attachedToTarget', { sessionId: 'S-EXT', targetInfo: { targetId: 'EXT1', type: 'iframe', url: EXTENSION_MENU } });
		tracker.onMessage('Target.attachedToTarget', { sessionId: 'S-WEB', targetInfo: { targetId: 'WEB1', type: 'iframe', url: 'https://widget.example/' } });
		const sent: string[] = [];
		const upstreamDebugger = {
			targetId: 'PAGE',
			registerCommandInterceptor: () => ({ dispose() { } }),
			sendCommandRaw: async (method: string, _params?: unknown, sessionId?: string) => { sent.push(`${method}@${sessionId}`); return {}; },
		};
		const outcome = async (result: Promise<unknown> | undefined) => result === undefined ? 'passed through' : result.then(() => 'sent', (error: Error) => error.message === PARADIS_EXTENSION_INPUT_DENIED_MESSAGE ? 'refused input' : error.message === PARADIS_EXTENSION_FRAME_DENIED_MESSAGE ? 'refused frame' : 'error');
		const run = (method: string, params: object, session: object | undefined) => outcome(paradisInterceptUpstreamCommand(tab, tracker, upstreamDebugger, method, params, session));
		const results = [
			await run('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1 }, { sessionId: 'S-PAGE', targetId: 'PAGE' }),
			await run('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 50, button: 'left', clickCount: 1 }, { sessionId: 'S-PAGE', targetId: 'PAGE' }),
			await run('Runtime.evaluate', { expression: 'document.body.innerText' }, { sessionId: 'S-EXT', targetId: 'EXT1' }),
			await run('Runtime.enable', {}, { sessionId: 'S-EXT', targetId: 'EXT1' }),
			await run('Runtime.evaluate', { expression: '1' }, { sessionId: 'S-WEB', targetId: 'WEB1' }),
			await run('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 50 }, undefined),
		];
		// A web frame that moves itself to an extension page is caught by its targetInfoChanged.
		tracker.onMessage('Target.targetInfoChanged', { targetInfo: { targetId: 'WEB1', type: 'iframe', url: EXTENSION_MENU } });
		results.push(await run('Runtime.evaluate', { expression: '1' }, { sessionId: 'S-WEB', targetId: 'WEB1' }));

		// An extension frame session is detached as soon as it is attached (so no events of the extension page reach
		// upstream's agent tools); the interceptor and the event listener go away with the view.
		const electronDebugger = new EventEmitter();
		const webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'https://example.test/', framesInSubtree: [] }, focusedFrame: null, debugger: electronDebugger });
		let disposed = 0;
		const detached: string[] = [];
		paradisInputGuardTab({
			webContents: webContents as never,
			debugger: { ...upstreamDebugger, registerCommandInterceptor: () => ({ dispose() { disposed++; } }), sendCommandRaw: async (method: string, params?: { sessionId?: string }, sessionId?: string) => { detached.push(`${method} ${params?.sessionId}@${sessionId}`); return {}; } } as never,
		});
		electronDebugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'S-WEB2', targetInfo: { targetId: 'WEB2', type: 'iframe', url: 'https://widget.example/' } }, 'S-PAGE');
		electronDebugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'S-EXT2', targetInfo: { targetId: 'EXT2', type: 'iframe', url: EXTENSION_MENU } }, 'S-WEB2');
		// The detach is sent on the next turn (sending from inside a debugger event can crash Electron).
		await new Promise(resolve => setTimeout(resolve, 0));
		const listenersWhileAlive = electronDebugger.listenerCount('message');
		webContents.emit('destroyed');
		assert.deepStrictEqual({ results, sent, detached, listenersWhileAlive, listenersAfter: electronDebugger.listenerCount('message'), disposed }, {
			results: ['refused input', 'sent', 'refused frame', 'refused frame', 'passed through', 'passed through', 'refused frame'],
			sent: ['Input.dispatchMouseEvent@S-PAGE'],
			detached: ['Target.detachFromTarget S-EXT2@S-WEB2'],
			listenersWhileAlive: 1,
			listenersAfter: 0,
			disposed: 1,
		});
	});
});
