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
import { IParadisAivisIngest } from '../../node/paradisAivisIngestClient.js';
import { ParadisNotificationsService } from '../../node/paradisNotificationsService.js';

class FakeStream implements IParadisIngestStream {
	readonly id = 'job';
	readonly handoffGate = new DeferredPromise<boolean>();
	readonly finishedGate = new DeferredPromise<IParadisIngestTerminal>();
	readonly handoff = this.handoffGate.p;
	readonly finished = this.finishedGate.p;
	onDidStart(): void { }
	async write(): Promise<void> { }
	async end(): Promise<void> { }
	async abort(): Promise<void> { }
}

class FakeIngest implements IParadisAivisIngest {
	readonly state = 'ready';
	readonly gainTable = undefined;
	usable = true;
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
}

const RINGTONE = { id: 'chime', volume: 50 };

function request(text: string, ringtone = true): IParadisNotifyAudioRequest {
	return { priority: 'normal', aivis: { apiKey: 'key', modelUuid: 'model', text }, ...(ringtone ? { ringtone: RINGTONE } : {}) };
}

suite('ParadisNotificationsService voice handoff', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	function createService(ingest: FakeIngest) {
		const events: string[] = [];
		const service = store.add(new ParadisNotificationsService(new NullLogService(), undefined, {
			ingest,
			resolveRingtonePath: id => `/sounds/${id}.mp3`,
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

	test('plays the ringtone at once when the scheduler is paused or the queue is full', async () => {
		stubFetch(401);
		const ingest = new FakeIngest();
		const { service, events } = createService(ingest);
		// 合成が 401（fatal）で一時停止する。worker は鳴らし始めていないので、着信音は Para Code が鳴らす
		service.notifyAudio(request('fatal'));
		await timeout(20);
		// 一時停止中の通知は列に入らない
		service.notifyAudio(request('paused'));
		await timeout(10);
		assert.deepStrictEqual(events, ['ringtone:chime', 'ringtone:chime']);
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
		assert.deepStrictEqual(events, ['ringtone:chime']);
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
		assert.deepStrictEqual({ opened: ingest.opened.map(open => open.prelude), holds: ingest.holds, events }, {
			opened: [undefined],
			holds: [['para-code-voice-input', true], ['para-code-voice-input', false]],
			events: [],
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
});
