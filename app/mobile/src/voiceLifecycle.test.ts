// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	MobileVoiceLifecycle,
	VoiceLifecycle,
	type MobileVoiceLifecycleHost,
	type VoiceLifecycleSnapshot,
	type VoiceLifecycleTimers,
	type VoiceNotificationState,
} from './voiceLifecycle.js';

class ManualTimers implements VoiceLifecycleTimers {
	private nextHandle = 1;
	private now = 0;
	private readonly pending = new Map<number, { readonly at: number; readonly handler: () => void }>();
	readonly scheduled: { readonly handle: number; readonly ms: number; readonly handler: () => void }[] = [];

	setTimeout(handler: () => void, ms: number): unknown {
		const handle = this.nextHandle++;
		this.pending.set(handle, { at: this.now + ms, handler });
		this.scheduled.push({ handle, ms, handler });
		return handle;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === 'number') {
			this.pending.delete(handle);
		}
	}

	advance(ms: number): void {
		this.now += ms;
		const due = [...this.pending.entries()]
			.filter(([, timer]) => timer.at <= this.now)
			.sort((a, b) => a[1].at - b[1].at);
		for (const [handle, timer] of due) {
			this.pending.delete(handle);
			timer.handler();
		}
	}

	get pendingCount(): number {
		return this.pending.size;
	}
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

class FakeVoiceHost implements MobileVoiceLifecycleHost {
	snapshot: VoiceLifecycleSnapshot = { nativeSupported: true, protocolUnsupported: false, connectionReady: true };
	state: VoiceNotificationState = { desired: false, status: 'idle' };
	readonly states: VoiceNotificationState[] = [];
	readonly subscriptions: string[] = [];
	readonly unsubscriptions: string[] = [];
	readonly clearedClipHandlers: string[] = [];
	readonly subscribeResults: Promise<void>[] = [];
	remoteStop: (() => void) | undefined;
	activationCount = 0;
	deactivationCount = 0;
	afterStopCount = 0;
	private sid = 0;

	getSnapshot(): VoiceLifecycleSnapshot {
		return this.snapshot;
	}

	setState(state: VoiceNotificationState): void {
		this.state = state;
		this.states.push(state);
	}

	createSessionId(): string {
		return `voice-test-${++this.sid}`;
	}

	async activate(): Promise<void> {
		this.activationCount++;
	}

	async deactivate(): Promise<void> {
		this.deactivationCount++;
	}

	subscribe(sid: string): Promise<void> {
		this.subscriptions.push(sid);
		return this.subscribeResults.shift() ?? Promise.resolve();
	}

	unsubscribe(sid: string): void {
		this.unsubscriptions.push(sid);
	}

	setClipHandler(_sid: string, _handler: (base64: string) => void): void { }

	clearClipHandler(sid: string): void {
		this.clearedClipHandlers.push(sid);
	}

	onRemoteStop(handler: () => void): () => void {
		this.remoteStop = handler;
		return () => { if (this.remoteStop === handler) { this.remoteStop = undefined; } };
	}

	async enqueueClip(_base64: string): Promise<void> { }

	afterStop(): void {
		this.afterStopCount++;
	}
}

describe('mobile voice lifecycle', () => {
	it('does not let a stale completion or reconnect timer restore live state after stop', () => {
		const timers = new ManualTimers();
		const lifecycle = new VoiceLifecycle(timers);
		let status: 'connecting' | 'live' | 'idle' = 'connecting';
		const generation = lifecycle.start();
		const complete = () => lifecycle.runIfCurrent(generation, () => { status = 'live'; });

		lifecycle.schedule(generation, 3_000, complete);
		const queuedTimer = timers.scheduled[0]!.handler;
		lifecycle.stop();
		status = 'idle';

		complete();
		queuedTimer();
		timers.advance(3_000);

		expect({ status, pending: timers.pendingCount }).toEqual({ status: 'idle', pending: 0 });
	});

	it('keeps ownership of a new timer when a cancelled generation callback arrives late', () => {
		const timers = new ManualTimers();
		const lifecycle = new VoiceLifecycle(timers);
		const oldGeneration = lifecycle.start();
		lifecycle.schedule(oldGeneration, 3_000, () => { throw new Error('stale reconnect ran'); });
		const queuedOldTimer = timers.scheduled[0]!.handler;

		const currentGeneration = lifecycle.start();
		lifecycle.schedule(currentGeneration, 20_000, () => { throw new Error('stopped reconnect ran'); });
		queuedOldTimer();
		lifecycle.stop();

		expect(timers.pendingCount).toBe(0);
		timers.advance(20_000);
	});

	it('permanently invalidates callbacks and timers when disposed', () => {
		const timers = new ManualTimers();
		const lifecycle = new VoiceLifecycle(timers);
		let calls = 0;
		const generation = lifecycle.start();
		lifecycle.schedule(generation, 3_000, () => { calls++; });
		const queuedTimer = timers.scheduled[0]!.handler;

		lifecycle.dispose();
		const pendingAfterDispose = timers.pendingCount;
		queuedTimer();
		timers.advance(3_000);

		expect({ calls, current: lifecycle.isCurrent(generation), pendingAfterDispose, pending: timers.pendingCount }).toEqual({
			calls: 0,
			current: false,
			pendingAfterDispose: 0,
			pending: 0,
		});
	});
});

