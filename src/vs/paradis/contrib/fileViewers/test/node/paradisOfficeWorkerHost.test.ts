/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { OfficeHandleStore } from '../../node/office/paradisOfficeHandleStore.js';
import { OfficeWorkerHost, type IOfficeWorker } from '../../node/office/paradisOfficeWorkerHost.js';

class FakeClock {
	private now = 0;
	private nextId = 0;
	private readonly timers = new Map<number, { readonly at: number; readonly runner: () => void }>();

	read = () => this.now;

	setTimeout = (runner: () => void, delay: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.now + delay, runner });
		return id;
	};

	clearTimeout = (id: unknown): void => { if (typeof id === 'number') { this.timers.delete(id); } };

	advance(milliseconds: number): void {
		this.now += milliseconds;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.now) {
				this.timers.delete(id);
				timer.runner();
			}
		}
	}
}

class FakeWorker implements IOfficeWorker {
	readonly messages: unknown[] = [];
	terminated = false;
	private readonly messageEmitter = new Emitter<unknown>();
	private readonly errorEmitter = new Emitter<unknown>();
	private readonly exitEmitter = new Emitter<number>();

	postMessage(message: unknown): void { this.messages.push(message); }
	terminate(): Promise<number> { this.terminated = true; this.exitEmitter.fire(1); return Promise.resolve(1); }
	onMessage(listener: (message: unknown) => void): IDisposable { return this.messageEmitter.event(listener); }
	onError(listener: (error: unknown) => void): IDisposable { return this.errorEmitter.event(listener); }
	onExit(listener: (code: number) => void): IDisposable { return this.exitEmitter.event(listener); }
	emit(message: unknown): void { this.messageEmitter.fire(message); }
	fail(error: unknown): void { this.errorEmitter.fire(error); }
	exit(code: number): void { this.exitEmitter.fire(code); }
}

function source() {
	return { kind: 'file' as const, displayName: 'safe.xlsx' };
}

