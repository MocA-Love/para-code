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
});
