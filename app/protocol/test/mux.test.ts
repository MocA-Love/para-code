// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { createInitiator, generateIdentity, respondHandshake } from '../src/crypto.js';
import { Channels } from '../src/frames.js';
import { FRAME_CHUNK_BYTES, FrameMux } from '../src/mux.js';

function establish() {
	const mobile = generateIdentity();
	const pc = generateIdentity();
	const initiator = createInitiator(mobile, pc.publicKey);
	const responder = respondHandshake(pc, mobile.publicKey, initiator.hello);
	const { channel: mobileChannel, confirm } = initiator.finish(responder.response);
	responder.verifyConfirm(confirm);
	return { mobileChannel, pcChannel: responder.channel };
}

describe('FrameMux over SecureChannel', () => {
	test('multiplexes channels and delivers to matching handler', () => {
		const { mobileChannel, pcChannel } = establish();

		// mobile側から送り、pc側で受ける配線
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { /* pc→mobile unused here */ } });
		const mobileMux = new FrameMux(mobileChannel, { sendSealed: sealed => pcMux.receive(sealed) });

		const received: { ch: string; text: string; ws?: string }[] = [];
		pcMux.on(Channels.Terminal, f => received.push({ ch: f.ch, text: new TextDecoder().decode(f.payload), ws: f.ws }));
		pcMux.on(Channels.Scm, f => received.push({ ch: f.ch, text: new TextDecoder().decode(f.payload) }));

		mobileMux.send(Channels.Terminal, new TextEncoder().encode('input'), 'para-code');
		mobileMux.send(Channels.Scm, new TextEncoder().encode('commit'));
		// ハンドラ未登録のチャネルは黙って無視される
		mobileMux.send(Channels.Browser, new TextEncoder().encode('ignored'));

		expect(received).toEqual([
			{ ch: 'term', text: 'input', ws: 'para-code' },
			{ ch: 'scm', text: 'commit' },
		]);
	});

	test('chunks payloads above FRAME_CHUNK_BYTES and reassembles them transparently', () => {
		const { mobileChannel, pcChannel } = establish();

		let sealedCount = 0;
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { } });
		const mobileMux = new FrameMux(mobileChannel, { sendSealed: sealed => { sealedCount++; pcMux.receive(sealed); } });

		const received: { size: number; ws?: string; first: number; last: number }[] = [];
		pcMux.on(Channels.Fs, f => received.push({ size: f.payload.length, ws: f.ws, first: f.payload[0]!, last: f.payload[f.payload.length - 1]! }));

		// チャンク2.5個分の大きなペイロード（xlsx HTML相当）
		const big = new Uint8Array(Math.floor(FRAME_CHUNK_BYTES * 2.5));
		big[0] = 7;
		big[big.length - 1] = 9;
		mobileMux.send(Channels.Fs, big, 'para-code');
		// 直後の小さなフレームも正しく独立して届く
		mobileMux.send(Channels.Fs, new Uint8Array([42]));

		expect(sealedCount).toBe(4); // 3チャンク + 1
		expect(received).toEqual([
			{ size: big.length, ws: 'para-code', first: 7, last: 9 },
			{ size: 1, ws: undefined, first: 42, last: 42 },
		]);
	});

	test('reports error on out-of-order sealed bytes instead of throwing', () => {
		const { mobileChannel, pcChannel } = establish();
		const errors: unknown[] = [];
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { }, onError: e => errors.push(e) });

		const seq: Uint8Array[] = [];
		const mobileMux = new FrameMux(mobileChannel, { sendSealed: s => seq.push(s) });
		mobileMux.send(Channels.State, new Uint8Array([1]));
		mobileMux.send(Channels.State, new Uint8Array([2]));

		// 2番目を先に渡す → カウンタnonce不一致でonErrorに流れる
		pcMux.receive(seq[1]!);
		expect(errors.length).toBe(1);
	});
});
