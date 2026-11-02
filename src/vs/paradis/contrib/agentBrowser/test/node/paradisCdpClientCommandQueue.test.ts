/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCdpClientCommandQueue } from '../../node/paradisCdpClientCommandQueue.js';

suite('ParadisCdpClientCommandQueue', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs commands of one key in order, does not hold other keys, counts only waiting ones, and fails on a throw', async () => {
		const log: string[] = [];
		const gates = new Map<string, DeferredPromise<void>>();
		let failures = 0;
		const queue = new ParadisCdpClientCommandQueue(data => {
			const name = String(data);
			log.push(`start ${name}`);
			if (name === 'throw') {
				throw new Error('boom');
			}
			const gate = gates.get(name);
			return gate?.p.then(() => { log.push(`end ${name}`); });
		}, () => failures++, 2, 100);
		gates.set('a1', new DeferredPromise());
		queue.enqueue(Buffer.from('a1'), 10, 'A');
		queue.enqueue(Buffer.from('a2'), 10, 'A');
		queue.enqueue(Buffer.from('b1'), 10, 'B');
		const whileWaiting = { log: [...log], full: [queue.isFull(90), queue.isFull(91)] };
		queue.enqueue(Buffer.from('a3'), 10, 'A');
		const fullOfMessages = queue.isFull(0);
		gates.get('a1')!.complete();
		await new Promise(resolve => setTimeout(resolve, 0));
		queue.enqueue(Buffer.from('throw'), 1, 'C');
		assert.deepStrictEqual({ whileWaiting, fullOfMessages, log, failures, emptyAgain: queue.isFull(100) }, {
			// a2 waits behind a1 (and is counted); b1 on another key runs at once
			whileWaiting: { log: ['start a1', 'start b1'], full: [false, true] },
			fullOfMessages: true,
			log: ['start a1', 'start b1', 'end a1', 'start a2', 'start a3', 'start throw'],
			failures: 1,
			emptyAgain: false,
		});
	});
});
