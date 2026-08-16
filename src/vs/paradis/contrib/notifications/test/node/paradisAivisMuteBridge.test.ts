/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type * as cp from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisAivisMuteBridgeService } from '../../node/paradisAivisMuteBridgeChannel.js';

/** Captures the aivis invocations and lets a test drive the re-assert timer by hand. */
class TestHarness {

	readonly calls: string[][] = [];
	clock = 1_000_000;
	private tick: (() => void) | undefined;
	private intervalMs = 0;
	private handles = 0;

	readonly execFile = ((command: string, args: readonly string[], _options: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
		this.calls.push([command, ...args]);
		callback(null, '', '');
		return { kill: () => { } } as unknown as cp.ChildProcess;
	}) as unknown as typeof cp.execFile;

	readonly now = () => this.clock;

	readonly schedule = (callback: () => void, intervalMs: number) => {
		this.tick = callback;
		this.intervalMs = intervalMs;
		return ++this.handles as unknown as ReturnType<typeof setInterval>;
	};

	readonly cancel = () => { this.tick = undefined; };

	get scheduled(): boolean {
		return this.tick !== undefined;
	}

	get interval(): number {
		return this.intervalMs;
	}

	/** Runs one re-assert round, as the interval would. */
	async fire(): Promise<void> {
		this.tick?.();
		await Promise.resolve();
		await Promise.resolve();
	}

	create(): ParadisAivisMuteBridgeService {
		return new ParadisAivisMuteBridgeService(
			new NullLogService(), undefined, undefined,
			this.execFile, this.now, this.schedule, this.cancel,
		);
	}
}

suite('Paradis Aivis Mute Bridge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an indefinite do-not-disturb keeps being re-applied', async () => {
		const harness = new TestHarness();
		const service = harness.create();

		await service.sync(true, undefined);
		// Something outside Para Code (an `aivis --reboot`, a Redis restart) drops the key.
		await harness.fire();
		await harness.fire();
		service.dispose();

		assert.deepStrictEqual(
			{ calls: harness.calls, stillScheduled: harness.scheduled },
			{
				calls: [['aivis', '--mute'], ['aivis', '--mute'], ['aivis', '--mute']],
				stillScheduled: false,
			},
		);
	});

	test('a timed do-not-disturb re-applies the time that is actually left', async () => {
		const harness = new TestHarness();
		const service = harness.create();

		await service.sync(true, 30 * 60_000);
		harness.clock += 10 * 60_000;
		await harness.fire();
		service.dispose();

		assert.deepStrictEqual(harness.calls, [
			['aivis', '--mute', '--mute-for', '1800000ms'],
			['aivis', '--mute', '--mute-for', '1200000ms'],
		]);
	});

	test('an expired timed mute stops re-applying without unmuting anything', async () => {
		const harness = new TestHarness();
		const service = harness.create();

		await service.sync(true, 5 * 60_000);
		harness.clock += 6 * 60_000;
		await harness.fire();
		// Nothing more should be sent, and no further rounds should be scheduled: aivis expires
		// the key itself, and an --unmute here would clear a mute the user set by hand.
		await harness.fire();

		assert.deepStrictEqual(
			{ calls: harness.calls, stillScheduled: harness.scheduled },
			{ calls: [['aivis', '--mute', '--mute-for', '300000ms']], stillScheduled: false },
		);
	});

	test('turning do-not-disturb off unmutes once and stops re-applying', async () => {
		const harness = new TestHarness();
		const service = harness.create();

		await service.sync(true, undefined);
		await service.sync(false, undefined);
		await harness.fire();

		assert.deepStrictEqual(
			{ calls: harness.calls, stillScheduled: harness.scheduled },
			{ calls: [['aivis', '--mute'], ['aivis', '--unmute']], stillScheduled: false },
		);
	});

	test('a broken remaining time falls back to a mute that will not release itself', async () => {
		const harness = new TestHarness();
		const service = harness.create();

		await service.sync(true, Number.NaN);
		await service.sync(true, Number.POSITIVE_INFINITY);
		service.dispose();

		assert.deepStrictEqual(harness.calls, [['aivis', '--mute'], ['aivis', '--mute']]);
	});

	test('repeated syncs keep exactly one re-assert round in flight', async () => {
		const harness = new TestHarness();
		const service = harness.create();

		await service.sync(true, undefined);
		await service.sync(true, undefined);
		await service.sync(true, undefined);

		assert.deepStrictEqual(
			{ scheduled: harness.scheduled, interval: harness.interval, calls: harness.calls.length },
			{ scheduled: true, interval: 5 * 60_000, calls: 3 },
		);
		service.dispose();
	});
});
