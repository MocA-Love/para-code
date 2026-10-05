// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { createInitiator, generateIdentity, respondHandshake } from '../src/crypto.js';
import { Channels, encodeFrame, type Frame } from '../src/frames.js';
import { FRAME_CHUNK_BYTES, FRAME_REASSEMBLY_LIMIT, FrameAssembler, FrameMux } from '../src/mux.js';

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

	test('reports every opened chunk before reassembly without changing delivery', () => {
		const { mobileChannel, pcChannel } = establish();
		const chunks: { ch: string; bytes: number; more: boolean }[] = [];
		const pcMux = new FrameMux(pcChannel, {
			sendSealed: () => { },
			onChunkOpened: chunk => {
				expect(chunk.openMs).toBeGreaterThanOrEqual(0);
				chunks.push({ ch: chunk.ch, bytes: chunk.bytes, more: chunk.more });
				throw new Error('a failing observer must not stop delivery');
			},
		});
		const mobileMux = new FrameMux(mobileChannel, { sendSealed: sealed => pcMux.receive(sealed) });
		const received: number[] = [];
		pcMux.on(Channels.Fs, f => received.push(f.payload.length));

		mobileMux.send(Channels.Fs, new Uint8Array(FRAME_CHUNK_BYTES + 1));

		expect({ chunks, received }).toEqual({
			chunks: [
				{ ch: 'fs', bytes: FRAME_CHUNK_BYTES, more: true },
				{ ch: 'fs', bytes: 1, more: false },
			],
			received: [FRAME_CHUNK_BYTES + 1],
		});
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

	test('reassembles interleaved v4 fragments by transfer id', () => {
		const { mobileChannel, pcChannel } = establish();
		const received: string[] = [];
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { }, onError: error => received.push(`error:${String(error)}`) });
		pcMux.on(Channels.Browser, f => received.push(`${f.seq}:${new TextDecoder().decode(f.payload)}`));
		const send = (frame: Frame) => pcMux.receive(mobileChannel.seal(encodeFrame(frame)));
		const bytes = (text: string) => new TextEncoder().encode(text);

		send({ ch: Channels.Browser, seq: 1, payload: bytes('jpeg-1|'), frag: { id: 10, index: 0, last: false } });
		send({ ch: Channels.Browser, seq: 2, payload: bytes('voice-1|'), frag: { id: 11, index: 0, last: false } });
		send({ ch: Channels.Browser, seq: 2, payload: bytes('voice-2'), frag: { id: 11, index: 1, last: true } });
		send({ ch: Channels.Browser, seq: 3, payload: bytes('small') });
		send({ ch: Channels.Browser, seq: 1, payload: bytes('jpeg-2'), frag: { id: 10, index: 1, last: true } });

		expect(received).toEqual(['2:voice-1|voice-2', '3:small', '1:jpeg-1|jpeg-2']);
	});

	test('drops a transfer whose fragments arrive out of order and reports it', () => {
		const { mobileChannel, pcChannel } = establish();
		const errors: unknown[] = [];
		const received: number[] = [];
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { }, onError: error => errors.push(error) });
		pcMux.on(Channels.Fs, f => received.push(f.payload.length));
		const send = (frame: Frame) => pcMux.receive(mobileChannel.seal(encodeFrame(frame)));

		send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(3), frag: { id: 1, index: 0, last: false } });
		send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(3), frag: { id: 1, index: 2, last: false } });
		// 捨てた送信の続きは黙って捨てる
		send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(3), frag: { id: 1, index: 3, last: true } });

		expect({ errors: errors.length, received }).toEqual({ errors: 1, received: [] });
	});

	test('stops assembling when the transfers in flight exceed the reassembly limit', () => {
		const { mobileChannel, pcChannel } = establish();
		const errors: unknown[] = [];
		const received: number[] = [];
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { }, onError: error => errors.push(error) });
		pcMux.on(Channels.Fs, f => received.push(f.payload.length));
		const send = (frame: Frame) => pcMux.receive(mobileChannel.seal(encodeFrame(frame)));

		send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(FRAME_REASSEMBLY_LIMIT / 2), frag: { id: 1, index: 0, last: false } });
		send({ ch: Channels.Fs, seq: 1, payload: new Uint8Array(FRAME_REASSEMBLY_LIMIT / 2 + 1), frag: { id: 2, index: 0, last: false } });
		send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(1), frag: { id: 1, index: 1, last: true } });

		expect({ errors: errors.length, received }).toEqual({ errors: 1, received: [FRAME_REASSEMBLY_LIMIT / 2 + 1] });
	});

	test('sends broken fragment sequences to onAssemblyError instead of onError (no reconnect)', () => {
		const { mobileChannel, pcChannel } = establish();
		const fatal: unknown[] = [];
		const assembly: string[] = [];
		const pcMux = new FrameMux(pcChannel, { sendSealed: () => { }, onError: error => fatal.push(error), onAssemblyError: error => assembly.push(error.message) });
		const send = (frame: Frame) => pcMux.receive(mobileChannel.seal(encodeFrame(frame)));
		send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(3), frag: { id: 1, index: 0, last: false } });
		send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(3), frag: { id: 1, index: 5, last: true } });

		expect({ fatal: fatal.length, assembly }).toEqual({ fatal: 0, assembly: ['frame fragment out of order on transfer 1'] });
	});
});

describe('FrameAssembler', () => {
	const fragment = (id: number, index: number, last: boolean, text: string): Frame => ({ ch: Channels.Fs, seq: 0, payload: new TextEncoder().encode(text), frag: { id, index, last } });
	const text = (result: Frame | Error | undefined) => result === undefined ? undefined : result instanceof Error ? 'error' : new TextDecoder().decode(result.payload);

	test('drops the oldest of 33 concurrent transfers, reports it, and keeps assembling the new one like the PC (F5)', () => {
		const assembler = new FrameAssembler();
		const starts = Array.from({ length: 33 }, (_, id) => assembler.push(fragment(id, 0, false, `s${id}`)));
		const overflow = starts.at(-1);
		expect({
			firstStarts: starts.slice(0, 32).every(result => result === undefined),
			overflow: overflow instanceof Error ? overflow.message : overflow,
			newest: text(assembler.push(fragment(32, 1, true, '-end'))),
			oldest: text(assembler.push(fragment(0, 1, true, '-end'))),
		}).toEqual({ firstStarts: true, overflow: 'too many concurrent frame transfers', newest: 's32-end', oldest: undefined });
	});

	test('checks the reassembly limit even for the transfer that evicted the oldest one', () => {
		const assembler = new FrameAssembler();
		for (let id = 0; id < 32; id++) {
			assembler.push({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(FRAME_REASSEMBLY_LIMIT / 32), frag: { id, index: 0, last: false } });
		}
		const result = assembler.push({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(FRAME_REASSEMBLY_LIMIT / 32 + 1), frag: { id: 99, index: 0, last: false } });
		expect({ error: result instanceof Error ? result.message : result, pending: assembler.pendingBytes }).toEqual({ error: 'frame reassembly limit exceeded on transfer 99', pending: FRAME_REASSEMBLY_LIMIT - FRAME_REASSEMBLY_LIMIT / 32 });
	});
});
