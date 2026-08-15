/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';

class StateBroadcastMetricsTimer {
	private callback: (() => void) | undefined;
	readonly callbacks: Array<() => void> = [];
	readonly intervals: number[] = [];

	cancel(): void {
		this.callback = undefined;
	}

	cancelAndSet(callback: () => void, interval: number): void {
		this.callback = callback;
		this.callbacks.push(callback);
		this.intervals.push(interval);
	}

	fire(): void {
		this.callback?.();
	}

	fireQueued(index: number): void {
		this.callbacks[index]?.();
	}

	get active(): boolean {
		return this.callback !== undefined;
	}
}

interface IStateBroadcastMetricsFixture {
	initialize(enabled: boolean, relayUrl: string | undefined): Promise<void>;
	setEnabled(enabled: boolean): Promise<void>;
}

function createStateBroadcastMetricsFixture(): { service: IStateBroadcastMetricsFixture; timer: StateBroadcastMetricsTimer; logs: string[]; state: { broadcastCount: number; broadcastSentCount: number; lifecycleTimerStates: boolean[] } } {
	const timer = new StateBroadcastMetricsTimer();
	const logs: string[] = [];
	const state = { broadcastCount: 0, broadcastSentCount: 0, lifecycleTimerStates: [] as boolean[] };
	const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
		stateBroadcastMetricsTimer: timer,
		stateBroadcastMetricsEnabled: false,
		stateBroadcastMetricsGeneration: 0,
		...state,
		enabled: false,
		state: { mobiles: [], device: {} },
		pcName: 'test-desktop',
		terminalRegistry: { setPcName: () => undefined },
		disconnectReporter: { setEnabled: () => undefined },
		logService: { info: (message: string) => logs.push(message) },
		load: async () => undefined,
		updateDiagnosticCorrelation: () => undefined,
		updateEagerTailing: () => undefined,
		setConnectionState: () => undefined,
		connect: () => state.lifecycleTimerStates.push(timer.active),
		disconnect: () => state.lifecycleTimerStates.push(timer.active),
	}) as IStateBroadcastMetricsFixture;
	return { service, timer, logs, state: service as IStateBroadcastMetricsFixture & typeof state };
}

suite('ParadisMobileRelayService state broadcast metrics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not start its reporting timer when mobile relay is initially disabled', async () => {
		const { service, timer, logs, state } = createStateBroadcastMetricsFixture();

		await service.initialize(false, undefined);
		timer.fire();

		assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals, logs, lifecycleTimerStates: state.lifecycleTimerStates }, {
			active: false,
			intervals: [],
			logs: [],
			lifecycleTimerStates: [],
		});
	});

	test('starts its reporting timer only once for repeated enabled settings', async () => {
		const { service, timer } = createStateBroadcastMetricsFixture();

		await service.setEnabled(true);
		await service.setEnabled(true);

		assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals }, {
			active: true,
			intervals: [60_000],
		});
	});

	test('synchronizes the timer before connection lifecycle work', async () => {
		const { service, state } = createStateBroadcastMetricsFixture();

		await service.setEnabled(true);
		await service.setEnabled(false);

		assert.deepStrictEqual(state.lifecycleTimerStates, [true, false]);
	});

	test('logs accumulated broadcast activity and resets its counters', async () => {
		const { service, timer, logs, state } = createStateBroadcastMetricsFixture();
		state.broadcastCount = 3;
		state.broadcastSentCount = 1;

		await service.setEnabled(true);
		timer.fire();
		timer.fire();

		assert.deepStrictEqual({ logs, broadcastCount: state.broadcastCount, broadcastSentCount: state.broadcastSentCount }, {
			logs: ['[paradisMobileRelay][metrics] desktop state broadcast: 3 calls, 1 sent, 2 deduped'],
			broadcastCount: 0,
			broadcastSentCount: 0,
		});
	});

	test('discards metrics and suppresses a reporting callback queued before relay is disabled', async () => {
		const { service, timer, logs, state } = createStateBroadcastMetricsFixture();
		state.broadcastCount = 4;
		state.broadcastSentCount = 2;

		await service.setEnabled(true);
		await service.setEnabled(false);
		timer.fireQueued(0);

		assert.deepStrictEqual({ active: timer.active, logs, broadcastCount: state.broadcastCount, broadcastSentCount: state.broadcastSentCount }, {
			active: false,
			logs: [],
			broadcastCount: 0,
			broadcastSentCount: 0,
		});
	});

	test('ignores a queued callback from before an off-on cycle until the new timer fires', async () => {
		const { service, timer, logs, state } = createStateBroadcastMetricsFixture();

		await service.setEnabled(true);
		await service.setEnabled(false);
		await service.setEnabled(true);
		state.broadcastCount = 2;
		state.broadcastSentCount = 1;
		timer.fireQueued(0);

		assert.deepStrictEqual({ logs, broadcastCount: state.broadcastCount, broadcastSentCount: state.broadcastSentCount }, {
			logs: [],
			broadcastCount: 2,
			broadcastSentCount: 1,
		});

		timer.fire();

		assert.deepStrictEqual({ logs, broadcastCount: state.broadcastCount, broadcastSentCount: state.broadcastSentCount }, {
			logs: ['[paradisMobileRelay][metrics] desktop state broadcast: 2 calls, 1 sent, 1 deduped'],
			broadcastCount: 0,
			broadcastSentCount: 0,
		});
	});

	test('starts fresh metrics after relay is enabled again', async () => {
		const { service, timer, logs, state } = createStateBroadcastMetricsFixture();
		state.broadcastCount = 5;

		await service.setEnabled(true);
		await service.setEnabled(false);
		state.broadcastCount = 2;
		await service.setEnabled(true);
		timer.fire();

		assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals, logs }, {
			active: true,
			intervals: [60_000, 60_000],
			logs: ['[paradisMobileRelay][metrics] desktop state broadcast: 2 calls, 0 sent, 2 deduped'],
		});
	});

	test('disposes the registered metrics timer with the service', () => {
		const prototype = ParadisMobileRelayService.prototype as unknown as { startHostResourceSampling(): void };
		const startHostResourceSampling = prototype.startHostResourceSampling;
		prototype.startHostResourceSampling = () => undefined;
		try {
			const service = new ParadisMobileRelayService(
				'/tmp/paradis-mobile-relay-metrics-test',
				undefined as never,
				undefined,
				undefined,
				{ onDidChangeManifest: Event.None } as never,
				new NullLogService(),
			);

			service.dispose();
			const timer = (service as unknown as { stateBroadcastMetricsTimer: IntervalTimer }).stateBroadcastMetricsTimer;

			assert.throws(() => timer.cancelAndSet(() => undefined, 60_000));
		} finally {
			prototype.startHostResourceSampling = startHostResourceSampling;
		}
	});
});
