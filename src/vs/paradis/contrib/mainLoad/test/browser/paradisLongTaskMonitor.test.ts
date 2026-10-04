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

	test('takes running totals without stopping, so a phase can be the difference of two snapshots', () => {
		let deliver: (entries: readonly { readonly duration: number }[]) => void = () => { };
		let pending: { readonly duration: number }[] = [];
		const log: string[] = [];
		const window = paradisStartLongTaskWindow(onEntries => {
			deliver = onEntries;
			return {
				observe: () => { },
				takeRecords: () => {
					const records = pending;
					pending = [];
					return records;
				},
				disconnect: () => log.push('disconnect'),
			} satisfies IParadisLongTaskObserver;
		});
		deliver([{ duration: 80 }]);
		const before = window.snapshot();
		// 配られていない分も snapshot が拾う。
		pending = [{ duration: 200.4 }];
		const after = window.snapshot();
		const final = window.stop();
		assert.deepStrictEqual({ before, after, final, afterStop: window.snapshot(), log }, {
			before: { count: 1, totalMs: 80, maxMs: 80 },
			after: { count: 2, totalMs: 280, maxMs: 200 },
			final: { count: 2, totalMs: 280, maxMs: 200 },
			afterStop: undefined,
			log: ['disconnect'],
		});
	});

	test('reports nothing where long tasks cannot be observed', () => {
		assert.deepStrictEqual({
			unsupported: paradisStartLongTaskWindow(() => undefined).stop(),
			unsupportedSnapshot: paradisStartLongTaskWindow(() => undefined).snapshot(),
			throwing: paradisStartLongTaskWindow(() => { throw new Error('no observer'); }).stop(),
		}, { unsupported: undefined, unsupportedSnapshot: undefined, throwing: undefined });
	});
});
