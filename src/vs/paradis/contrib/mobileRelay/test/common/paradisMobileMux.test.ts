/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SecureChannel } from '../../common/paradisMobileCrypto.js';
import { FrameMux, IParadisMobileFrameTrafficSample } from '../../common/paradisMobileMux.js';
import { Channels } from '../../common/paradisMobileProtocol.js';

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
		const payload = new Uint8Array(700 * 1024 + 1);
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
		assert.deepStrictEqual(sent.map(sample => sample.more), [true, false]);
		assert.deepStrictEqual(received.map(sample => sample.more), [true, false]);
		assert.strictEqual(sent.reduce((total, sample) => total + sample.payloadBytes, 0), payload.length);
		assert.strictEqual(received.reduce((total, sample) => total + sample.payloadBytes, 0), payload.length);
		assert.deepStrictEqual(sent.map(sample => sample.sealedBytes), [700 * 1024 + 36, 37]);
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
