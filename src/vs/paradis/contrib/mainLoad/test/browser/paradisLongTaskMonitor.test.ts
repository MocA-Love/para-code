/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisLongTaskObserver, paradisStartLongTaskWindow } from '../../browser/paradisLongTaskMonitor.js';

suite('ParadisLongTaskMonitor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts the long tasks of a window, including the ones not delivered yet, and stops observing', () => {
		const log: string[] = [];
		let deliver: (entries: readonly { readonly duration: number }[]) => void = () => { };
		const window = paradisStartLongTaskWindow(onEntries => {
			deliver = onEntries;
			return {
				observe: options => log.push(`observe:${options.type}`),
				takeRecords: () => [{ duration: 120.4 }],
				disconnect: () => log.push('disconnect'),
			} satisfies IParadisLongTaskObserver;
		});
		deliver([{ duration: 60 }, { duration: 250.6 }]);
		const summary = window.stop();
		assert.deepStrictEqual({ summary, again: window.stop(), log }, {
			summary: { count: 3, totalMs: 431, maxMs: 251 },
			again: undefined,
			log: ['observe:longtask', 'disconnect'],
		});
	});

	test('reports nothing where long tasks cannot be observed', () => {
		assert.deepStrictEqual({
			unsupported: paradisStartLongTaskWindow(() => undefined).stop(),
			throwing: paradisStartLongTaskWindow(() => { throw new Error('no observer'); }).stop(),
		}, { unsupported: undefined, throwing: undefined });
	});
});
