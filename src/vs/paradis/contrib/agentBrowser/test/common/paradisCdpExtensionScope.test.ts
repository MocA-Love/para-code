/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_EXTENSION_NAVIGATION_DENIED_MESSAGE, PARADIS_EXTENSION_PAGE_DENIED_MESSAGE, PARADIS_HIDDEN_EXTENSION_FRAME_URL, paradisExtensionPageDeniedMessage, paradisGuardNewDocumentScriptParams, paradisIsBrowserExtensionUrl, paradisIsEventAllowedOnExtensionPage, paradisRedactExtensionFrameEvent, paradisRedactExtensionFrameResponse } from '../../common/paradisCdpExtensionScope.js';

const EXTENSION = 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa';

suite('paradisCdpExtensionScope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes every spelling Chromium resolves to an extension URL', () => {
		const inputs = [
			`${EXTENSION}/popup.html`,
			`CHROME-EXTENSION://AEBLFDKHHHDCDJPIFHHBDIOJPLFJNCOA/`,
			`  \t${EXTENSION}/x `,
			`chrome-ext\nension://id/x`,
			`blob:${EXTENSION}/1b2c`,
			`BLOB: ${EXTENSION}/1b2c`,
			`filesystem:${EXTENSION}/temporary/x`,
			`view-source:${EXTENSION}/options.html`,
			`view-source:blob:${EXTENSION}/x`,
			'https://chrome-extension.example/',
			'blob:https://example.test/1b2c',
			'about:blank',
			'',
		];
		assert.deepStrictEqual(inputs.map(paradisIsBrowserExtensionUrl).concat([paradisIsBrowserExtensionUrl(undefined), paradisIsBrowserExtensionUrl(42)]),
			[true, true, true, true, true, true, true, true, true, false, false, false, false, false, false]);
	});

	test('refuses extension navigations everywhere, and everything but leaving while on an extension page', () => {
		assert.deepStrictEqual([
			paradisExtensionPageDeniedMessage('Page.navigate', { url: `blob:${EXTENSION}/x` }, false),
			paradisExtensionPageDeniedMessage('Page.navigate', { url: 'https://example.test/' }, false),
			paradisExtensionPageDeniedMessage('Runtime.evaluate', { expression: '1' }, false),
			paradisExtensionPageDeniedMessage('Runtime.evaluate', { expression: '1' }, true),
			paradisExtensionPageDeniedMessage('DOM.getDocument', {}, true),
			paradisExtensionPageDeniedMessage('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, true),
			paradisExtensionPageDeniedMessage('Page.navigate', { url: 'https://example.test/' }, true),
			paradisExtensionPageDeniedMessage('Page.navigate', { url: `${EXTENSION}/options.html` }, true),
			paradisExtensionPageDeniedMessage('Runtime.runIfWaitingForDebugger', {}, true),
			// What puppeteer sends when it attaches, so navigate_page stays reachable
			paradisExtensionPageDeniedMessage('Runtime.enable', {}, true),
			paradisExtensionPageDeniedMessage('Page.getFrameTree', {}, true),
			paradisExtensionPageDeniedMessage('Page.addScriptToEvaluateOnNewDocument', { source: '', worldName: 'util' }, true),
			paradisExtensionPageDeniedMessage('Page.addScriptToEvaluateOnNewDocument', { source: '', runImmediately: true }, true),
			paradisExtensionPageDeniedMessage('Page.navigate', { url: ' JavaScript:alert(1)' }, true),
			paradisExtensionPageDeniedMessage('Page.navigate', { url: 'javascript:void 0' }, false),
		], [
			PARADIS_EXTENSION_NAVIGATION_DENIED_MESSAGE, undefined, undefined,
			PARADIS_EXTENSION_PAGE_DENIED_MESSAGE, PARADIS_EXTENSION_PAGE_DENIED_MESSAGE, PARADIS_EXTENSION_PAGE_DENIED_MESSAGE,
			undefined, PARADIS_EXTENSION_NAVIGATION_DENIED_MESSAGE, undefined,
			undefined, undefined, undefined, PARADIS_EXTENSION_PAGE_DENIED_MESSAGE,
			PARADIS_EXTENSION_PAGE_DENIED_MESSAGE, undefined,
		]);
		assert.deepStrictEqual(['Page.frameNavigated', 'Page.lifecycleEvent', 'Runtime.executionContextCreated', 'Target.attachedToTarget', 'Network.requestWillBeSent', 'Runtime.consoleAPICalled', 'DOM.documentUpdated', 'Page.javascriptDialogOpening'].map(paradisIsEventAllowedOnExtensionPage),
			[true, true, true, true, false, false, false, false]);
	});

	test('hides extension frame URLs and content-script stacks in page events and frame trees', () => {
		const hidden = { url: PARADIS_HIDDEN_EXTENSION_FRAME_URL, securityOrigin: 'null', domainAndRegistry: '' };
		assert.deepStrictEqual({
			navigated: paradisRedactExtensionFrameEvent('Page.frameNavigated', { frame: { id: 'F2', parentId: 'F1', url: `${EXTENSION}/menu.html`, urlFragment: '#x', securityOrigin: EXTENSION, mimeType: 'text/html' }, type: 'Navigation' }),
			ordinary: paradisRedactExtensionFrameEvent('Page.frameNavigated', { frame: { id: 'F1', url: 'https://example.test/', securityOrigin: 'https://example.test' } }),
			attached: paradisRedactExtensionFrameEvent('Page.frameAttached', { frameId: 'F2', parentFrameId: 'F1', stack: { callFrames: [{ url: 'https://example.test/app.js' }], parent: { callFrames: [{ url: `${EXTENSION}/cs.js` }] } } }),
			attachedByPage: paradisRedactExtensionFrameEvent('Page.frameAttached', { frameId: 'F2', parentFrameId: 'F1', stack: { callFrames: [{ url: 'https://example.test/app.js' }] } }),
			requested: paradisRedactExtensionFrameEvent('Page.frameRequestedNavigation', { frameId: 'F2', url: `${EXTENSION}/menu.html`, reason: 'scriptInitiated' }),
			tree: paradisRedactExtensionFrameResponse('Page.getResourceTree', {
				frameTree: {
					frame: { id: 'F1', url: 'https://example.test/', securityOrigin: 'https://example.test' },
					resources: [{ url: 'https://example.test/app.js' }, { url: `${EXTENSION}/inject.css` }],
					childFrames: [{ frame: { id: 'F2', parentId: 'F1', url: `${EXTENSION}/menu.html`, securityOrigin: EXTENSION }, resources: [{ url: `${EXTENSION}/menu.js` }] }],
				},
			}),
			other: paradisRedactExtensionFrameResponse('Runtime.evaluate', { result: {} }),
		}, {
			navigated: { frame: { id: 'F2', parentId: 'F1', mimeType: 'text/html', ...hidden }, type: 'Navigation' },
			ordinary: undefined,
			attached: { frameId: 'F2', parentFrameId: 'F1' },
			attachedByPage: undefined,
			requested: { frameId: 'F2', url: PARADIS_HIDDEN_EXTENSION_FRAME_URL, reason: 'scriptInitiated' },
			tree: {
				frameTree: {
					frame: { id: 'F1', url: 'https://example.test/', securityOrigin: 'https://example.test' },
					resources: [{ url: 'https://example.test/app.js' }],
					childFrames: [{ frame: { id: 'F2', parentId: 'F1', ...hidden }, resources: [] }],
				},
			},
			other: undefined,
		});
	});
	test('wraps new-document scripts so they run in web documents but not in extension documents', () => {
		const params = paradisGuardNewDocumentScriptParams('Page.addScriptToEvaluateOnNewDocument', { source: 'var ran = true; function helper() { return 1; }', worldName: 'util', runImmediately: false });
		// Run the wrapped source the way a new document would, with its own origin and location.
		const run = (origin: string, protocol: string) => new Function('globalThis', 'location', `var ran = false; ${(params as { source: string }).source}; return [ran, typeof helper];`)({ origin }, { protocol });
		assert.deepStrictEqual({
			rest: { ...params, source: undefined },
			web: run('https://example.test', 'https:'),
			extension: run('chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa', 'chrome-extension:'),
			blankInExtension: run('chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa', 'about:'),
			other: paradisGuardNewDocumentScriptParams('Runtime.evaluate', { expression: '1' }),
		}, {
			rest: { source: undefined, worldName: 'util', runImmediately: false },
			web: [true, 'function'],
			extension: [false, 'undefined'],
			blankInExtension: [false, 'undefined'],
			other: undefined,
		});
	});
});
