/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Channels, ChannelId } from '../../common/paradisMobileProtocol.js';
import { paradisDecodeVoiceStreamChunk, paradisIsVoiceStreamChunk } from '../../common/paradisMobileVoiceStream.js';
import { PARADIS_VOICE_SUBSCRIPTION_TTL_MS, ParadisVoiceSubscriptions } from '../../common/paradisVoiceSubscriptions.js';
import { IParadisVoiceClipSession, paradisCreateVoiceDelivery } from '../../node/paradisVoiceClipDelivery.js';

const STREAM_ID = '00112233445566778899aabbccddeeff';

interface ISentFrame {
	readonly mobileId: string;
	readonly channel: ChannelId;
	readonly workspace: string | undefined;
	readonly payload: Uint8Array;
}

class FakeSession implements IParadisVoiceClipSession {
	hasCurrentProtocol = true;
	isOnline = true;
	epoch = 1;
	capabilities: readonly string[] | undefined = ['voice.clips.v1', 'voice.stream.v1'];

	constructor(private readonly mobileId: string, private readonly sent: ISentFrame[]) { }

	readonly sendFrame = async (channel: ChannelId, workspace: string | undefined, payload: Uint8Array) => {
		this.sent.push({ mobileId: this.mobileId, channel, workspace, payload });
	};
}

/** 送った browser のフレームを読める形にする（JSON はそのまま、2 進の断片は印・番号・長さ）。 */
function describeFrame(frame: ISentFrame): unknown {
	if (paradisIsVoiceStreamChunk(frame.payload)) {
		const chunk = paradisDecodeVoiceStreamChunk(frame.payload)!;
		return { to: frame.mobileId, chunk: { streamId: chunk.streamId, seq: chunk.seq, bytes: chunk.data.length } };
	}
	return { to: frame.mobileId, ...JSON.parse(new TextDecoder().decode(frame.payload)) };
}

function setup(options: { congestion?: number } = {}) {
	const subscriptions = new ParadisVoiceSubscriptions();
	const sent: ISentFrame[] = [];
	const sessions = new Map<string, FakeSession>();
	const timers: (() => void)[] = [];
	const warnings: string[] = [];
	let congestion = options.congestion ?? 0;
	const delivery = paradisCreateVoiceDelivery(subscriptions, {
		getSession: mobileId => sessions.get(mobileId),
		congestionBytes: () => congestion,
		warn: message => warnings.push(message),
	});
	const addMobile = (mobileId: string, sid: string) => {
		const session = new FakeSession(mobileId, sent);
		sessions.set(mobileId, session);
		subscriptions.start(mobileId, sid, Date.now());
		return session;
	};
	return { subscriptions, sent, sessions, timers, warnings, delivery, addMobile, setCongestion: (value: number) => { congestion = value; } };
}

