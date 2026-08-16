/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisDoNotDisturbRefreshState,
	IParadisDoNotDisturbRefreshTimer,
	ParadisDoNotDisturbRefreshController,
	paradisCreateDoNotDisturbRefreshController,
	paradisGetDoNotDisturbRefreshDelay,
} from '../../common/paradisDoNotDisturb.js';

interface IManualTimerRecord {
	readonly callbackId: number;
	readonly callback: () => void;
	readonly delayMs: number;
	readonly returnedHandle: unknown;
	pending: boolean;
}

class ManualTimer implements IParadisDoNotDisturbRefreshTimer {
	private callbackId = 0;
	private readonly records: IManualTimerRecord[] = [];
	readonly clearArguments: unknown[] = [];

	constructor(private readonly returnUndefinedHandle = false) { }

	get pendingCount(): number {
		return this.records.filter(record => record.pending).length;
	}

	get setCount(): number {
		return this.records.length;
	}

	set(callback: () => void, delayMs: number): unknown {
		const callbackId = ++this.callbackId;
		const returnedHandle = this.returnUndefinedHandle ? undefined : { callbackId };
		this.records.push({ callbackId, callback, delayMs, returnedHandle, pending: true });
		return returnedHandle;
	}

	clear(handle: unknown): void {
		this.clearArguments.push(handle);
		const record = this.records.findLast(record => record.pending && record.returnedHandle === handle);
		if (record) {
			record.pending = false;
		}
	}

	fire(callbackId: number): void {
		const record = this.getRecord(callbackId);
		assert.strictEqual(record.pending, true);
		record.pending = false;
		record.callback();
	}

	fireCaptured(callbackId: number): void {
		this.getRecord(callbackId).callback();
	}

	pendingDelays(): number[] {
		return this.records.filter(record => record.pending).map(record => record.delayMs);
	}

	private getRecord(callbackId: number): IManualTimerRecord {
		const record = this.records.find(record => record.callbackId === callbackId);
		assert.ok(record);
		return record;
	}
}

suite('Paradis DND refresh policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps idle states timer-free and clamps timed deadlines', () => {
		assert.deepStrictEqual([
			paradisGetDoNotDisturbRefreshDelay({ enabled: false, until: undefined }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: false, until: 91_000 }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: true, until: undefined }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: true, until: 91_000 }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: true, until: 31_000 }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: true, until: 1_000 }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: true, until: 999 }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: true, until: Number.NaN }, 1_000),
			paradisGetDoNotDisturbRefreshDelay({ enabled: true, until: 31_000 }, Number.POSITIVE_INFINITY),
		], [undefined, undefined, undefined, 60_000, 30_000, 0, 0, 60_000, 60_000]);
	});
});

