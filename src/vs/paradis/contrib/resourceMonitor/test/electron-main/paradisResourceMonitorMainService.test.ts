/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisResourceMonitorSessionRequest, IParadisResourceMonitorSnapshotRequest } from '../../common/paradisResourceMonitor.js';
import { IParadisResourceMonitorMainServiceDependencies, IParadisResourceMonitorRawSample, ParadisResourceMonitorMainService } from '../../electron-main/paradisResourceMonitorMainService.js';
import { IParadisProcessInfo, IParadisProcessSnapshot } from '../../electron-main/paradisResourceMonitorProcessTree.js';

class TestClockScheduler {
	private timestamp = 0;
	private nextHandle = 1;
	private readonly scheduled = new Map<number, { readonly dueAt: number; readonly callback: () => void }>();

	constructor(private readonly honorDisposal = true) { }

	readonly now = (): number => this.timestamp;

	readonly schedule = (callback: () => void, delayMs: number): { dispose(): void } => {
		const handle = this.nextHandle++;
		this.scheduled.set(handle, { dueAt: this.timestamp + delayMs, callback });
		return {
			dispose: () => {
				if (this.honorDisposal) {
					this.scheduled.delete(handle);
				}
			}
		};
	};

	advance(deltaMs: number): void {
		this.timestamp += deltaMs;
		for (const [handle, task] of [...this.scheduled]) {
			if (task.dueAt <= this.timestamp) {
				this.scheduled.delete(handle);
				task.callback();
			}
		}
	}
}

function createProcessSnapshot(processes: readonly IParadisProcessInfo[]): IParadisProcessSnapshot {
	const byPid = new Map<number, IParadisProcessInfo>();
	const childrenOf = new Map<number, number[]>();
	for (const process of processes) {
		byPid.set(process.pid, process);
		const children = childrenOf.get(process.ppid) ?? [];
		children.push(process.pid);
		childrenOf.set(process.ppid, children);
	}
	return { byPid, childrenOf };
}

function createRawSample(processes: readonly IParadisProcessInfo[], collectedAt = Date.now(), appCpu = 0): IParadisResourceMonitorRawSample {
	const zero = { cpu: 0, memory: 0 };
	return {
		processSnapshot: createProcessSnapshot(processes),
		app: { cpu: appCpu, memory: 0, main: zero, renderer: zero, other: zero },
		hostTotalMemory: 16_000,
		collectedAt,
	};
}

function createSession(stateKey: string, pid: number): IParadisResourceMonitorSessionRequest {
	return { stateKey, scopeName: `${stateKey} scope`, sessionName: `${stateKey} terminal`, pid };
}

