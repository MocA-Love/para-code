// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./appState.js', () => ({
	useAppStore: { getState: () => { throw new Error('default app store must not be used by dependency-injected tests'); } },
}));
import {
	WebrtcMirrorCoordinator,
	startWebrtcMirrorWithDependencies,
	type RtcPeerConnectionLike,
	type WebrtcMirrorHost,
	type WebrtcMirrorSession,
	type WebrtcMirrorStartDependencies,
	type WebrtcMirrorTimers,
} from './webrtcMirror.js';

class ManualTimers implements WebrtcMirrorTimers {
	private nextHandle = 1;
	private now = 0;
	private readonly pending = new Map<number, { readonly at: number; readonly handler: () => void }>();

	setTimeout(handler: () => void, ms: number): unknown {
		const handle = this.nextHandle++;
		this.pending.set(handle, { at: this.now + ms, handler });
		return handle;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === 'number') {
			this.pending.delete(handle);
		}
	}

	advance(ms: number): void {
		this.now += ms;
		for (const [handle, timer] of [...this.pending]) {
			if (timer.at <= this.now) {
				this.pending.delete(handle);
				timer.handler();
			}
		}
	}

	get pendingCount(): number {
		return this.pending.size;
	}
}

class FakePeer implements RtcPeerConnectionLike {
	connectionState = 'new';
	onicecandidate: ((event: { candidate?: { toJSON(): object } | null }) => void) | null = null;
	ontrack: ((event: { streams: { toURL(): string }[] }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	readonly iceCandidates: object[] = [];
	readonly remoteDescriptions: object[] = [];
	closeCount = 0;

	addTransceiver(_kind: string, _init: { direction: string }): void { }
	async createOffer(): Promise<{ sdp?: string; type: string }> { return { type: 'offer', sdp: 'mobile-offer' }; }
	async setLocalDescription(_desc: object): Promise<void> { }
	async setRemoteDescription(desc: object): Promise<void> { this.remoteDescriptions.push(desc); }
	async addIceCandidate(candidate: object): Promise<void> { this.iceCandidates.push(candidate); }
	close(): void { this.closeCount++; }
	addEventListener(_type: string, _listener: (event: never) => void): void { }

	emitTrack(stream: { toURL(): string } = { toURL: () => 'stream://one' }): void {
		this.ontrack?.({ streams: [stream] });
	}

	emitConnectionState(state: string): void {
		this.connectionState = state;
		this.onconnectionstatechange?.();
	}
}

class FakeHost implements WebrtcMirrorHost {
	readonly stopped: string[] = [];
	readonly cleared: string[] = [];
	readonly sentIce: { readonly sid: string; readonly candidate: object }[] = [];
	handler: { readonly sid: string; readonly fn: (candidate: object) => void } | undefined;
	offerResult: Promise<{ sdp?: string }> = Promise.resolve({ sdp: 'desktop-answer' });
	readonly turnResults: Promise<object[]>[] = [];

	fetchTurnIceServers(): Promise<object[]> { return this.turnResults.shift() ?? Promise.resolve([]); }
	webrtcOffer(_targetId: string, _sdp: string, _sid: string): Promise<{ sdp?: string }> { return this.offerResult; }
	webrtcSendIce(candidate: object, sid: string): void { this.sentIce.push({ sid, candidate }); }
	webrtcStop(sid: string): void { this.stopped.push(sid); }
	setWebrtcIceHandler(sid: string, handler: (candidate: object) => void): void { this.handler = { sid, fn: handler }; }
	clearWebrtcIceHandler(sid: string): void {
		this.cleared.push(sid);
		if (this.handler?.sid === sid) {
			this.handler = undefined;
		}
	}
}

function createDependencies(peer: FakePeer, host: FakeHost, timers: ManualTimers, sid = 'sid-one'): WebrtcMirrorStartDependencies {
	return {
		createPeer: () => peer,
		host,
		timers,
		createSessionId: () => sid,
	};
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}

describe('WebRTC mirror transport lifecycle', () => {
	it('rejects and cleans up at the connect deadline while the signaling answer is still pending', async () => {
		const timers = new ManualTimers();
		const peer = new FakePeer();
		const host = new FakeHost();
		const answer = deferred<{ sdp?: string }>();
		host.offerResult = answer.promise;
		const started = startWebrtcMirrorWithDependencies('target-one', createDependencies(peer, host, timers));
		let outcome: string | undefined;
		void started.then(
			() => { outcome = 'resolved'; },
			error => { outcome = error instanceof Error ? error.message : String(error); },
		);
		await flushPromises();

		timers.advance(10_000);
		await flushPromises();

		expect({ outcome, closeCount: peer.closeCount, stopped: host.stopped, timers: timers.pendingCount }).toEqual({
			outcome: 'webrtc connect timeout',
			closeCount: 1,
			stopped: ['sid-one'],
			timers: 0,
		});

		answer.resolve({ sdp: 'late-answer' });
		await flushPromises();
		expect({ outcome, closeCount: peer.closeCount, remoteDescriptions: peer.remoteDescriptions.length, stopped: host.stopped }).toEqual({
			outcome: 'webrtc connect timeout',
			closeCount: 1,
			remoteDescriptions: 0,
			stopped: ['sid-one'],
		});
	});

	it('closes the peer and clears the matching SID when connection establishment times out', async () => {
		const timers = new ManualTimers();
		const peer = new FakePeer();
		const host = new FakeHost();
		const started = startWebrtcMirrorWithDependencies('target-one', createDependencies(peer, host, timers));
		await flushPromises();

		timers.advance(10_000);

		await expect(started).rejects.toThrow('webrtc connect timeout');
		expect({ closeCount: peer.closeCount, cleared: host.cleared, stopped: host.stopped, timers: timers.pendingCount }).toEqual({
			closeCount: 1,
			cleared: ['sid-one'],
			stopped: ['sid-one'],
			timers: 0,
		});
	});

	it('notifies a listener registered after an early peer close instead of leaving JPEG suspended', async () => {
		const timers = new ManualTimers();
		const peer = new FakePeer();
		const host = new FakeHost();
		const started = startWebrtcMirrorWithDependencies('target-one', createDependencies(peer, host, timers));
		await flushPromises();
		peer.emitTrack({
			toURL: () => {
				peer.emitConnectionState('failed');
				return 'stream://already-closed';
			},
		});
		const session = await started;
		let closeNotifications = 0;

		session.onClosed(() => { closeNotifications++; });

		expect({ closeNotifications, closeCount: peer.closeCount, timers: timers.pendingCount }).toEqual({
			closeNotifications: 1,
			closeCount: 1,
			timers: 0,
		});
	});

	it('stops once and releases the SID handler and grace timer on explicit stop', async () => {
		const timers = new ManualTimers();
		const peer = new FakePeer();
		const host = new FakeHost();
		const started = startWebrtcMirrorWithDependencies('target-one', createDependencies(peer, host, timers));
		await flushPromises();
		peer.emitTrack();
		const session = await started;
		let closeNotifications = 0;
		session.onClosed(() => { closeNotifications++; });
		peer.emitConnectionState('disconnected');

		session.stop();
		session.stop();
		timers.advance(5_000);

		expect({ closeCount: peer.closeCount, closeNotifications, cleared: host.cleared, stopped: host.stopped, timers: timers.pendingCount }).toEqual({
			closeCount: 1,
			closeNotifications: 1,
			cleared: ['sid-one'],
			stopped: ['sid-one'],
			timers: 0,
		});
	});
});

describe('WebRTC mirror display coordinator', () => {
	it('returns to JPEG immediately while replacing an established WebRTC session', async () => {
		const next = deferred<WebrtcMirrorSession>();
		let firstStops = 0;
		const starts = [
			Promise.resolve({ streamUrl: 'stream://one', stop() { firstStops++; }, onClosed() { } }),
			next.promise,
		];
		const displayed: Array<string | undefined> = [];
		const coordinator = new WebrtcMirrorCoordinator(
			() => starts.shift()!,
			session => displayed.push(session?.streamUrl),
			() => { },
		);
		coordinator.start('target-one');
		await flushPromises();

		coordinator.start('target-two');

		expect({ displayed, firstStops }).toEqual({ displayed: ['stream://one', undefined], firstStops: 1 });
	});

	it('falls back to JPEG after start failure and after a live session disconnects', async () => {
		const starts: Promise<WebrtcMirrorSession>[] = [];
		const displayed: Array<string | undefined> = [];
		const failures: string[] = [];
		const coordinator = new WebrtcMirrorCoordinator(
			() => starts.shift()!,
			session => displayed.push(session?.streamUrl),
			error => failures.push(error instanceof Error ? error.message : String(error)),
		);
		starts.push(Promise.reject(new Error('offer rejected')));

		coordinator.start('target-one');
		await flushPromises();

		let onClosed: (() => void) | undefined;
		starts.push(Promise.resolve({ streamUrl: 'stream://two', stop() { }, onClosed(cb) { onClosed = cb; } }));
		coordinator.start('target-two');
		await flushPromises();
		onClosed?.();

		expect({ displayed, failures }).toEqual({
			displayed: [undefined, 'stream://two', undefined],
			failures: ['offer rejected'],
		});
	});

	it('restores JPEG when the real transport stays disconnected past its grace period', async () => {
		const timers = new ManualTimers();
		const peer = new FakePeer();
		const host = new FakeHost();
		const displayed: Array<string | undefined> = [];
		const coordinator = new WebrtcMirrorCoordinator(
			targetId => startWebrtcMirrorWithDependencies(targetId, createDependencies(peer, host, timers)),
			session => displayed.push(session?.streamUrl),
			() => { },
		);

		coordinator.start('target-one');
		await flushPromises();
		peer.emitTrack();
		await flushPromises();
		peer.emitConnectionState('disconnected');
		timers.advance(4_999);
		expect(displayed).toEqual(['stream://one']);

		timers.advance(1);
		await flushPromises();

		expect({ displayed, closeCount: peer.closeCount, timers: timers.pendingCount }).toEqual({
			displayed: ['stream://one', undefined],
			closeCount: 1,
			timers: 0,
		});
	});

	it('does not let an old async completion replace or stop the current SID session', async () => {
		const first = deferred<WebrtcMirrorSession>();
		const second = deferred<WebrtcMirrorSession>();
		const starts = [first.promise, second.promise];
		const displayed: Array<string | undefined> = [];
		let firstStops = 0;
		let secondStops = 0;
		const coordinator = new WebrtcMirrorCoordinator(
			() => starts.shift()!,
			session => displayed.push(session?.streamUrl),
			() => { },
		);

		coordinator.start('target-one');
		coordinator.start('target-two');
		second.resolve({ streamUrl: 'stream://sid-two', stop() { secondStops++; }, onClosed() { } });
		await flushPromises();
		first.resolve({ streamUrl: 'stream://sid-one', stop() { firstStops++; }, onClosed() { } });
		await flushPromises();

		expect({ displayed, firstStops, secondStops }).toEqual({
			displayed: ['stream://sid-two'],
			firstStops: 1,
			secondStops: 0,
		});
	});

	it('keeps the new SID handler when an older real transport completes later', async () => {
		const timers = new ManualTimers();
		const firstPeer = new FakePeer();
		const secondPeer = new FakePeer();
		const host = new FakeHost();
		const displayed: Array<string | undefined> = [];
		const coordinator = new WebrtcMirrorCoordinator(
			targetId => startWebrtcMirrorWithDependencies(
				targetId,
				createDependencies(
					targetId === 'target-one' ? firstPeer : secondPeer,
					host,
					timers,
					targetId === 'target-one' ? 'sid-one' : 'sid-two',
				),
			),
			session => displayed.push(session?.streamUrl),
			() => { },
		);

		coordinator.start('target-one');
		await flushPromises();
		coordinator.start('target-two');
		await flushPromises();
		secondPeer.emitTrack({ toURL: () => 'stream://sid-two' });
		await flushPromises();
		firstPeer.emitTrack({ toURL: () => 'stream://sid-one' });
		await flushPromises();

		expect({ displayed, activeSid: host.handler?.sid, stopped: host.stopped }).toEqual({
			displayed: ['stream://sid-two'],
			activeSid: 'sid-two',
			stopped: ['sid-one'],
		});
	});

	it('does not let an older delayed TURN lookup overwrite the new SID handler', async () => {
		const timers = new ManualTimers();
		const firstPeer = new FakePeer();
		const secondPeer = new FakePeer();
		const host = new FakeHost();
		const delayedTurn = deferred<object[]>();
		host.turnResults.push(delayedTurn.promise, Promise.resolve([]));
		const displayed: Array<string | undefined> = [];
		const coordinator = new WebrtcMirrorCoordinator(
			(targetId, signal) => startWebrtcMirrorWithDependencies(
				targetId,
				createDependencies(
					targetId === 'target-one' ? firstPeer : secondPeer,
					host,
					timers,
					targetId === 'target-one' ? 'sid-one' : 'sid-two',
				),
				signal,
			),
			session => displayed.push(session?.streamUrl),
			() => { },
		);

		coordinator.start('target-one');
		await flushPromises();
		coordinator.start('target-two');
		await flushPromises();
		secondPeer.emitTrack({ toURL: () => 'stream://sid-two' });
		await flushPromises();
		delayedTurn.resolve([]);
		await flushPromises();

		expect({ displayed, activeSid: host.handler?.sid, firstPeerClosed: firstPeer.closeCount }).toEqual({
			displayed: ['stream://sid-two'],
			activeSid: 'sid-two',
			firstPeerClosed: 0,
		});
	});

	it('disposes the current session and rejects every delayed completion permanently', async () => {
		const late = deferred<WebrtcMirrorSession>();
		const displayed: Array<string | undefined> = [];
		let lateStops = 0;
		const coordinator = new WebrtcMirrorCoordinator(
			() => late.promise,
			session => displayed.push(session?.streamUrl),
			() => { },
		);

		coordinator.start('target-one');
		coordinator.dispose();
		late.resolve({ streamUrl: 'stream://late', stop() { lateStops++; }, onClosed() { } });
		await flushPromises();
		coordinator.start('target-two');
		await flushPromises();

		expect({ displayed, lateStops }).toEqual({ displayed: [undefined], lateStops: 1 });
	});
});
