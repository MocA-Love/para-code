/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ParadisCoalescedRun } from '../../common/paradisCoalescedRun.js';
import { paradisMapLimited } from '../../common/paradisMapLimited.js';

suite('paradisMapLimited', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the order, runs at most `limit` at once, and handles an empty list and a limit below one', async () => {
		let running = 0;
		let most = 0;
		const result = await paradisMapLimited([30, 10, 20, 0, 5], 2, async (delay, index) => {
			running++;
			most = Math.max(most, running);
			await new Promise(resolve => setTimeout(resolve, delay));
			running--;
			return index;
		});
		assert.deepStrictEqual({
			result,
			most,
			empty: await paradisMapLimited([], 4, async () => 1),
			zeroLimit: await paradisMapLimited(['a', 'b'], 0, async item => item),
		}, { result: [0, 1, 2, 3, 4], most: 2, empty: [], zeroLimit: ['a', 'b'] });
	});

	test('stops taking new items after a failure and rejects with the first failure', async () => {
		const started: number[] = [];
		await assert.rejects(paradisMapLimited([0, 1, 2, 3], 1, async item => {
			started.push(item);
			if (item === 1) {
				throw new Error('failed at 1');
			}
		}), /failed at 1/);
		assert.deepStrictEqual(started, [0, 1]);
	});
});

suite('ParadisCoalescedRun', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs one at a time and folds the requests made during a run into one more run', async () => {
		const gates: DeferredPromise<void>[] = [];
		const runner = new ParadisCoalescedRun(() => {
			const gate = new DeferredPromise<void>();
			gates.push(gate);
			return gate.p;
		});
		const first = runner.trigger();
		const second = runner.trigger();
		const third = runner.trigger();
		const whileFirst = gates.length;
		gates[0].complete();
		await first;
		// 走っている間の 2 件は、後の 1 回にまとまる
		await new Promise(resolve => setTimeout(resolve, 0));
		const afterFirst = gates.length;
		gates[1].complete();
		await Promise.all([second, third]);
		assert.deepStrictEqual({ whileFirst, afterFirst, sameQueued: second === third }, { whileFirst: 1, afterFirst: 2, sameQueued: true });
	});
});