suite('ParadisMobileVoiceDelivery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('streams to a mobile that advertises voice.stream.v1 and sends one clip with gainDb to a mobile that does not', () => {
		const { sent, delivery, addMobile } = setup();
		addMobile('new-app', 'sid-new');
		addMobile('old-app', 'sid-old').capabilities = ['voice.clips.v1'];

		delivery.handle({ kind: 'stream-start', streamId: STREAM_ID, gainDb: 4.1 });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array([1, 2, 3]) });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array(9000) });
		delivery.handle({ kind: 'stream-end', streamId: STREAM_ID, aborted: false });

		assert.deepStrictEqual({ channels: [...new Set(sent.map(frame => `${frame.channel}:${frame.workspace}`))], frames: sent.map(describeFrame) }, {
			channels: [`${Channels.Browser}:undefined`],
			frames: [
				{ to: 'new-app', t: 'voice-stream-start', sid: 'sid-new', streamId: STREAM_ID, mime: 'audio/mpeg', gainDb: 4.1, epoch: 1 },
				// 最初の音はすぐ送る
				{ to: 'new-app', chunk: { streamId: STREAM_ID, seq: 0, bytes: 3 } },
				// 8KiB を超えたらまとめて送る
				{ to: 'new-app', chunk: { streamId: STREAM_ID, seq: 1, bytes: 9000 } },
				{ to: 'new-app', t: 'voice-stream-end', streamId: STREAM_ID, seq: 2, bytes: 9003, aborted: false },
				{ to: 'old-app', t: 'voice-clip', sid: 'sid-old', mime: 'audio/mpeg', data: Buffer.from(new Uint8Array([1, 2, 3, ...new Uint8Array(9000)])).toString('base64'), gainDb: 4.1 },
			],
		});
	});

	test('batches small chunks for 100 ms after the first one', async () => {
		const { sent, delivery, addMobile } = setup();
		addMobile('mobile-1', 'sid-1');

		delivery.handle({ kind: 'stream-start', streamId: STREAM_ID, gainDb: 0 });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array(10) });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array(20) });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array(30) });
		const beforeTimer = sent.length;
		await new Promise(resolve => setTimeout(resolve, 150));
		const afterTimer = sent.map(describeFrame).slice(beforeTimer);
		delivery.handle({ kind: 'stream-end', streamId: STREAM_ID, aborted: false });

		assert.deepStrictEqual({ beforeTimer, afterTimer, end: describeFrame(sent[sent.length - 1]) }, {
			beforeTimer: 2,
			afterTimer: [{ to: 'mobile-1', chunk: { streamId: STREAM_ID, seq: 1, bytes: 50 } }],
			end: { to: 'mobile-1', t: 'voice-stream-end', streamId: STREAM_ID, seq: 2, bytes: 60, aborted: false },
		});
	});

	test('sends the whole utterance as one clip when the relay socket is congested at the first audio', () => {
		const { sent, delivery, addMobile, setCongestion } = setup({ congestion: 300 * 1024 });
		addMobile('mobile-1', 'sid-1');

		delivery.handle({ kind: 'stream-start', streamId: STREAM_ID, gainDb: -7.4 });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array([1]) });
		// 途中で空いても、鳴り始めで決めた送り方は変えない
		setCongestion(0);
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array([2]) });
		delivery.handle({ kind: 'stream-end', streamId: STREAM_ID, aborted: false });

		assert.deepStrictEqual(sent.map(describeFrame), [
			{ to: 'mobile-1', t: 'voice-clip', sid: 'sid-1', mime: 'audio/mpeg', data: 'AQI=', gainDb: -7.4 },
		]);
	});

	test('always ends a started stream with aborted when the source stops, and sends no clip', () => {
		const { sent, delivery, addMobile } = setup();
		addMobile('mobile-1', 'sid-1');
		addMobile('old-app', 'sid-old').capabilities = undefined;

		delivery.handle({ kind: 'stream-start', streamId: STREAM_ID, gainDb: 0 });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array([1]) });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array([2]) });
		delivery.handle({ kind: 'stream-end', streamId: STREAM_ID, aborted: true });

		assert.deepStrictEqual(sent.map(describeFrame).filter(frame => (frame as { t?: string }).t !== 'voice-stream-start'), [
			{ to: 'mobile-1', chunk: { streamId: STREAM_ID, seq: 0, bytes: 1 } },
			{ to: 'mobile-1', t: 'voice-stream-end', streamId: STREAM_ID, seq: 1, bytes: 1, aborted: true },
		]);
	});

	test('sends nothing for a stream that never produced audio', () => {
		const { sent, delivery, addMobile } = setup();
		addMobile('mobile-1', 'sid-1');

		delivery.handle({ kind: 'stream-start', streamId: STREAM_ID, gainDb: 0 });
		delivery.handle({ kind: 'stream-end', streamId: STREAM_ID, aborted: true });

		assert.deepStrictEqual(sent, []);
	});

	test('stops sending when the session epoch changes, and ends with aborted when the mobile unsubscribes', () => {
		const { sent, delivery, addMobile, subscriptions } = setup();
		const reconnected = addMobile('reconnected', 'sid-a');
		addMobile('stopped', 'sid-b');

		delivery.handle({ kind: 'stream-start', streamId: STREAM_ID, gainDb: 0 });
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array(10_000) });
		reconnected.epoch = 2;
		subscriptions.stop('stopped', 'sid-b');
		delivery.handle({ kind: 'stream-data', streamId: STREAM_ID, chunk: new Uint8Array(10_000) });
		delivery.handle({ kind: 'stream-end', streamId: STREAM_ID, aborted: false });

		assert.deepStrictEqual(sent.map(describeFrame).filter(frame => (frame as { t?: string }).t !== 'voice-stream-start'), [
			{ to: 'reconnected', chunk: { streamId: STREAM_ID, seq: 0, bytes: 10_000 } },
			{ to: 'stopped', chunk: { streamId: STREAM_ID, seq: 0, bytes: 10_000 } },
			// 張り直した端末には何も送らない（新しいセッションのアプリはこの流れを知らない）
			{ to: 'stopped', t: 'voice-stream-end', streamId: STREAM_ID, seq: 1, bytes: 10_000, aborted: true },
		]);
	});

	test('delivers every clip in order without dropping the second one while the first is in flight', () => {
		const { sent, delivery, addMobile } = setup();
		addMobile('mobile-1', 'sid-1');

		delivery.handle({ kind: 'clip', audio: Uint8Array.of(0, 1, 2, 253, 254, 255), gainDb: 1.4 });
		delivery.handle({ kind: 'clip', audio: Uint8Array.of(9), gainDb: 99 });

		assert.deepStrictEqual(sent.map(describeFrame), [
			{ to: 'mobile-1', t: 'voice-clip', sid: 'sid-1', mime: 'audio/mpeg', data: 'AAEC/f7/', gainDb: 1.4 },
			{ to: 'mobile-1', t: 'voice-clip', sid: 'sid-1', mime: 'audio/mpeg', data: 'CQ==', gainDb: 8 },
		]);
	});

	test('excludes offline sessions and expired subscriptions', () => {
		const { sent, delivery, addMobile, subscriptions } = setup();
		addMobile('offline', 'sid-1').isOnline = false;
		addMobile('expired', 'sid-2');
		subscriptions.start('expired', 'sid-2', Date.now() - PARADIS_VOICE_SUBSCRIPTION_TTL_MS - 1);

		delivery.handle({ kind: 'clip', audio: Uint8Array.of(1), gainDb: 0 });

		assert.deepStrictEqual(sent, []);
	});
});
