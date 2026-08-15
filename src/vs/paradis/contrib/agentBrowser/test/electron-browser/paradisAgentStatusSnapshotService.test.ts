/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IParadisAgentStatusSnapshot } from '../../common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotOutcome, IParadisAgentStatusSnapshotScheduler, ParadisAgentStatusSnapshotService, paradisCreateAgentStatusSnapshotServiceForTest } from '../../electron-browser/paradisAgentStatusSnapshotService.js';

suite('ParadisAgentStatusSnapshotService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('defers the first transport and performs initial plus 30 periodic calls in 60 seconds without subscribers', async () => {
		const scheduler = new TestScheduler();
		let calls = 0;
		store.add(createService(scheduler, async () => snapshot(`token-${++calls}`)));

		assert.strictEqual(calls, 0);
		assert.deepStrictEqual(scheduler.scheduledDelays, [0]);

		await scheduler.advanceBy(60_000);

		assert.strictEqual(calls, 31);
		assert.strictEqual(scheduler.nextDelay, 2_000);
	});

	test('continues initial plus 30 periodic transports during 60 seconds while the workbench is hidden', async () => {
		forceDocumentHidden(store, true);
		const scheduler = new TestScheduler();
		let calls = 0;
		store.add(createService(scheduler, async () => snapshot(`hidden-token-${++calls}`)));

		await scheduler.advanceBy(60_000);

		assert.strictEqual(calls, 31);
		assert.strictEqual(scheduler.nextDelay, 2_000);
	});

	test('shares one immutable snapshot and one transport call between consumers', async () => {
		const scheduler = new TestScheduler();
		let calls = 0;
		const source = snapshot('token-a');
		const service = store.add(createService(scheduler, async () => {
			calls++;
			return source;
		}));
		const first: IParadisAgentStatusSnapshotOutcome[] = [];
		const second: IParadisAgentStatusSnapshotOutcome[] = [];
		store.add(service.subscribe(outcome => first.push(outcome)));
		store.add(service.subscribe(outcome => second.push(outcome)));

		await scheduler.advanceBy(0);

		assert.strictEqual(calls, 1);
		assert.strictEqual(first.length, 1);
		assert.strictEqual(second.length, 1);
		assert.strictEqual(first[0], second[0]);
		assert.strictEqual(first[0].snapshot, second[0].snapshot);
		assert.strictEqual(Object.isFrozen(first[0].snapshot), true);
		assert.strictEqual(Object.isFrozen(first[0].snapshot?.paneStatuses), true);
		assert.strictEqual(Object.isFrozen(first[0].snapshot?.agentHookTokens), true);
		assert.notStrictEqual(first[0].snapshot?.paneStatuses[0], source.paneStatuses[0]);
		assert.strictEqual(Object.isFrozen(first[0].snapshot?.paneStatuses[0]), true);
	});

	test('replays the latest outcome once and delivers later outcomes in increasing sequence order', async () => {
		const scheduler = new TestScheduler();
		let calls = 0;
		const service = store.add(createService(scheduler, async () => snapshot(`token-${++calls}`)));

		await scheduler.advanceBy(0);
		const received: IParadisAgentStatusSnapshotOutcome[] = [];
		store.add(service.subscribe(outcome => received.push(outcome)));
		assert.deepStrictEqual(received.map(outcome => outcome.sequence), [1]);

		service.requestRefresh();
		await scheduler.advanceBy(0);

		assert.deepStrictEqual(received.map(outcome => outcome.sequence), [1, 2]);
		assert.deepStrictEqual(received.map(outcome => outcome.snapshot?.agentHookTokens[0]), ['token-1', 'token-2']);
	});

	test('disposes a live subscription when replaying the latest outcome throws', async () => {
		const scheduler = new TestScheduler();
		let calls = 0;
		const service = store.add(createService(scheduler, async () => snapshot(`token-${++calls}`)));
		await scheduler.advanceBy(0);
		let listenerCalls = 0;

		assert.throws(() => service.subscribe(() => {
			listenerCalls++;
			throw new Error('consumer failed during replay');
		}), /consumer failed during replay/);
		assert.strictEqual(listenerCalls, 1);

		service.requestRefresh();
		await scheduler.advanceBy(0);

		assert.strictEqual(listenerCalls, 1);
	});

	test('keeps at most one transport in flight and coalesces refresh requests into one fresh generation', async () => {
		const scheduler = new TestScheduler();
		const first = new DeferredPromise<IParadisAgentStatusSnapshot>();
		let calls = 0;
		let concurrent = 0;
		let maxConcurrent = 0;
		const service = store.add(createService(scheduler, async () => {
			calls++;
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			try {
				return calls === 1 ? await first.p : snapshot('fresh');
			} finally {
				concurrent--;
			}
		}));
		const outcomes: IParadisAgentStatusSnapshotOutcome[] = [];
		store.add(service.subscribe(outcome => outcomes.push(outcome)));

		await scheduler.runNext();
		scheduler.invokeRunner();
		scheduler.invokeRunner();
		service.requestRefresh();
		service.requestRefresh();
		service.requestRefresh();
		assert.strictEqual(calls, 1);

		first.complete(snapshot('stale'));
		await flushAsync();

		assert.strictEqual(outcomes.length, 0);
		assert.strictEqual(scheduler.nextDelay, 0);
		await scheduler.runNext();

		assert.strictEqual(calls, 2);
		assert.strictEqual(maxConcurrent, 1);
		assert.deepStrictEqual(outcomes.map(outcome => outcome.snapshot?.agentHookTokens[0]), ['fresh']);
		assert.deepStrictEqual(outcomes.map(outcome => outcome.sequence), [1]);
	});

	test('drops a stale error after an immediate refresh and publishes the following success', async () => {
		const scheduler = new TestScheduler();
		const first = new DeferredPromise<IParadisAgentStatusSnapshot>();
		let calls = 0;
		const service = store.add(createService(scheduler, () => ++calls === 1 ? first.p : Promise.resolve(snapshot('fresh'))));
		const outcomes: IParadisAgentStatusSnapshotOutcome[] = [];
		store.add(service.subscribe(outcome => outcomes.push(outcome)));

		await scheduler.runNext();
		service.requestRefresh();
		first.error(new Error('stale failure'));
		await flushAsync();
		assert.strictEqual(outcomes.length, 0);

		await scheduler.runNext();
		assert.strictEqual(outcomes.length, 1);
		assert.strictEqual(outcomes[0].sequence, 1);
		assert.strictEqual(outcomes[0].snapshot?.agentHookTokens[0], 'fresh');
	});

	test('publishes failures as monotonic outcomes and retries after two seconds', async () => {
		const scheduler = new TestScheduler();
		let calls = 0;
		const service = store.add(createService(scheduler, async () => {
			if (++calls === 1) {
				throw new Error('offline');
			}
			return snapshot('recovered');
		}));
		const outcomes: IParadisAgentStatusSnapshotOutcome[] = [];
		store.add(service.subscribe(outcome => outcomes.push(outcome)));

		await scheduler.advanceBy(0);
		assert.strictEqual(outcomes[0].error instanceof Error, true);
		assert.strictEqual(outcomes[0].sequence, 1);
		assert.strictEqual(scheduler.nextDelay, 2_000);

		await scheduler.advanceBy(2_000);
		assert.deepStrictEqual(outcomes.map(outcome => outcome.sequence), [1, 2]);
		assert.strictEqual(outcomes[1].snapshot?.agentHookTokens[0], 'recovered');
	});

	test('uses the renderer-owned shared channel command with no argument payload', async () => {
		const scheduler = new TestScheduler();
		const channelCalls: Array<{ command: string; argumentCount: number }> = [];
		const channel = {
			call: async <T>(...args: unknown[]) => {
				channelCalls.push({ command: args[0] as string, argumentCount: args.length });
				return snapshot('owned') as T;
			},
		};
		store.add(paradisCreateAgentStatusSnapshotServiceForTest(
			{
				getChannel: (name: string) => {
					assert.strictEqual(name, 'paradisAgentBrowser');
					return channel;
				}
			} as unknown as ISharedProcessService,
			{ schedulerFactory: runner => scheduler.bind(runner) },
		));

		await scheduler.advanceBy(0);

		assert.deepStrictEqual(channelCalls, [{ command: 'listAgentStatusSnapshot', argumentCount: 1 }]);
	});

	test('cancels polling and suppresses a late outcome after disposal', async () => {
		const scheduler = new TestScheduler();
		const pending = new DeferredPromise<IParadisAgentStatusSnapshot>();
		let calls = 0;
		const service = createService(scheduler, () => {
			calls++;
			return pending.p;
		});
		const outcomes: IParadisAgentStatusSnapshotOutcome[] = [];
		store.add(service.subscribe(outcome => outcomes.push(outcome)));

		await scheduler.runNext();
		service.dispose();
		pending.complete(snapshot('late'));
		await flushAsync();
		scheduler.invokeRunner();

		assert.strictEqual(calls, 1);
		assert.deepStrictEqual(outcomes, []);
		assert.strictEqual(scheduler.hasScheduled, false);
		assert.strictEqual(scheduler.cancelCount > 0, true);
	});
});

