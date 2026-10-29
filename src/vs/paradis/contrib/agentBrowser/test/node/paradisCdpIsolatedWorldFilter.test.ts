/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCdpIsolatedWorldFilter } from '../../node/paradisCdpIsolatedWorldFilter.js';

function created(id: number, uniqueId: string, isDefault: boolean, name = '') {
	return { context: { id, uniqueId, name, auxData: { isDefault, type: isDefault ? 'default' : 'isolated', frameId: 'F1' } } };
}

suite('ParadisCdpIsolatedWorldFilter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hides Para Code isolated worlds and refuses any context the client was not shown', () => {
		const filter = new ParadisCdpIsolatedWorldFilter();
		assert.deepStrictEqual([
			filter.filterEvent('', 'Runtime.executionContextCreated', created(1, 'main', true)),
			filter.filterEvent('', 'Runtime.executionContextCreated', created(2, 'design', false)),
			filter.filterEvent('', 'Runtime.executionContextCreated', created(3, 'preload', false, 'Electron Isolated Context')),
		], ['forward', 'drop', 'drop']);
		assert.deepStrictEqual([
			filter.checkClientCommand('', 1, 'Runtime.evaluate', { expression: '1', contextId: 1 }),
			filter.checkClientCommand('', 2, 'Runtime.evaluate', { expression: '1' }),
			typeof filter.checkClientCommand('', 3, 'Runtime.evaluate', { expression: '1', contextId: 2 }),
			typeof filter.checkClientCommand('', 4, 'Runtime.evaluate', { expression: '1', contextId: 99 }),
			typeof filter.checkClientCommand('', 5, 'Runtime.evaluate', { expression: '1', uniqueContextId: 'design' }),
			typeof filter.checkClientCommand('', 6, 'DOM.resolveNode', { nodeId: 1, executionContextId: 3 }),
			typeof filter.checkClientCommand('', 7, 'Runtime.callFunctionOn', { functionDeclaration: 'f', objectId: '-123.2.4' }),
			filter.checkClientCommand('', 8, 'Runtime.callFunctionOn', { functionDeclaration: 'f', objectId: '-123.1.4' }),
		], [undefined, undefined, 'string', 'string', 'string', 'string', 'string', undefined]);
	});

	test('keeps showing isolated worlds the client itself asked for (puppeteer utility worlds), but never reserved names', () => {
		const filter = new ParadisCdpIsolatedWorldFilter();
		assert.strictEqual(filter.checkClientCommand('s1', 1, 'Page.addScriptToEvaluateOnNewDocument', { source: '', worldName: '__puppeteer_utility_world__' }), undefined);
		assert.strictEqual(filter.checkClientCommand('s1', 2, 'Page.createIsolatedWorld', { frameId: 'F1', worldName: 'Electron Isolated Context' }), undefined);
		filter.observeResponse('s1', 2, { executionContextId: 12 });
		assert.deepStrictEqual([
			filter.filterEvent('s1', 'Runtime.executionContextCreated', created(11, 'util', false, '__puppeteer_utility_world__')),
			filter.filterEvent('s1', 'Runtime.executionContextCreated', created(12, 'mine', false, 'Electron Isolated Context')),
			filter.filterEvent('s1', 'Runtime.executionContextCreated', created(13, 'preload', false, 'Electron Isolated Context')),
			filter.checkClientCommand('s1', 3, 'Runtime.evaluate', { expression: '1', contextId: 11 }),
			filter.checkClientCommand('s1', 4, 'Runtime.evaluate', { expression: '1', contextId: 12 }),
			typeof filter.checkClientCommand('s1', 5, 'Runtime.evaluate', { expression: '1', contextId: 13 }),
			typeof filter.checkClientCommand('s2', 6, 'Runtime.evaluate', { expression: '1', contextId: 11 }),
		], ['forward', 'forward', 'drop', undefined, undefined, 'string', 'string']);
	});

	test('hides scripts, console output and pauses that belong to a hidden world', () => {
		const filter = new ParadisCdpIsolatedWorldFilter();
		filter.filterEvent('', 'Runtime.executionContextCreated', created(1, 'main', true));
		filter.filterEvent('', 'Runtime.executionContextCreated', created(2, 'design', false));
		assert.deepStrictEqual([
			filter.filterEvent('', 'Debugger.scriptParsed', { scriptId: '10', url: '', executionContextId: 2, executionContextAuxData: { isDefault: false } }),
			filter.filterEvent('', 'Debugger.scriptParsed', { scriptId: '11', url: 'https://example.test/app.js', executionContextId: 1, executionContextAuxData: { isDefault: true } }),
			filter.filterEvent('', 'Debugger.scriptParsed', { scriptId: '12', url: 'https://example.test/other.js' }),
			typeof filter.checkClientCommand('', 1, 'Debugger.getScriptSource', { scriptId: '10' }),
			typeof filter.checkClientCommand('', 2, 'Debugger.setBreakpoint', { location: { scriptId: '10', lineNumber: 0 } }),
			filter.checkClientCommand('', 3, 'Debugger.getScriptSource', { scriptId: '11' }),
			filter.filterEvent('', 'Debugger.paused', { reason: 'other', callFrames: [{ callFrameId: 'c', location: { scriptId: '10', lineNumber: 0 } }] }),
			filter.filterEvent('', 'Debugger.paused', { reason: 'other', callFrames: [{ callFrameId: 'c', location: { scriptId: '11', lineNumber: 0 } }] }),
			filter.filterEvent('', 'Runtime.consoleAPICalled', { type: 'log', args: [], executionContextId: 2 }),
			filter.filterEvent('', 'Runtime.exceptionThrown', { exceptionDetails: { executionContextId: 2 } }),
			filter.filterEvent('', 'Runtime.executionContextDestroyed', { executionContextId: 2, executionContextUniqueId: 'design' }),
			filter.filterEvent('', 'Runtime.executionContextDestroyed', { executionContextId: 1, executionContextUniqueId: 'main' }),
		], ['drop', 'forward', 'forward', 'string', 'string', undefined, 'resume', 'forward', 'drop', 'drop', 'drop', 'forward']);
	});
	test('hides browser extension worlds by origin, even when the client asks for a world with the extension name', () => {
		// Payloads as Electron 43.7.7 reports them for a page with the bundled React DevTools and an extension iframe.
		const page = 'http://127.0.0.1:37669';
		const reactDevtools = 'chrome-extension://adnlghojmjmphkjpkaeikgdocfigikoh';
		const world = (id: number, name: string, origin: string, isDefault: boolean) => ({ context: { id, uniqueId: `u${id}`, name, origin, auxData: { isDefault, type: isDefault ? 'default' : 'isolated', frameId: 'F1' } } });
		const filter = new ParadisCdpIsolatedWorldFilter();
		const asked = filter.checkClientCommand('s1', 1, 'Page.createIsolatedWorld', { frameId: 'F1', worldName: 'React Developer Tools' });
		const events = [
			filter.filterEvent('s1', 'Runtime.executionContextCreated', world(1, '', page, true)),
			filter.filterEvent('s1', 'Runtime.executionContextCreated', world(3, 'React Developer Tools', reactDevtools, false)),
			filter.filterEvent('s1', 'Runtime.executionContextCreated', world(5, 'React Developer Tools', page, false)),
			// An extension page in a frame the page shares a process with: its main world is an extension world too.
			filter.filterEvent('s1', 'Runtime.executionContextCreated', world(6, '', 'chrome-extension://nlbcfljciijdbmfmbiaoelpjlhdgfhee', true)),
		];
		filter.observeResponse('s1', 1, { executionContextId: 5 });
		assert.deepStrictEqual({
			asked,
			events,
			evaluate: [
				typeof filter.checkClientCommand('s1', 2, 'Runtime.evaluate', { expression: '1', contextId: 3 }),
				typeof filter.checkClientCommand('s1', 3, 'Runtime.evaluate', { expression: '1', uniqueContextId: 'u3' }),
				typeof filter.checkClientCommand('s1', 4, 'Runtime.evaluate', { expression: '1', contextId: 6 }),
				filter.checkClientCommand('s1', 5, 'Runtime.evaluate', { expression: '1', contextId: 5 }),
			],
			script: filter.filterEvent('s1', 'Debugger.scriptParsed', { scriptId: '20', url: 'chrome-extension://adnlghojmjmphkjpkaeikgdocfigikoh/build/prepareInjection.js', executionContextId: 3, executionContextAuxData: { isDefault: false } }),
		}, {
			asked: undefined,
			events: ['forward', 'drop', 'forward', 'drop'],
			evaluate: ['string', 'string', 'string', undefined],
			script: 'drop',
		});
	});
	test('keeps an extension world hidden after the client creates one in an extension frame, whichever arrives first', () => {
		const extension = 'chrome-extension://nlbcfljciijdbmfmbiaoelpjlhdgfhee';
		const world = (id: number) => ({ context: { id, uniqueId: `u${id}`, name: 'mine', origin: extension, auxData: { isDefault: false, type: 'isolated', frameId: 'EXT' } } });
		const filter = new ParadisCdpIsolatedWorldFilter();
		filter.checkClientCommand('s1', 1, 'Page.createIsolatedWorld', { frameId: 'EXT', worldName: 'mine' });
		const eventFirst = filter.filterEvent('s1', 'Runtime.executionContextCreated', world(7));
		filter.observeResponse('s1', 1, { executionContextId: 7 });
		filter.checkClientCommand('s1', 2, 'Page.createIsolatedWorld', { frameId: 'EXT', worldName: 'mine' });
		filter.observeResponse('s1', 2, { executionContextId: 8 });
		const responseFirst = filter.filterEvent('s1', 'Runtime.executionContextCreated', world(8));
		assert.deepStrictEqual({
			events: [eventFirst, responseFirst],
			evaluate: [
				typeof filter.checkClientCommand('s1', 3, 'Runtime.evaluate', { expression: '1', contextId: 7 }),
				typeof filter.checkClientCommand('s1', 4, 'Runtime.evaluate', { expression: '1', contextId: 8 }),
				typeof filter.checkClientCommand('s1', 5, 'Runtime.evaluate', { expression: '1', uniqueContextId: 'u8' }),
			],
		}, { events: ['drop', 'drop'], evaluate: ['string', 'string', 'string'] });
	});

	test('knows a session whose own document is an extension page, until that document goes away', () => {
		const filter = new ParadisCdpIsolatedWorldFilter();
		const main = (id: number, origin: string) => ({ context: { id, uniqueId: `m${id}`, name: '', origin, auxData: { isDefault: true, type: 'default', frameId: 'F1' } } });
		const states: boolean[] = [filter.isOnExtensionPage('s1')];
		filter.filterEvent('s1', 'Runtime.executionContextCreated', main(1, 'https://example.test'));
		states.push(filter.isOnExtensionPage('s1'));
		filter.filterEvent('s1', 'Runtime.executionContextCreated', main(2, 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa'));
		states.push(filter.isOnExtensionPage('s1'), filter.isOnExtensionPage('s2'));
		filter.filterEvent('s1', 'Runtime.executionContextDestroyed', { executionContextId: 2, executionContextUniqueId: 'm2' });
		states.push(filter.isOnExtensionPage('s1'));
		filter.filterEvent('s1', 'Runtime.executionContextCreated', main(3, 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa'));
		filter.filterEvent('s1', 'Runtime.executionContextsCleared', {});
		states.push(filter.isOnExtensionPage('s1'));
		assert.deepStrictEqual(states, [false, false, true, false, false, false]);
	});

	test('refuses to evaluate on any paused call frame that belongs to a hidden world, not only the top one', () => {
		// As Electron 43.7.7 reports it: a page listener called synchronously by a content script's dispatchEvent.
		const filter = new ParadisCdpIsolatedWorldFilter();
		filter.filterEvent('', 'Runtime.executionContextCreated', { context: { id: 1, uniqueId: 'main', name: '', origin: 'http://127.0.0.1:45843', auxData: { isDefault: true, frameId: 'F1' } } });
		filter.filterEvent('', 'Runtime.executionContextCreated', { context: { id: 3, uniqueId: 'cs', name: 'Probe Two', origin: 'chrome-extension://peccpbngleohlifalhmmbmopmkilinpj', auxData: { isDefault: false, frameId: 'F1' } } });
		filter.filterEvent('', 'Debugger.scriptParsed', { scriptId: '40', url: 'chrome-extension://peccpbngleohlifalhmmbmopmkilinpj/cs.js', executionContextId: 3, executionContextAuxData: { isDefault: false } });
		filter.filterEvent('', 'Debugger.scriptParsed', { scriptId: '41', url: '', executionContextId: 1, executionContextAuxData: { isDefault: true } });
		const paused = filter.filterEvent('', 'Debugger.paused', {
			reason: 'other',
			callFrames: [
				{ callFrameId: '7791486334757065779.1.0', functionName: '', location: { scriptId: '41', lineNumber: 0 } },
				{ callFrameId: '7791486334757065779.3.1', functionName: '', location: { scriptId: '40', lineNumber: 2 } },
			],
		});
		const whilePaused = [
			filter.checkClientCommand('', 1, 'Debugger.evaluateOnCallFrame', { callFrameId: '7791486334757065779.1.0', expression: '1' }),
			typeof filter.checkClientCommand('', 2, 'Debugger.evaluateOnCallFrame', { callFrameId: '7791486334757065779.3.1', expression: 'window.__csSecret' }),
			typeof filter.checkClientCommand('', 3, 'Debugger.setVariableValue', { callFrameId: '7791486334757065779.3.1', scopeNumber: 0, variableName: 'x', newValue: { value: 1 } }),
		];
		filter.filterEvent('', 'Debugger.resumed', {});
		// A frame id the filter never saw still names the hidden context it came from.
		const afterResume = typeof filter.checkClientCommand('', 4, 'Debugger.evaluateOnCallFrame', { callFrameId: '123.3.0', expression: '1' });
		assert.deepStrictEqual({ paused, whilePaused, afterResume }, { paused: 'forward', whilePaused: [undefined, 'string', 'string'], afterResume: 'string' });
	});
});