suite('ParadisResourceMonitorMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('concurrent windows share one raw capture but project their own terminal sessions', async () => {
		let captureCount = 0;
		let resolveCapture: ((sample: IParadisResourceMonitorRawSample) => void) | undefined;
		const capture = new Promise<IParadisResourceMonitorRawSample>(resolve => { resolveCapture = resolve; });
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: () => {
				captureCount++;
				return capture;
			},
			now: () => Date.now(),
			schedule: () => ({ dispose() { } }),
		});

		const first = service.getSnapshot({ sessions: [createSession('first', 10)] });
		const second = service.getSnapshot({ sessions: [createSession('second', 20)] });
		assert.ok(resolveCapture);
		resolveCapture(createRawSample([
			{ pid: 10, ppid: 1, cpu: 1, memory: 100 },
			{ pid: 20, ppid: 1, cpu: 2, memory: 200 },
		]));

		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

		assert.strictEqual(captureCount, 1);
		assert.deepStrictEqual(firstSnapshot.scopes.map(scope => scope.stateKey), ['first']);
		assert.deepStrictEqual(secondSnapshot.scopes.map(scope => scope.stateKey), ['second']);
		assert.strictEqual(firstSnapshot.totalCpu, 1);
		assert.strictEqual(secondSnapshot.totalCpu, 2);
	});

	test('idle freshness starts when collection starts rather than when it completes', async () => {
		const clock = new TestClockScheduler();
		let captureCount = 0;
		let resolveInitialCapture: ((sample: IParadisResourceMonitorRawSample) => void) | undefined;
		const initialCapture = new Promise<IParadisResourceMonitorRawSample>(resolve => { resolveInitialCapture = resolve; });
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => {
				captureCount++;
				return captureCount === 1 ? initialCapture : createRawSample([], clock.now(), 2);
			},
			now: clock.now,
			schedule: clock.schedule,
		});

		const initial = service.getSnapshot({ sessions: [], freshness: 'idle' });
		clock.advance(100);
		assert.ok(resolveInitialCapture);
		resolveInitialCapture(createRawSample([], 100, 1));
		await initial;

		clock.advance(4_899);
		const beforeBoundary = await service.getSnapshot({ sessions: [], freshness: 'idle' });
		clock.advance(1);
		const atBoundary = await service.getSnapshot({ sessions: [], freshness: 'idle' });

		assert.strictEqual(beforeBoundary.app.cpu, 1);
		assert.strictEqual(atBoundary.app.cpu, 2);
		assert.strictEqual(captureCount, 2);
	});

	test('force joins an in-flight raw capture and each request projects its own sessions', async () => {
		const clock = new TestClockScheduler();
		let captureCount = 0;
		let resolveCapture: ((sample: IParadisResourceMonitorRawSample) => void) | undefined;
		const capture = new Promise<IParadisResourceMonitorRawSample>(resolve => { resolveCapture = resolve; });
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: () => {
				captureCount++;
				return capture;
			},
			now: clock.now,
			schedule: clock.schedule,
		});

		const first = service.getSnapshot({ sessions: [createSession('first', 10)] });
		const forced = service.getSnapshot({ sessions: [createSession('forced', 20)], force: true });
		assert.ok(resolveCapture);
		resolveCapture(createRawSample([
			{ pid: 10, ppid: 1, cpu: 1, memory: 100 },
			{ pid: 20, ppid: 1, cpu: 2, memory: 200 },
		], 0));

		const [firstSnapshot, forcedSnapshot] = await Promise.all([first, forced]);

		assert.strictEqual(captureCount, 1);
		assert.deepStrictEqual(firstSnapshot.scopes.map(scope => scope.stateKey), ['first']);
		assert.deepStrictEqual(forcedSnapshot.scopes.map(scope => scope.stateKey), ['forced']);
	});

	test('idle reuses a 2.6 second raw sample while active refreshes it', async () => {
		const clock = new TestClockScheduler();
		let captureCount = 0;
		const dependencies: IParadisResourceMonitorMainServiceDependencies = {
			collectRawSample: async () => {
				captureCount++;
				return createRawSample([], clock.now());
			},
			now: clock.now,
			schedule: clock.schedule,
		};
		const service = new ParadisResourceMonitorMainService(dependencies);

		const initial = await service.getSnapshot({ sessions: [] });
		clock.advance(2_600);
		const idle = await service.getSnapshot({ sessions: [], freshness: 'idle' });
		const active = await service.getSnapshot({ sessions: [], freshness: 'active' });

		assert.strictEqual(initial.collectedAt, 0);
		assert.strictEqual(idle.collectedAt, 0);
		assert.strictEqual(active.collectedAt, 2_600);
		assert.strictEqual(captureCount, 2);
	});

	test('releases the raw generation after idle freshness expires', async () => {
		const clock = new TestClockScheduler();
		let failCapture = false;
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => {
				if (failCapture) {
					throw new Error('capture failed');
				}
				return createRawSample([], clock.now(), 9);
			},
			now: clock.now,
			schedule: clock.schedule,
		});

		const initial = await service.getSnapshot({ sessions: [] });
		failCapture = true;
		clock.advance(5_001);
		const afterExpiryFailure = await service.getSnapshot({ sessions: [], force: true });

		assert.strictEqual(initial.app.cpu, 9);
		assert.strictEqual(afterExpiryFailure.app.cpu, 0);
		assert.strictEqual(afterExpiryFailure.collectedAt, 5_001);
	});

	test('failed refresh does not extend the previous raw generation expiry', async () => {
		const clock = new TestClockScheduler();
		let captureCount = 0;
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => {
				captureCount++;
				if (captureCount === 1) {
					return createRawSample([], 0, 9);
				}
				throw new Error('capture failed');
			},
			now: clock.now,
			schedule: clock.schedule,
		});

		await service.getSnapshot({ sessions: [] });
		clock.advance(2_600);
		const firstFallback = await service.getSnapshot({ sessions: [], force: true });
		clock.advance(2_401);
		const afterOriginalExpiry = await service.getSnapshot({ sessions: [], force: true });

		assert.strictEqual(firstFallback.app.cpu, 9);
		assert.strictEqual(afterOriginalExpiry.app.cpu, 0);
		assert.strictEqual(afterOriginalExpiry.collectedAt, 5_001);
		assert.strictEqual(captureCount, 3);
	});

	test('an expired timer from an older generation does not release the current raw sample', async () => {
		const clock = new TestClockScheduler(false);
		let captureCount = 0;
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => createRawSample([], clock.now(), ++captureCount),
			now: clock.now,
			schedule: clock.schedule,
		});

		await service.getSnapshot({ sessions: [] });
		clock.advance(1_000);
		const forced = await service.getSnapshot({ sessions: [], force: true });
		clock.advance(4_000);
		const idle = await service.getSnapshot({ sessions: [], freshness: 'idle' });

		assert.strictEqual(forced.app.cpu, 2);
		assert.strictEqual(idle.app.cpu, 2);
		assert.strictEqual(captureCount, 2);
	});

	test('force bypasses a completed raw cache', async () => {
		const clock = new TestClockScheduler();
		let captureCount = 0;
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => createRawSample([], clock.now(), ++captureCount),
			now: clock.now,
			schedule: clock.schedule,
		});

		const initial = await service.getSnapshot({ sessions: [] });
		const forced = await service.getSnapshot({ sessions: [], force: true });

		assert.strictEqual(initial.app.cpu, 1);
		assert.strictEqual(forced.app.cpu, 2);
		assert.strictEqual(captureCount, 2);
	});

	test('non-force returns a valid raw cache while a force capture is in flight', async () => {
		const clock = new TestClockScheduler();
		let captureCount = 0;
		let resolveForcedCapture: ((sample: IParadisResourceMonitorRawSample) => void) | undefined;
		const forcedCapture = new Promise<IParadisResourceMonitorRawSample>(resolve => { resolveForcedCapture = resolve; });
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => {
				captureCount++;
				return captureCount === 1 ? createRawSample([], clock.now(), 1) : forcedCapture;
			},
			now: clock.now,
			schedule: clock.schedule,
		});

		await service.getSnapshot({ sessions: [] });
		clock.advance(1_000);
		const forced = service.getSnapshot({ sessions: [], force: true });
		const cached = await service.getSnapshot({ sessions: [] });
		assert.ok(resolveForcedCapture);
		resolveForcedCapture(createRawSample([], clock.now(), 2));

		assert.strictEqual(cached.app.cpu, 1);
		assert.strictEqual((await forced).app.cpu, 2);
		assert.strictEqual(captureCount, 2);
	});

	test('failed active refresh reprojects the previous raw sample for the current sessions', async () => {
		const clock = new TestClockScheduler();
		let failCapture = false;
		const rawSample = createRawSample([
			{ pid: 10, ppid: 1, cpu: 1, memory: 100 },
			{ pid: 20, ppid: 1, cpu: 2, memory: 200 },
		], 0);
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => {
				if (failCapture) {
					throw new Error('capture failed');
				}
				return rawSample;
			},
			now: clock.now,
			schedule: clock.schedule,
		});

		await service.getSnapshot({ sessions: [createSession('first', 10)] });
		failCapture = true;
		clock.advance(2_600);
		const fallback = await service.getSnapshot({ sessions: [createSession('second', 20)] });

		assert.deepStrictEqual(fallback.scopes.map(scope => scope.stateKey), ['second']);
		assert.strictEqual(fallback.totalCpu, 2);
	});

	test('omitted and invalid freshness use the active cache boundary', async () => {
		const clock = new TestClockScheduler();
		let captureCount = 0;
		const service = new ParadisResourceMonitorMainService({
			collectRawSample: async () => createRawSample([], clock.now(), ++captureCount),
			now: clock.now,
			schedule: clock.schedule,
		});

		await service.getSnapshot({ sessions: [] });
		clock.advance(2_600);
		const omitted = await service.getSnapshot({ sessions: [] });
		clock.advance(2_600);
		const invalidRequest = { sessions: [], freshness: 'future' } as unknown as IParadisResourceMonitorSnapshotRequest;
		const invalid = await service.getSnapshot(invalidRequest);

		assert.strictEqual(omitted.app.cpu, 2);
		assert.strictEqual(invalid.app.cpu, 3);
		assert.strictEqual(captureCount, 3);
	});
});