function createService(
	scheduler: TestScheduler,
	transport: () => Promise<IParadisAgentStatusSnapshot>,
): ParadisAgentStatusSnapshotService {
	return paradisCreateAgentStatusSnapshotServiceForTest(
		{ getChannel: () => assert.fail('injected transport must avoid the shared channel') } as unknown as ISharedProcessService,
		{ schedulerFactory: runner => scheduler.bind(runner), transport },
	);
}

function snapshot(token: string): IParadisAgentStatusSnapshot {
	return {
		paneStatuses: [{ token, status: 'working', changedAt: 1 }],
		agentHookTokens: [token],
	};
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function forceDocumentHidden(store: { add<T extends { dispose(): void }>(disposable: T): T }, hidden: boolean): void {
	const document = mainWindow.document;
	const descriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
	Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
	store.add(toDisposable(() => {
		if (descriptor) {
			Object.defineProperty(document, 'hidden', descriptor);
		} else {
			delete (document as { hidden?: boolean }).hidden;
		}
	}));
}

class TestScheduler implements IParadisAgentStatusSnapshotScheduler {
	readonly scheduledDelays: number[] = [];
	cancelCount = 0;
	private runner: (() => void) | undefined;
	private now = 0;
	private dueAt: number | undefined;

	get hasScheduled(): boolean { return this.dueAt !== undefined; }
	get nextDelay(): number | undefined { return this.dueAt === undefined ? undefined : this.dueAt - this.now; }

	bind(runner: () => void): this {
		this.runner = runner;
		return this;
	}

	schedule(delay: number): void {
		this.scheduledDelays.push(delay);
		this.dueAt = this.now + delay;
	}

	cancel(): void {
		this.cancelCount++;
		this.dueAt = undefined;
	}

	dispose(): void {
		this.cancel();
		this.runner = undefined;
	}

	invokeRunner(): void {
		this.runner?.();
	}

	async runNext(): Promise<void> {
		if (this.dueAt === undefined) {
			return;
		}
		this.now = this.dueAt;
		this.dueAt = undefined;
		this.runner?.();
		await flushAsync();
	}

	async advanceBy(duration: number): Promise<void> {
		const target = this.now + duration;
		while (this.dueAt !== undefined && this.dueAt <= target) {
			await this.runNext();
		}
		this.now = target;
	}
}
