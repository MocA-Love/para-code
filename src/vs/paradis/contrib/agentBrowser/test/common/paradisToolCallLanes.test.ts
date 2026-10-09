/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisToolCallLanes } from '../../common/paradisToolCallLanes.js';

interface IGate {
	readonly promise: Promise<void>;
	open(): void;
}

function gate(): IGate {
	let open!: () => void;
	const promise = new Promise<void>(resolve => { open = resolve; });
	return { promise, open };
}

/** マイクロタスクを流し切る（列の次の番が始まるのを待つ）。 */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

suite('Para Browser tool call lanes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs calls on the same tab one at a time in arrival order, and calls on other tabs alongside them', async () => {
		const lanes = new ParadisToolCallLanes();
		const events: string[] = [];
		const gates = new Map([['a1', gate()], ['a2', gate()], ['b1', gate()]]);
		const call = (key: string, id: string) => lanes.run(key, async () => {
			events.push(`start ${id}`);
			await gates.get(id)!.promise;
			events.push(`end ${id}`);
			return id;
		});
		const results = [call('tab-a', 'a1'), call('tab-a', 'a2'), call('tab-b', 'b1')];
		await settle();
		const whileA1Runs = [...events];
		gates.get('a2')!.open();
		gates.get('b1')!.open();
		await settle();
		const afterB1 = [...events];
		gates.get('a1')!.open();
		assert.deepStrictEqual({
			results: await Promise.all(results),
			whileA1Runs,
			afterB1,
			events,
			busyAfter: lanes.isBusy('tab-a') || lanes.isBusy('tab-b'),
		}, {
			results: ['a1', 'a2', 'b1'],
			whileA1Runs: ['start a1', 'start b1'],
			afterB1: ['start a1', 'start b1', 'end b1'],
			events: ['start a1', 'start b1', 'end b1', 'end a1', 'start a2', 'end a2'],
			busyAfter: false,
		});
	});

	test('a failing call does not block the next call on the same tab', async () => {
		const lanes = new ParadisToolCallLanes();
		const first = lanes.run('tab', async () => { throw new Error('boom'); });
		const second = lanes.run('tab', async () => 'next');
		await assert.rejects(first, /boom/);
		assert.strictEqual(await second, 'next');
	});

	test('a call cancelled while it waits leaves the lane without running, and later calls still wait for the running one', async () => {
		const lanes = new ParadisToolCallLanes();
		const events: string[] = [];
		const running = gate();
		const first = lanes.run('tab', async () => {
			events.push('start first');
			await running.promise;
			events.push('end first');
		});
		const controller = new AbortController();
		const cancelled = lanes.run('tab', async () => { events.push('start cancelled'); }, controller.signal);
		const third = lanes.run('tab', async () => { events.push('start third'); });
		await settle();
		controller.abort();
		await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError');
		await settle();
		const beforeFirstEnds = [...events];
		running.open();
		await Promise.all([first, third]);
		assert.deepStrictEqual({ beforeFirstEnds, events }, {
			beforeFirstEnds: ['start first'],
			events: ['start first', 'end first', 'start third'],
		});
	});
});