suite('ParadisOfficeWorkerHost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cancels cooperatively without publishing a later worker result', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({
			createWorker: () => worker,
			now: clock.read,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
		});
		const cancellation = new CancellationTokenSource();
		const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		worker.emit({ kind: 'cancelled', requestId: '1' });
		worker.emit({ kind: 'result', requestId: '1', value: { inventory: 'late' } });
		assert.deepStrictEqual(await result, { outcome: 'cancelled' });
		assert.strictEqual(worker.terminated, false);
	});

	test('terminates an unresponsive cancelled worker after 250ms', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const cancellation = new CancellationTokenSource();
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		clock.advance(249);
		assert.strictEqual(worker.terminated, false);
		clock.advance(1);
		assert.deepStrictEqual(await result, { outcome: 'cancelled' });
		assert.strictEqual(worker.terminated, true);
	});

	test('starts the Node worker and receives its cooperative cancellation acknowledgement', async () => {
		// The Electron renderer test host cannot launch worker_threads. The node unit runner is the
		// production execution boundary and runs this smoke test below.
		if (process.type === 'renderer') { return; }
		const host = new OfficeWorkerHost();
		const cancellation = new CancellationTokenSource();
		const result = host.run('inspect', 'node-worker', { kind: 'bytes', bytes: new ArrayBuffer(0) }, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		assert.deepStrictEqual(await result, { outcome: 'cancelled' });
		host.dispose();
	});

	test('maps an inspect deadline and worker crash to safe outcomes', async () => {
		const clock = new FakeClock();
		const created: FakeWorker[] = [];
		const host = new OfficeWorkerHost({ createWorker: () => { const worker = new FakeWorker(); created.push(worker); return worker; }, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const deadline = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(30_001);
		assert.deepStrictEqual(await deadline, { outcome: 'blocked', error: 'limitExceeded' });
		const crash = host.run('diff', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		created[1].fail(new Error('/private/path and stack must not escape'));
		assert.deepStrictEqual(await crash, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('maps a parse deadline to the processing limit outcome', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(60_001);
		assert.deepStrictEqual(await result, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('maps a diff deadline to the processing limit outcome', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const result = host.run('diff', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(90_001);
		assert.deepStrictEqual(await result, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('maps a worker resource limit report to blocked without retaining its diagnostics', async () => {
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		worker.emit({ kind: 'limitExceeded', requestId: '1', path: '/secret/document.xlsx', stack: 'private' });
		assert.deepStrictEqual(await result, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('maps an abnormal worker exit to engineCrashed', async () => {
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		worker.exit(23);
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('invalidates only the crashed worker handle owner', async () => {
		let randomSeed = 5;
		const store = new OfficeHandleStore({ randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		const crashed = store.create('client-a', 'document', 'revision-a', 1, 'worker-a');
		const retained = store.create('client-b', 'document', 'revision-b', 1, 'worker-b');
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker, onWorkerCrashed: workerId => store.invalidateWorker(workerId) });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) }, { workerId: 'worker-a' });
		worker.fail(new Error('untrusted stack'));
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
		assert.strictEqual(store.get(crashed), undefined);
		assert.notStrictEqual(store.get(retained), undefined);
	});

	test('queues fairly and rejects an admission which cannot reserve memory', async () => {
		const workers: FakeWorker[] = [];
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({
			createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
			now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
			memory: { limitBytes: 256, workerReservationBytes: 128 },
		});
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };
		const a = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		const b = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		const c = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		assert.strictEqual(workers.length, 2);
		workers[0].emit({ kind: 'result', requestId: '1', value: {} });
		assert.strictEqual(workers.length, 3);
		workers[1].emit({ kind: 'result', requestId: '2', value: {} });
		workers[2].emit({ kind: 'result', requestId: '3', value: {} });
		assert.deepStrictEqual(await Promise.all([a, b, c]), [{ outcome: 'complete', value: {} }, { outcome: 'complete', value: {} }, { outcome: 'complete', value: {} }]);
		const blocked = await host.run('parse', 'c', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token, { reservationBytes: 385 });
		assert.deepStrictEqual(blocked, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('enforces two workers per client and four globally before admitting the next FIFO request', async () => {
		const workers: FakeWorker[] = [];
		const host = new OfficeWorkerHost({ createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, memory: { limitBytes: 4096, workerReservationBytes: 1 } });
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };
		const requests = [
			host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'c', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
		];
		assert.strictEqual(host.activeWorkerCount, 4);
		assert.strictEqual(host.queuedWorkerCount, 1);
		workers[0].emit({ kind: 'result', requestId: '1', value: {} });
		assert.strictEqual(host.activeWorkerCount, 4);
		for (let index = 1; index < workers.length; index++) { workers[index].emit({ kind: 'result', requestId: String(index + 1), value: {} }); }
		await Promise.all(requests);
	});

	test('cancels a queued request without creating a worker', async () => {
		const first = new FakeWorker();
		let created = 0;
		const host = new OfficeWorkerHost({ createWorker: () => { created++; return first; }, memory: { limitBytes: 1, workerReservationBytes: 1 } });
		const running = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		const cancellation = new CancellationTokenSource();
		const queued = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		assert.deepStrictEqual(await queued, { outcome: 'cancelled' });
		assert.strictEqual(created, 1);
		first.emit({ kind: 'result', requestId: '1', value: {} });
		await running;
	});

	test('times out a queued admission at 30 seconds', async () => {
		const clock = new FakeClock();
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, memory: { limitBytes: 1, workerReservationBytes: 1 } });
		void host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		const queued = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(30_000);
		assert.deepStrictEqual(await queued, { outcome: 'blocked', error: 'limitExceeded' });
		host.dispose();
	});

	test('evicts inactive cache before a reservation and releases it once after completion', async () => {
		const workers: FakeWorker[] = [];
		let cache = 128;
		const host = new OfficeWorkerHost({
			createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
			memory: { limitBytes: 256, workerReservationBytes: 128, cacheBytes: () => cache, spoolBytes: () => 16, derivedAssetBytes: () => 16, evictInactiveCache: required => { cache = Math.max(0, cache - required); return required; } },
		});
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };
		const first = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		assert.strictEqual(cache, 96);
		workers[0].emit({ kind: 'result', requestId: '1', value: {} });
		assert.deepStrictEqual(await first, { outcome: 'complete', value: {} });
		assert.strictEqual(host.activeWorkerCount, 0);
		assert.deepStrictEqual(await host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token, { reservationBytes: Number.MAX_SAFE_INTEGER + 1 }), { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('makes owner capabilities unforgeable, expires idle handles, and invalidates a worker crash only for its handles', () => {
		const clock = new FakeClock();
		let randomSeed = 0;
		const store = new OfficeHandleStore({ now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		const first = store.create('client-a', 'document', 'revision-1', 8, 'worker-a');
		const second = store.create('client-b', 'comparison', 'revision-2', 8, 'worker-b');
		assert.strictEqual(store.get({ ...first, nonce: '0'.repeat(64) }), undefined);
		assert.strictEqual(store.get({ ...first, ownerId: 'client-b' }), undefined);
		store.invalidateWorker('worker-a');
		assert.strictEqual(store.get(first), undefined);
		assert.notStrictEqual(store.get(second), undefined);
		clock.advance(10 * 60 * 1000);
		assert.strictEqual(store.get(second), undefined);
		assert.strictEqual(store.close(second), false);
	});

	test('enforces four combined document and comparison handles per owner', () => {
		let randomSeed = 10;
		const store = new OfficeHandleStore({ randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		for (let index = 0; index < 4; index++) { store.create('client-a', index % 2 === 0 ? 'document' : 'comparison', `revision-${index}`, 1); }
		assert.throws(() => store.create('client-a', 'document', 'revision-5', 1), error => error instanceof Error && error.name === 'OfficeHandleStoreError');
	});

	test('preserves active cache and handle entries while evicting inactive LRU entries', () => {
		const clock = new FakeClock();
		let randomSeed = 20;
		const store = new OfficeHandleStore({ now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, semanticCacheLimitBytes: 10, randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		assert.strictEqual(store.putSemanticCache('old', 6), true);
		clock.advance(1);
		assert.strictEqual(store.putSemanticCache('pinned', 4, true), true);
		assert.strictEqual(store.putSemanticCache('next', 6), true);
		assert.strictEqual(store.semanticCacheBytes, 10);
		const inactive = store.create('client-a', 'document', 'old-revision', 4);
		const active = store.create('client-a', 'comparison', 'new-revision', 4);
		store.setActive(active, true);
		assert.strictEqual(store.evictInactiveHandles(4), 4);
		assert.strictEqual(store.get(inactive), undefined);
		assert.notStrictEqual(store.get(active), undefined);
	});

	test('closes all owner handles on renderer crash and invalidates revision handles idempotently', () => {
		let randomSeed = 40;
		const store = new OfficeHandleStore({ randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		const revision = store.create('client-a', 'document', 'revision-shared', 1);
		const other = store.create('client-a', 'comparison', 'revision-other', 1);
		store.invalidateRevision('revision-shared');
		assert.strictEqual(store.get(revision), undefined);
		store.onRendererCrash('client-a');
		assert.strictEqual(store.get(other), undefined);
		assert.strictEqual(store.close(other), false);
	});
});
