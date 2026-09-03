/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FindInFrameOptions, FoundInFrameResult } from '../../common/webviewManagerService.js';
import { paradisFindInWebviewFrame, IParadisWebviewFindFrame, paradisStopFindInWebviewFrame } from '../../electron-main/paradisWebviewFrameFind.js';

suite('Webview frame find fallback contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports a missing frame or stock Electron frame as unsupported', () => {
		const stockFrame = frameWithoutFind();
		assert.deepStrictEqual([
			paradisFindInWebviewFrame(undefined, 'term', {}, () => assert.fail('missing frame emitted a result')),
			paradisStopFindInWebviewFrame(undefined, false),
			paradisFindInWebviewFrame(stockFrame, 'term', { findNext: true }, () => assert.fail('stock frame emitted a result')),
			paradisStopFindInWebviewFrame(stockFrame, true),
		], [false, false, false, false]);
	});

	test('uses Electron find when available and forwards only the final result', () => {
		const findCalls: { readonly text: string; readonly options: FindInFrameOptions }[] = [];
		const stopCalls: string[] = [];
		const listeners = new Set<(event: unknown, result: FoundInFrameResult) => void>();
		const frame: IParadisWebviewFindFrame = {
			findInFrame: (text, options) => findCalls.push({ text, options }),
			stopFindInFrame: option => stopCalls.push(option),
			on(_event, listener) { listeners.add(listener); return this; },
			removeListener(_event, listener) { listeners.delete(listener); return this; },
		};
		const results: FoundInFrameResult[] = [];

		assert.strictEqual(paradisFindInWebviewFrame(frame, 'needle', { findNext: true, forward: false }, result => results.push(result)), true);
		assert.deepStrictEqual(findCalls, [{ text: 'needle', options: { findNext: true, forward: false } }]);
		assert.strictEqual(listeners.size, 1);

		const listener = [...listeners][0];
		assert.ok(listener);
		listener(undefined, { requestId: 1, activeMatchOrdinal: 1, matches: 2, finalUpdate: false });
		assert.deepStrictEqual(results, []);
		assert.strictEqual(listeners.size, 1);

		const finalResult = { requestId: 1, activeMatchOrdinal: 2, matches: 2, finalUpdate: true };
		listener(undefined, finalResult);
		assert.deepStrictEqual(results, [finalResult]);
		assert.strictEqual(listeners.size, 0);

		assert.strictEqual(paradisStopFindInWebviewFrame(frame, true), true);
		assert.deepStrictEqual(stopCalls, ['keepSelection']);
	});
});

function frameWithoutFind(): IParadisWebviewFindFrame {
	return {
		on() { return this; },
		removeListener() { return this; },
	};
}
