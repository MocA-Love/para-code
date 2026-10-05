/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisNotifyAudioRequest } from '../../common/paradisNotifications.js';
import { IParadisIngestOpenOptions, IParadisIngestStream, IParadisIngestTerminal } from '../../common/paradisVoiceIngest.js';
import { IParadisAivisIngest, ParadisIngestClientState } from '../../node/paradisAivisIngestClient.js';
import { ParadisNotificationsService } from '../../node/paradisNotificationsService.js';

class FakeStream implements IParadisIngestStream {
	readonly id = 'job';
	readonly handoffGate = new DeferredPromise<boolean>();
	readonly finishedGate = new DeferredPromise<IParadisIngestTerminal>();
	readonly handoff = this.handoffGate.p;
	readonly finished = this.finishedGate.p;
	private readonly preludeListeners: Array<(reason: string) => void> = [];
	onDidStart(): void { }
	onDidRejectPrelude(listener: (reason: string) => void): void { this.preludeListeners.push(listener); }
	rejectPrelude(reason: string): void { this.preludeListeners.forEach(listener => listener(reason)); }
	async write(): Promise<void> { }
	async end(): Promise<void> { }
	async abort(reason: string): Promise<void> {
		// 鳴り始める前の中断は、aivis-mcp が skipped で知らせる
		if (!this.finishedGate.isSettled) {
			this.finishedGate.complete({ status: 'skipped', reason });
		}
	}
}

class FakeIngest implements IParadisAivisIngest {
	state: ParadisIngestClientState = 'ready';
	readonly gainTable = undefined;
	usable = true;
	/** 渡せないとき Para Code が自分で鳴らしてよいか（false は `--ingest` を起こし直している最中）。 */
	direct = true;
	muted = false;
	readonly opened: IParadisIngestOpenOptions[] = [];
	readonly holds: Array<[string, boolean]> = [];
	nextStream: () => FakeStream | undefined = () => new FakeStream();
	isUsable(): boolean { return this.usable; }
	async whenReady(): Promise<boolean> { return this.usable; }
	async hasLocalAivis(): Promise<boolean> { return true; }
	open(options: IParadisIngestOpenOptions): IParadisIngestStream | undefined {
		this.opened.push(options);
		return this.nextStream();
	}
	setHold(owner: string, active: boolean): void { this.holds.push([owner, active]); }
	mayPlayDirectly(): boolean { return this.direct; }
	async isMuted(): Promise<boolean> { return this.muted; }
	/** worker の再生 lock が空くのを待つ（テストでは手で解く）。 */
	playLock: Promise<void> | undefined;
	async whenPlayLockFree(): Promise<void> { await this.playLock; }
}

const RINGTONE = { id: 'chime', volume: 50 };

function request(text: string, ringtone = true): IParadisNotifyAudioRequest {
	return { priority: 'normal', aivis: { apiKey: 'key', modelUuid: 'model', text }, ...(ringtone ? { ringtone: RINGTONE } : {}) };
}

