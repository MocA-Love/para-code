/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SecureChannel } from '../../common/paradisMobileCrypto.js';
import { FrameMux, IParadisMobileFrameTrafficSample, ParadisMobileFrameAssembler } from '../../common/paradisMobileMux.js';
import { Channels, decodeFrame, encodeFrame, Frame } from '../../common/paradisMobileProtocol.js';
import { ParadisMobileSendQueue } from '../../common/paradisMobileSendQueue.js';

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
	return globalThis.crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function establishChannels(): Promise<{ readonly sender: SecureChannel; readonly receiver: SecureChannel }> {
	const senderKey = await importAesKey(new Uint8Array(32).fill(1));
	const receiverKey = await importAesKey(new Uint8Array(32).fill(2));
	return {
		sender: new SecureChannel(senderKey, receiverKey),
		receiver: new SecureChannel(receiverKey, senderKey),
	};
}

suite('ParadisMobileMux traffic', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports sealed frame sizes without changing the delivered payload', async () => {
		const channels = await establishChannels();
		const sent: IParadisMobileFrameTrafficSample[] = [];
		const received: IParadisMobileFrameTrafficSample[] = [];
		const delivered: Uint8Array[] = [];
		let receive = Promise.resolve();
		const receiverOptions = {
			sendSealed: () => { },
			onTraffic: (sample: IParadisMobileFrameTrafficSample) => received.push(sample),
		};
		const receiver = new FrameMux(channels.receiver, receiverOptions);
		receiver.on(Channels.State, frame => delivered.push(frame.payload));
		const senderOptions = {
			sendSealed: (sealed: Uint8Array) => {
				receive = receiver.receive(sealed);
			},
			onTraffic: (sample: IParadisMobileFrameTrafficSample) => sent.push(sample),
		};
		const sender = new FrameMux(channels.sender, senderOptions);

		await sender.send(Channels.State, new Uint8Array([1, 2, 3]));
		await receive;

		assert.deepStrictEqual(delivered, [new Uint8Array([1, 2, 3])]);
		assert.deepStrictEqual(sent, [{ direction: 'sent', channel: Channels.State, payloadBytes: 3, sealedBytes: 39, more: false }]);
		assert.deepStrictEqual(received, [{ direction: 'received', channel: Channels.State, payloadBytes: 3, sealedBytes: 39, more: false }]);
	});

	test('reports every encrypted chunk while delivering one reassembled message', async () => {
		const channels = await establishChannels();
		const sent: IParadisMobileFrameTrafficSample[] = [];
		const received: IParadisMobileFrameTrafficSample[] = [];
		const delivered: Uint8Array[] = [];
		const payload = new Uint8Array(2 * 16 * 1024 + 1);
		payload[0] = 11;
		payload[payload.length - 1] = 22;
		let receive = Promise.resolve();
		const receiver = new FrameMux(channels.receiver, {
			sendSealed: () => { },
			onTraffic: sample => received.push(sample),
		});
		receiver.on(Channels.Browser, frame => delivered.push(frame.payload));
		const sender = new FrameMux(channels.sender, {
			sendSealed: sealed => { receive = receive.then(() => receiver.receive(sealed)); },
			onTraffic: sample => sent.push(sample),
		});

		await sender.send(Channels.Browser, payload);
		await receive;

		assert.deepStrictEqual(delivered, [payload]);
		assert.deepStrictEqual(sent.map(sample => sample.more), [true, true, false]);
		assert.deepStrictEqual(received.map(sample => sample.more), [true, true, false]);
		assert.strictEqual(sent.reduce((total, sample) => total + sample.payloadBytes, 0), payload.length);
		assert.strictEqual(received.reduce((total, sample) => total + sample.payloadBytes, 0), payload.length);
		// 断片の見出し 8 バイト＋フレームの見出し 8 バイト＋封緘 28 バイト
		assert.deepStrictEqual(sent.map(sample => sample.sealedBytes), [16 * 1024 + 44, 16 * 1024 + 44, 45]);
		assert.deepStrictEqual(received, sent.map(sample => ({ ...sample, direction: 'received' as const })));
	});

	test('keeps transport delivery independent from traffic observer failures', async () => {
		const channels = await establishChannels();
		const delivered: number[][] = [];
		let receive = Promise.resolve();
		const receiverOptions = {
			sendSealed: () => { },
			onTraffic: () => { throw new Error('receiver diagnostics failed'); },
		};
		const receiver = new FrameMux(channels.receiver, receiverOptions);
		receiver.on(Channels.Terminal, frame => delivered.push([...frame.payload]));
		const senderOptions = {
			sendSealed: (sealed: Uint8Array) => {
				receive = receiver.receive(sealed);
			},
			onTraffic: () => { throw new Error('sender diagnostics failed'); },
		};
		const sender = new FrameMux(channels.sender, senderOptions);

		await assert.doesNotReject(async () => {
			await sender.send(Channels.Terminal, new Uint8Array([7, 8, 9]));
			await receive;
		});
		assert.deepStrictEqual(delivered, [[7, 8, 9]]);
	});
});

