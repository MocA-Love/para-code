/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortListPollTimer, ParadisPortListPolling } from '../../electron-browser/paradisPortListPolling.js';

class TestPollTimer implements IParadisPortListPollTimer {
	readonly intervals: number[] = [];
	private runner: (() => void) | undefined;
	get hasDeadline(): boolean { return this.runner !== undefined; }
	cancel(): void { this.runner = undefined; }
	cancelAndSet(runner: () => void, interval: number): void {
		this.runner = runner;
		this.intervals.push(interval);
	}
	fire(): void { this.runner?.(); }
}

suite('ParadisPortListPolling', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('owns a 15 second timer only while the panel is open', () => {
		const timer = new TestPollTimer();
		let polls = 0;
		const polling = store.add(new ParadisPortListPolling(timer, () => polls++));

		assert.deepStrictEqual(timer.intervals, []);
		assert.strictEqual(timer.hasDeadline, false);
		polling.setPanelOpen(true);
		polling.setPanelOpen(true);
		assert.deepStrictEqual(timer.intervals, [15_000]);
		timer.fire();
		assert.strictEqual(polls, 1);
		polling.setPanelOpen(false);
		assert.strictEqual(timer.hasDeadline, false);
		polling.setPanelOpen(true);
		assert.deepStrictEqual(timer.intervals, [15_000, 15_000]);
		polling.dispose();
		assert.strictEqual(timer.hasDeadline, false);
	});
});