suite('Paradis DND refresh controller', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createController(
		refresh: (renderNow: number) => IParadisDoNotDisturbRefreshState,
		timer: ManualTimer,
		now: () => number,
	): ParadisDoNotDisturbRefreshController {
		return store.add(paradisCreateDoNotDisturbRefreshController(refresh, { timer, now }));
	}

	test('keeps OFF snapshots with or without a stale deadline and manual ON timer-free after the explicit first render', () => {
		const states: IParadisDoNotDisturbRefreshState[] = [
			{ enabled: false, until: undefined },
			{ enabled: false, until: 91_000 },
			{ enabled: true, until: undefined },
		];
		const timer = new ManualTimer();
		let reads = 0;
		const controller = createController(() => states[reads++], timer, () => 1_000);

		assert.deepStrictEqual({ reads, pending: timer.pendingCount, setCount: timer.setCount }, { reads: 0, pending: 0, setCount: 0 });
		controller.refresh();
		controller.refresh();
		controller.refresh();

		assert.deepStrictEqual({ reads, pending: timer.pendingCount, setCount: timer.setCount }, { reads: 3, pending: 0, setCount: 0 });
	});

	test('recomputes one timed deadline from the fresh clock after every fire', () => {
		const timer = new ManualTimer();
		let clock = 1_000;
		let reads = 0;
		const controller = createController(() => {
			reads++;
			return { enabled: true, until: 91_000 };
		}, timer, () => clock);

		controller.refresh();
		assert.deepStrictEqual({ reads, pending: timer.pendingCount, delays: timer.pendingDelays(), setCount: timer.setCount }, {
			reads: 1,
			pending: 1,
			delays: [60_000],
			setCount: 1,
		});
		clock = 61_000;
		timer.fire(1);

		assert.deepStrictEqual({ reads, pending: timer.pendingCount, delays: timer.pendingDelays(), setCount: timer.setCount }, {
			reads: 2,
			pending: 1,
			delays: [30_000],
			setCount: 2,
		});
	});

	test('rearms timed state once and cancels the handle when state becomes idle', () => {
		const states: IParadisDoNotDisturbRefreshState[] = [
			{ enabled: true, until: 91_000 },
			{ enabled: true, until: 31_000 },
			{ enabled: false, until: undefined },
		];
		const timer = new ManualTimer();
		let reads = 0;
		const controller = createController(() => states[reads++], timer, () => 1_000);

		controller.refresh();
		controller.refresh();
		const afterRearm = { reads, pending: timer.pendingCount, delays: timer.pendingDelays(), clearCount: timer.clearArguments.length };
		controller.refresh();

		assert.deepStrictEqual({ afterRearm, reads, pending: timer.pendingCount, setCount: timer.setCount, clearCount: timer.clearArguments.length }, {
			afterRearm: { reads: 2, pending: 1, delays: [30_000], clearCount: 1 },
			reads: 3,
			pending: 0,
			setCount: 2,
			clearCount: 2,
		});
	});

	test('uses a second clock read when rendering crosses the deadline', () => {
		const timer = new ManualTimer();
		let clock = 1_000;
		const renderTimes: number[] = [];
		const controller = createController(renderNow => {
			renderTimes.push(renderNow);
			clock = 32_000;
			return { enabled: true, until: 31_000 };
		}, timer, () => clock);

		controller.refresh();

		assert.deepStrictEqual({ renderTimes, pending: timer.pendingCount, delays: timer.pendingDelays() }, {
			renderTimes: [1_000],
			pending: 1,
			delays: [0],
		});
	});

	test('normalizes a wake after expiry without catch-up ticks', () => {
		const timer = new ManualTimer();
		let clock = 1_000;
		let reads = 0;
		const controller = createController(renderNow => {
			reads++;
			return renderNow >= 91_000
				? { enabled: false, until: undefined }
				: { enabled: true, until: 91_000 };
		}, timer, () => clock);

		controller.refresh();
		clock = 101_000;
		timer.fire(1);

		assert.deepStrictEqual({ reads, pending: timer.pendingCount, setCount: timer.setCount }, { reads: 2, pending: 0, setCount: 1 });
	});

	test('stops after one zero-delay reread when the owner returns OFF', () => {
		const states: IParadisDoNotDisturbRefreshState[] = [
			{ enabled: true, until: 999 },
			{ enabled: false, until: undefined },
		];
		const timer = new ManualTimer();
		let reads = 0;
		const controller = createController(() => states[reads++], timer, () => 1_000);

		controller.refresh();
		const beforeFire = { reads, pending: timer.pendingCount, delays: timer.pendingDelays(), setCount: timer.setCount };
		timer.fire(1);

		assert.deepStrictEqual({ beforeFire, reads, pending: timer.pendingCount, setCount: timer.setCount }, {
			beforeFire: { reads: 1, pending: 1, delays: [0], setCount: 1 },
			reads: 2,
			pending: 0,
			setCount: 1,
		});
	});

	test('ignores an old callback when both generations return an undefined handle', () => {
		const timer = new ManualTimer(true);
		let reads = 0;
		const controller = createController(() => {
			reads++;
			return { enabled: true, until: 91_000 };
		}, timer, () => 1_000);

		controller.refresh();
		controller.refresh();
		const beforeLateCallback = { reads, pending: timer.pendingCount, setCount: timer.setCount, clearArguments: [...timer.clearArguments] };
		timer.fireCaptured(1);

		assert.deepStrictEqual({ beforeLateCallback, reads, pending: timer.pendingCount, setCount: timer.setCount, clearArguments: timer.clearArguments }, {
			beforeLateCallback: { reads: 2, pending: 1, setCount: 2, clearArguments: [undefined] },
			reads: 2,
			pending: 1,
			setCount: 2,
			clearArguments: [undefined],
		});
	});

	test('clears an undefined handle and ignores late work after idempotent disposal', () => {
		const timer = new ManualTimer(true);
		let reads = 0;
		const controller = createController(() => {
			reads++;
			return { enabled: true, until: 91_000 };
		}, timer, () => 1_000);

		controller.refresh();
		controller.refresh();
		controller.dispose();
		const afterDispose = { reads, pending: timer.pendingCount, setCount: timer.setCount, clearArguments: [...timer.clearArguments] };
		timer.fireCaptured(2);
		controller.refresh();
		controller.dispose();

		assert.deepStrictEqual({ afterDispose, reads, pending: timer.pendingCount, setCount: timer.setCount, clearArguments: timer.clearArguments }, {
			afterDispose: { reads: 2, pending: 0, setCount: 2, clearArguments: [undefined, undefined] },
			reads: 2,
			pending: 0,
			setCount: 2,
			clearArguments: [undefined, undefined],
		});
	});

	test('lets a nested refresh retain sole ownership of the newest handle', () => {
		const timer = new ManualTimer();
		let reads = 0;
		const controller: ParadisDoNotDisturbRefreshController = createController(() => {
			reads++;
			if (reads === 1) {
				controller.refresh();
				return { enabled: true, until: 91_000 };
			}
			return { enabled: true, until: 31_000 };
		}, timer, () => 1_000);

		controller.refresh();

		assert.deepStrictEqual({ reads, pending: timer.pendingCount, delays: timer.pendingDelays(), setCount: timer.setCount }, {
			reads: 2,
			pending: 1,
			delays: [30_000],
			setCount: 1,
		});
	});

	test('recomputes the absolute deadline after the clock moves backward', () => {
		const timer = new ManualTimer();
		let clock = 40_000;
		const renderTimes: number[] = [];
		const controller = createController(renderNow => {
			renderTimes.push(renderNow);
			return { enabled: true, until: 100_000 };
		}, timer, () => clock);

		controller.refresh();
		clock = 10_000;
		timer.fire(1);

		assert.deepStrictEqual({ renderTimes, pending: timer.pendingCount, delays: timer.pendingDelays(), setCount: timer.setCount }, {
			renderTimes: [40_000, 10_000],
			pending: 1,
			delays: [60_000],
			setCount: 2,
		});
	});
});