function magicPayload(magic: readonly number[], size: number): Uint8Array {
	const payload = new Uint8Array(size);
	payload.set(magic);
	return payload;
}

const JPEG_MAGIC = [0x50, 0x4a, 0x46, 0x01];
const VOICE_MAGIC = [0x50, 0x56, 0x53, 0x01];

suite('ParadisMobileMux version 4', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends voice fragments ahead of the remaining screen JPEG fragments and keeps the nonce order equal to the send order', async () => {
		const channels = await establishChannels();
		const delivered: string[] = [];
		const wire: string[] = [];
		let receive = Promise.resolve();
		const receiver = new FrameMux(channels.receiver, { sendSealed: () => { } });
		receiver.on(Channels.Browser, frame => delivered.push(`${String.fromCharCode(frame.payload[1])}:${frame.payload.length}`));
		receiver.on(Channels.State, frame => delivered.push(`state:${frame.payload.length}`));
		const sender = new FrameMux(channels.sender, {
			sendSealed: sealed => {
				// 受け手はカウンタ nonce を厳密に検査する。送った順に開けなければ例外になる
				receive = receive.then(() => receiver.receive(sealed));
			},
			onTraffic: sample => wire.push(`${sample.channel}:${sample.payloadBytes}`),
		});

		await Promise.all([
			sender.send(Channels.Browser, magicPayload(JPEG_MAGIC, 3 * 16 * 1024)),
			sender.send(Channels.State, new Uint8Array(20 * 1024)),
			sender.send(Channels.Browser, magicPayload(VOICE_MAGIC, 100)),
		]);
		await receive;

		assert.deepStrictEqual({ wire, delivered }, {
			// JPEG の 1 つ目は既に封緘中。その次は音声、操作・状態、最後に JPEG の残り
			wire: ['browser:16384', 'browser:100', 'state:16384', 'state:4096', 'browser:16384', 'browser:16384'],
			delivered: ['V:100', 'state:20480', 'J:49152'],
		});
	});

	test('replaces a queued screen JPEG that has not started with the newer one', async () => {
		const channels = await establishChannels();
		const queue = new ParadisMobileSendQueue();
		const delivered: number[] = [];
		let receive = Promise.resolve();
		const receiver = new FrameMux(channels.receiver, { sendSealed: () => { } });
		receiver.on(Channels.Browser, frame => delivered.push(frame.payload.length));
		const sender = new FrameMux(channels.sender, { sendSealed: sealed => { receive = receive.then(() => receiver.receive(sealed)); }, sendQueue: queue });

		await Promise.all([
			sender.send(Channels.State, new Uint8Array(40 * 1024)),
			sender.send(Channels.Browser, magicPayload(JPEG_MAGIC, 1000)),
			sender.send(Channels.Browser, magicPayload(JPEG_MAGIC, 2000)),
			sender.send(Channels.Browser, magicPayload(JPEG_MAGIC, 3000)),
		]);
		await receive;

		assert.deepStrictEqual(delivered, [3000]);
	});

	test('waits while the relay socket buffer is above 32 KiB and drops the queue of a disposed mux', async () => {
		const channels = await establishChannels();
		let buffered = 40 * 1024;
		const timers: (() => void)[] = [];
		const queue = new ParadisMobileSendQueue({ bufferedAmount: () => buffered, setTimeout: handler => { timers.push(handler); } });
		const sent: number[] = [];
		const sender = new FrameMux(channels.sender, { sendSealed: sealed => sent.push(sealed.length), sendQueue: queue });
		const other = new FrameMux(channels.receiver, { sendSealed: sealed => sent.push(-sealed.length), sendQueue: queue });

		const first = sender.send(Channels.Terminal, new Uint8Array(10));
		const dropped = other.send(Channels.Terminal, new Uint8Array(20));
		await Promise.resolve();
		assert.deepStrictEqual({ sent, waiting: timers.length, congestion: queue.congestionBytes() }, { sent: [], waiting: 1, congestion: 40 * 1024 });

		other.dispose();
		buffered = 0;
		timers.shift()!();
		await first;
		await dropped;
		assert.deepStrictEqual({ sent, congestion: queue.congestionBytes() }, { sent: [10 + 8 + 28], congestion: 0 });
	});
});

