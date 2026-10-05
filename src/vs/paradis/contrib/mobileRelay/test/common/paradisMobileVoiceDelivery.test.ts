/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsVoiceStreamChunk, PARADIS_VOICE_STREAM_MAX_BYTES } from '../../common/paradisMobileVoiceStream.js';
import { IParadisVoiceDeliverySession, PARADIS_VOICE_STREAM_IDLE_LIMIT_MS, ParadisMobileVoiceDelivery, ParadisVoiceSubscriptions } from '../../common/paradisVoiceSubscriptions.js';

function streamId(n: number): string {
	return n.toString(16).padStart(32, '0');
}

function setup(capabilities: readonly string[] | undefined) {
	let now = 1_000;
	const sent: string[] = [];
	const subscriptions = new ParadisVoiceSubscriptions(Number.MAX_SAFE_INTEGER);
	subscriptions.start('mobile-1', 'sid-1', now);
	const session: IParadisVoiceDeliverySession = {
		hasCurrentProtocol: true,
		isOnline: true,
		epoch: 1,
		capabilities,
		sendFrame: async payload => {
			sent.push(paradisIsVoiceStreamChunk(payload) ? `chunk:${payload.length - 24}` : (JSON.parse(new TextDecoder().decode(payload)) as { t: string; aborted?: boolean }).t + ((JSON.parse(new TextDecoder().decode(payload)) as { aborted?: boolean }).aborted ? ':aborted' : ''));
		},
	};
	const delivery = new ParadisMobileVoiceDelivery(subscriptions, {
		getSession: () => session,
		congestionBytes: () => 0,
		encodeBase64: bytes => `b64:${bytes.length}`,
		warn: () => { },
		now: () => now,
	});
	return { delivery, sent, advance: (ms: number) => { now += ms; } };
}

suite('ParadisMobileVoiceDelivery limits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aborts and forgets a stream that has not been written to for 150 seconds, so it cannot hold a slot forever', () => {
		const { delivery, sent, advance } = setup(['voice.stream.v1']);
		for (let i = 1; i <= 16; i++) {
			delivery.handle({ kind: 'stream-start', streamId: streamId(i), gainDb: 0 });
		}
		delivery.handle({ kind: 'stream-data', streamId: streamId(1), chunk: new Uint8Array(4) });
		advance(PARADIS_VOICE_STREAM_IDLE_LIMIT_MS + 1);
		// 16 本が枠を握ったまま。新しい流れの開始で古い流れを掃除する
		delivery.handle({ kind: 'stream-start', streamId: streamId(99), gainDb: 0 });
		delivery.handle({ kind: 'stream-data', streamId: streamId(99), chunk: new Uint8Array(5) });
		delivery.handle({ kind: 'stream-end', streamId: streamId(99), aborted: false });

		assert.deepStrictEqual(sent, [
			'voice-stream-start', 'chunk:4',
			'voice-stream-end:aborted',
			'voice-stream-start', 'chunk:5', 'voice-stream-end',
		]);
	});

	test('applies the 8 MiB limit to a mobile that only gets the whole clip', () => {
		const { delivery, sent } = setup(['voice.clips.v1']);
		delivery.handle({ kind: 'stream-start', streamId: streamId(1), gainDb: 0 });
		delivery.handle({ kind: 'stream-data', streamId: streamId(1), chunk: new Uint8Array(PARADIS_VOICE_STREAM_MAX_BYTES) });
		delivery.handle({ kind: 'stream-data', streamId: streamId(1), chunk: new Uint8Array(1) });
		delivery.handle({ kind: 'stream-end', streamId: streamId(1), aborted: false });
		delivery.handle({ kind: 'stream-start', streamId: streamId(2), gainDb: 0 });
		delivery.handle({ kind: 'stream-data', streamId: streamId(2), chunk: new Uint8Array(3) });
		delivery.handle({ kind: 'stream-end', streamId: streamId(2), aborted: false });

		assert.deepStrictEqual(sent, ['voice-clip']);
	});
});