describe('mobile voice notification orchestrator', () => {
	it('ignores a delayed subscribe completion after stop instead of restoring live state', async () => {
		const timers = new ManualTimers();
		const host = new FakeVoiceHost();
		const pendingSubscribe = deferred<void>();
		host.subscribeResults.push(pendingSubscribe.promise);
		const lifecycle = new MobileVoiceLifecycle(host, timers);

		lifecycle.start();
		await flushPromises();
		lifecycle.stop();
		pendingSubscribe.resolve();
		await flushPromises();

		expect({ state: host.state, pending: timers.pendingCount, unsubscriptions: host.unsubscriptions }).toEqual({
			state: { desired: false, status: 'idle' },
			pending: 0,
			unsubscriptions: ['voice-test-1'],
		});
	});

	it('uses the production retry and resubscribe delays', async () => {
		const timers = new ManualTimers();
		const host = new FakeVoiceHost();
		host.snapshot = { nativeSupported: true, protocolUnsupported: false, connectionReady: false };
		const lifecycle = new MobileVoiceLifecycle(host, timers);

		lifecycle.start();
		await flushPromises();
		expect(timers.scheduled.map(timer => timer.ms)).toEqual([3_000]);

		host.snapshot = { nativeSupported: true, protocolUnsupported: false, connectionReady: true };
		timers.advance(3_000);
		await flushPromises();

		expect(timers.scheduled.map(timer => timer.ms)).toEqual([3_000, 20_000]);
		expect(host.state).toEqual({ desired: true, status: 'live' });
	});

	it('does not let an old queued timer steal or run the new session timer across start-stop-start', async () => {
		const timers = new ManualTimers();
		const host = new FakeVoiceHost();
		host.snapshot = { nativeSupported: true, protocolUnsupported: false, connectionReady: false };
		const lifecycle = new MobileVoiceLifecycle(host, timers);

		lifecycle.start();
		await flushPromises();
		const queuedOldTimer = timers.scheduled[0]!.handler;
		lifecycle.stop();
		lifecycle.start();
		await flushPromises();
		queuedOldTimer();
		const pendingAfterOldCallback = timers.pendingCount;
		lifecycle.stop();

		expect({ state: host.state, pendingAfterOldCallback, pending: timers.pendingCount, subscriptions: host.subscriptions }).toEqual({
			state: { desired: false, status: 'idle' },
			pendingAfterOldCallback: 1,
			pending: 0,
			subscriptions: [],
		});
	});

	it('cancels the active timer and rejects queued work permanently on dispose', async () => {
		const timers = new ManualTimers();
		const host = new FakeVoiceHost();
		host.snapshot = { nativeSupported: true, protocolUnsupported: false, connectionReady: false };
		const lifecycle = new MobileVoiceLifecycle(host, timers);

		lifecycle.start();
		await flushPromises();
		const queuedTimer = timers.scheduled[0]!.handler;
		lifecycle.dispose();
		queuedTimer();
		timers.advance(3_000);

		expect({ state: host.state, pending: timers.pendingCount, afterStop: host.afterStopCount }).toEqual({
			state: { desired: false, status: 'idle' },
			pending: 0,
			afterStop: 1,
		});
	});
});