suite('ParadisMobileMux assembly errors', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports a broken fragment sequence separately from decryption failures', async () => {
		const channels = await establishChannels();
		const cryptoErrors: unknown[] = [];
		const assemblyErrors: string[] = [];
		const delivered: number[] = [];
		const receiver = new FrameMux(channels.receiver, { sendSealed: () => { }, onError: error => cryptoErrors.push(error), onAssemblyError: error => assemblyErrors.push(error.message) });
		receiver.on(Channels.Fs, frame => delivered.push(frame.payload.length));
		const send = async (frame: Frame) => receiver.receive(await channels.sender.seal(encodeFrame(frame)));

		await send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(2), frag: { id: 7, index: 0, last: false } });
		await send({ ch: Channels.Fs, seq: 0, payload: new Uint8Array(2), frag: { id: 7, index: 2, last: true } });
		await send({ ch: Channels.Fs, seq: 1, payload: new Uint8Array(3) });

		assert.deepStrictEqual({ cryptoErrors: cryptoErrors.length, assemblyErrors, delivered }, {
			cryptoErrors: 0,
			assemblyErrors: ['frame fragment out of order on transfer 7'],
			delivered: [3],
		});
	});
});

suite('ParadisMobileFrameAssembler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const fragment = (id: number, index: number, last: boolean, text: string, seq = 0): Frame => ({ ch: Channels.Fs, seq, payload: new TextEncoder().encode(text), frag: { id, index, last } });
	const text = (result: Frame | Error | undefined) => result === undefined ? undefined : result instanceof Error ? 'error' : new TextDecoder().decode(result.payload);

	test('reassembles interleaved transfers by id and still accepts legacy chunks', () => {
		const assembler = new ParadisMobileFrameAssembler();
		const results = [
			assembler.push(fragment(1, 0, false, 'a1')),
			assembler.push(fragment(2, 0, false, 'b1')),
			assembler.push(fragment(1, 1, true, 'a2')),
			assembler.push({ ch: Channels.State, seq: 0, payload: new Uint8Array([1]), more: true }),
			assembler.push(fragment(2, 1, true, 'b2')),
			assembler.push({ ch: Channels.State, seq: 1, payload: new Uint8Array([2]) }),
		].map(text);

		assert.deepStrictEqual({ results, pending: assembler.pendingBytes }, { results: [undefined, undefined, 'a1a2', undefined, 'b1b2', '\u0001\u0002'], pending: 0 });
	});

	test('drops a transfer on a gap and ignores the rest of it', () => {
		const assembler = new ParadisMobileFrameAssembler();
		const results = [
			assembler.push(fragment(1, 0, false, 'a1')),
			assembler.push(fragment(1, 2, false, 'a3')),
			assembler.push(fragment(1, 3, true, 'a4')),
		].map(text);

		assert.deepStrictEqual({ results, pending: assembler.pendingBytes }, { results: [undefined, 'error', undefined], pending: 0 });
	});

	test('drops the oldest of 33 concurrent transfers, reports it, and keeps assembling the new one like the app (F5)', () => {
		const assembler = new ParadisMobileFrameAssembler();
		const starts = Array.from({ length: 33 }, (_, id) => assembler.push(fragment(id, 0, false, `s${id}`)));
		const overflow = starts.at(-1);
		const results = {
			firstStarts: starts.slice(0, 32).every(result => result === undefined),
			overflow: overflow instanceof Error ? overflow.message : overflow,
			newest: text(assembler.push(fragment(32, 1, true, '-end'))),
			oldest: text(assembler.push(fragment(0, 1, true, '-end'))),
		};
		assert.deepStrictEqual(results, { firstStarts: true, overflow: 'too many concurrent frame transfers', newest: 's32-end', oldest: undefined });
	});

	test('decodes the fragment header written after the workspace', () => {
		const frame = decodeFrame(new Uint8Array([0x04, 0x05, 0, 0, 0, 9, 0, 1, 0x77, 0, 0, 0, 3, 0, 0, 0, 1, 0xab]));
		assert.deepStrictEqual({ ch: frame.ch, ws: frame.ws, seq: frame.seq, frag: frame.frag, payload: [...frame.payload] }, { ch: 'fs', ws: 'w', seq: 9, frag: { id: 3, index: 1, last: false }, payload: [0xab] });
	});
});