suite('ParadisNotificationsService voice handoff', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	function createService(ingest: FakeIngest, resolveRingtonePath: (id: string) => string | null = id => `/sounds/${id}.mp3`) {
		const events: string[] = [];
		const service = store.add(new ParadisNotificationsService(new NullLogService(), undefined, {
			ingest,
			resolveRingtonePath,
			playRingtoneFile: async id => { events.push(`ringtone:${id}`); },
			playVoiceAudio: async audio => { events.push(`voice:${audio.byteLength}`); },
		}));
		return { service, events };
	}

	function stubFetch(status = 200): sinon.SinonStub {
		return sinon.stub(globalThis, 'fetch').callsFake(async () => status === 200
			? new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2]))
			: new Response('nope', { status }));
	}

	test('hands the ringtone to the worker as the prelude and lets go at queued', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		const stream = new FakeStream();
		ingest.nextStream = () => stream;
		const { service, events } = createService(ingest);
		service.notifyAudio(request('hello'));
		await timeout(10);
		stream.handoffGate.complete(true);
		stream.finishedGate.complete({ status: 'done' });
		await timeout(10);
		assert.deepStrictEqual({ opened: ingest.opened, events }, {
			opened: [{ priority: 'normal', gainKey: 'aivis:model:default', volumeDb: 0, tagged: false, prelude: { path: '/sounds/chime.mp3', volume: 0.5 } }],
			events: [],
		});
	});

	test('plays the ringtone before the voice when the handoff falls back to afplay, with or without received audio', async () => {
		const fetchStub = stubFetch();
		const ingest = new FakeIngest();
		// 1 件目: 開けない（--ingest が使えなくなった）。2 件目: queued の前に失敗（受け取った音声で鳴らす）
		const failing = new FakeStream();
		const streams: Array<FakeStream | undefined> = [undefined, failing];
		ingest.nextStream = () => streams.shift();
		const { service, events } = createService(ingest);
		service.notifyAudio(request('first'));
		await timeout(20);
		service.notifyAudio(request('second'));
		await timeout(10);
		failing.handoffGate.complete(false);
		await timeout(20);
		assert.deepStrictEqual({ events, fetches: fetchStub.callCount }, {
			events: ['ringtone:chime', 'voice:6', 'ringtone:chime', 'voice:6'],
			fetches: 2,
		});
	});

	test('hands the ringtone to the worker as a sound job when the scheduler is paused, and plays it itself without --ingest (M3)', async () => {
		stubFetch(401);
		const ingest = new FakeIngest();
		const { service, events } = createService(ingest);
		// 合成が 401（fatal）で一時停止する。worker は鳴らし始めていないので、着信音は worker の列で鳴らす（mute・hold が効く）
		service.notifyAudio(request('fatal'));
		await timeout(20);
		// 一時停止中の通知は列に入らない
		service.notifyAudio(request('paused'));
		await timeout(10);
		const kinds = ingest.opened.map(open => open.kind ?? 'stream');
		ingest.usable = false;
		service.notifyAudio(request('paused-without-ingest'));
		await timeout(10);
		assert.deepStrictEqual({ kinds, events }, { kinds: ['stream', 'sound', 'sound'], events: ['ringtone:chime'] });
	});

	test('plays the ringtone of a notification dropped from a full queue', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		// 渡した 3 本が queued にならないまま塞がる
		ingest.nextStream = () => new FakeStream();
		const { service, events } = createService(ingest);
		for (let i = 0; i < 23; i++) {
			service.notifyAudio(request(`n${i}`));
		}
		service.notifyAudio(request('overflow'));
		await timeout(20);
		// 列からあふれた通知の着信音は、worker の列で鳴らす（M3）
		assert.deepStrictEqual({ events, sounds: ingest.opened.filter(open => open.kind === 'sound').length }, { events: [], sounds: 1 });
	});

	test('drops the ringtone while dictating and holds the worker', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		const stream = new FakeStream();
		ingest.nextStream = () => stream;
		const { service, events } = createService(ingest);
		service.setDictationActive('window', true);
		service.notifyAudio(request('hello'));
		service.notifyAudio({ priority: 'normal', ringtone: RINGTONE });
		await timeout(10);
		stream.handoffGate.complete(true);
		service.setDictationActive('window', false);
		// hold の持ち主は shared process ごとに違う（L1）
		const owner = ingest.holds[0]?.[0] ?? '';
		assert.deepStrictEqual({ opened: ingest.opened.map(open => open.prelude), holds: ingest.holds, events, ownerShape: /^para-code-voice-input-[0-9a-f-]{36}$/.test(owner) }, {
			opened: [undefined],
			holds: [[owner, true], [owner, false]],
			events: [],
			ownerShape: true,
		});
	});

	test('re-attaches the ringtone to the retried job when the synthesis failed before the worker started', async () => {
		let calls = 0;
		sinon.stub(globalThis, 'fetch').callsFake(async () => ++calls === 1 ? new Response('busy', { status: 503 }) : new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00])));
		const ingest = new FakeIngest();
		const { service, events } = createService(ingest);
		service.notifyAudio(request('retry'));
		// 再試行の待ち（1 秒）の後に 2 件目を開く
		await timeout(1_200);
		assert.deepStrictEqual({ preludes: ingest.opened.map(open => open.prelude?.path), events }, {
			preludes: ['/sounds/chime.mp3', '/sounds/chime.mp3'],
			events: [],
		});
	});
	test('re-hands a withdrawn ringtone-only job while it is fresh (M5)', async () => {
		const ingest = new FakeIngest();
		const first = new FakeStream();
		const second = new FakeStream();
		const streams = [first, second];
		ingest.nextStream = () => streams.shift();
		const { service, events } = createService(ingest);
		service.notifyAudio({ priority: 'normal', ringtone: RINGTONE });
		await timeout(5);
		first.handoffGate.complete(true);
		first.finishedGate.complete({ status: 'failed', reason: 'ingest-exited', withdrawn: true });
		await timeout(10);
		assert.deepStrictEqual({ kinds: ingest.opened.map(open => open.kind), events }, { kinds: ['sound', 'sound'], events: [] });
	});

	test('does not play the voice or the ringtone itself while the user muted aivis (L11)', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		ingest.usable = false;
		ingest.muted = true;
		const { service, events } = createService(ingest);
		service.notifyAudio(request('muted'));
		await timeout(20);
		const queued = await service.playFallback(new Uint8Array([0xff, 0xfb, 0x90, 0x00]));
		await timeout(20);
		assert.deepStrictEqual({ events, queued }, { events: [], queued: true });
	});

	test('waits for --ingest to come back instead of playing locally while the worker may be alive (H5)', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		ingest.usable = false;
		ingest.direct = false;
		ingest.state = 'starting';
		const stream = new FakeStream();
		ingest.nextStream = () => stream;
		const { service, events } = createService(ingest);
		service.notifyAudio(request('restarting', false));
		await timeout(30);
		const whileRestarting = [...events];
		ingest.usable = true;
		ingest.state = 'ready';
		await timeout(1_100);
		stream.handoffGate.complete(true);
		await timeout(10);
		assert.deepStrictEqual({ whileRestarting, events, opened: ingest.opened.length }, { whileRestarting: [], events: [], opened: 1 });
	});

	test('plays the ringtone itself when the worker rejects it as a prelude or it is too large to be one (M4, L3)', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		const stream = new FakeStream();
		ingest.nextStream = () => stream;
		const { service, events } = createService(ingest);
		service.notifyAudio(request('rejected'));
		await timeout(10);
		stream.rejectPrelude('outside-prelude-dir');
		stream.handoffGate.complete(true);
		await timeout(10);
		assert.deepStrictEqual({ prelude: ingest.opened[0]?.prelude?.path, events }, { prelude: '/sounds/chime.mp3', events: ['ringtone:chime'] });
	});

	test('keeps an accepted remote voice in a reserved slot when the queue is full (M7)', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		ingest.nextStream = () => new FakeStream();
		const { service } = createService(ingest);
		for (let i = 0; i < 24; i++) {
			service.notifyAudio(request(`n${i}`, false));
		}
		await timeout(10);
		assert.strictEqual(await service.playFallback(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), true);
	});
	test('waits for the worker play lock before playing a voice itself (M-6)', async () => {
		stubFetch();
		const ingest = new FakeIngest();
		ingest.usable = false;
		const lock = new DeferredPromise<void>();
		ingest.playLock = lock.p;
		const { service, events } = createService(ingest);
		service.notifyAudio(request('locked', false));
		await timeout(20);
		const whileLocked = [...events];
		lock.complete();
		await timeout(10);
		assert.deepStrictEqual({ whileLocked, events }, { whileLocked: [], events: ['voice:6'] });
	});

	test('does not play a ringtone-only job that turned out unqueued after it went stale (L-1)', async () => {
		const ingest = new FakeIngest();
		const stream = new FakeStream();
		ingest.nextStream = () => stream;
		const { service, events } = createService(ingest);
		const clock = sinon.useFakeTimers({ now: 0, toFake: ['Date'] });
		try {
			service.notifyAudio({ priority: 'normal', ringtone: RINGTONE });
			await timeout(5);
			clock.setSystemTime(6_000);
			stream.handoffGate.complete(false);
			await timeout(10);
		} finally {
			clock.restore();
		}
		assert.deepStrictEqual(events, []);
	});
});
