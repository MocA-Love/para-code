/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	createInitiator as createAppInitiator,
	generateIdentity as generateAppIdentity,
	respondHandshake as respondAppHandshake,
} from '../src/crypto.js';
import {
	Channels as AppChannels,
	decodeFrame as decodeAppFrame,
	encodeFrame as encodeAppFrame,
} from '../src/frames.js';
import {
	FrameMux as AppFrameMux,
} from '../src/mux.js';
import {
	generateMobileIdentity as generatePcIdentity,
	respondHandshake as respondPcHandshake,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileCrypto.js';
import {
	FrameMux as PcFrameMux,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileMux.js';
import {
	Channels as PcChannels,
	decodeFrame as decodePcFrame,
	encodeFrame as encodePcFrame,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileProtocol.js';

const encoder = new TextEncoder();

function establishSync() {
	const mobile = generateAppIdentity();
	const pc = generateAppIdentity();
	const initiator = createAppInitiator(mobile, pc.publicKey);
	const responder = respondAppHandshake(pc, mobile.publicKey, initiator.hello);
	const { channel: mobileChannel, confirm } = initiator.finish(responder.response);
	responder.verifyConfirm(confirm);
	return { mobileChannel, pcChannel: responder.channel };
}
const decoder = new TextDecoder();

async function establishAppInitiatorWithPcResponder() {
	const appIdentity = generateAppIdentity();
	const pcIdentity = await generatePcIdentity();
	const appHandshake = createAppInitiator(appIdentity, pcIdentity.publicKey);
	const pcHandshake = await respondPcHandshake(pcIdentity, appIdentity.publicKey, appHandshake.hello);
	const appEstablished = appHandshake.finish(pcHandshake.response);
	await pcHandshake.verifyConfirm(appEstablished.confirm);
	return {
		appChannel: appEstablished.channel,
		pcChannel: pcHandshake.channel,
	};
}

describe('app/protocol <-> PC production contract', () => {
	test('both frame codecs preserve the literal channel, flags, sequence, workspace, and payload bytes', () => {
		const fixture = {
			ch: AppChannels.Agent,
			ws: 'β',
			seq: 0x01020304,
			payload: new Uint8Array([0x00, 0xff, 0x11]),
			more: true,
		} as const;
		// ch=agent(7), flags=workspace|more(3), seq=0x01020304 BE,
		// UTF-8 workspace length=2, "β"=ce b2, then the binary payload.
		const wire = new Uint8Array([
			0x07, 0x03, 0x01, 0x02, 0x03, 0x04, 0x00, 0x02,
			0xce, 0xb2, 0x00, 0xff, 0x11,
		]);

		expect(encodeAppFrame(fixture)).toEqual(wire);
		expect(encodePcFrame({ ...fixture, ch: PcChannels.Agent })).toEqual(wire);

		for (const decoded of [decodeAppFrame(wire), decodePcFrame(wire)]) {
			expect(decoded.ch).toBe('agent');
			expect(decoded.ws).toBe('β');
			expect(decoded.seq).toBe(0x01020304);
			expect(decoded.more).toBe(true);
			expect(decoded.payload).toEqual(new Uint8Array([0x00, 0xff, 0x11]));
		}
	});

	test('an app initiator and the PC production responder exchange authenticated payloads in both directions', async () => {
		const { appChannel, pcChannel } = await establishAppInitiatorWithPcResponder();

		const appToPc = appChannel.seal(encoder.encode('mobile → PC: 日本語'));
		expect(decoder.decode(await pcChannel.open(appToPc))).toBe('mobile → PC: 日本語');

		const pcToApp = await pcChannel.seal(encoder.encode('PC → mobile: reply'));
		expect(decoder.decode(appChannel.open(pcToApp))).toBe('PC → mobile: reply');
	});

	test('both frame codecs write the same v4 fragment header after the workspace', () => {
		const fixture = {
			ch: AppChannels.Browser,
			ws: 'w',
			seq: 7,
			payload: new Uint8Array([0xaa, 0xbb]),
			frag: { id: 0x01020304, index: 2, last: true },
		} as const;
		// ch=browser(5), flags=workspace|fragment|last(0x0d), seq=7, wsLen=1, "w",
		// transferId=0x01020304, index=2, then the payload.
		const wire = new Uint8Array([
			0x05, 0x0d, 0x00, 0x00, 0x00, 0x07, 0x00, 0x01, 0x77,
			0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x02,
			0xaa, 0xbb,
		]);

		expect(encodeAppFrame(fixture)).toEqual(wire);
		expect(encodePcFrame({ ...fixture, ch: PcChannels.Browser })).toEqual(wire);
		for (const decoded of [decodeAppFrame(wire), decodePcFrame(wire)]) {
			expect({ ch: decoded.ch, ws: decoded.ws, seq: decoded.seq, frag: decoded.frag, payload: decoded.payload }).toEqual({
				ch: 'browser', ws: 'w', seq: 7, frag: { id: 0x01020304, index: 2, last: true }, payload: new Uint8Array([0xaa, 0xbb]),
			});
		}
	});

	test('app mux sends exactly 16 KiB as one frame and 16 KiB plus one byte as two fragments to the PC mux', async () => {
		const { appChannel, pcChannel } = await establishAppInitiatorWithPcResponder();
		const pcReceived: Array<{ seq: number; ws: string | undefined; payload: Uint8Array }> = [];
		const pcReceives: Promise<void>[] = [];
		const pcMux = new PcFrameMux(pcChannel, { sendSealed: () => { } });
		pcMux.on(PcChannels.Fs, frame => {
			pcReceived.push({ seq: frame.seq, ws: frame.ws, payload: frame.payload });
		});
		let appFrameCount = 0;
		const appMux = new AppFrameMux(appChannel, {
			sendSealed: sealed => {
				appFrameCount++;
				pcReceives.push(pcMux.receive(sealed));
			},
		});

		const exactBoundary = new Uint8Array(16 * 1024).fill(0x5a);
		appMux.send(AppChannels.Fs, exactBoundary, 'workspace-exact');
		await Promise.all(pcReceives);

		expect(appFrameCount).toBe(1);
		expect(pcReceived).toHaveLength(1);
		expect(pcReceived[0]).toEqual({
			seq: 0,
			ws: 'workspace-exact',
			payload: exactBoundary,
		});

		appFrameCount = 0;
		const aboveBoundary = new Uint8Array(16 * 1024 + 1).fill(0xa5);
		appMux.send(AppChannels.Fs, aboveBoundary, 'workspace-plus-one');
		await Promise.all(pcReceives);

		expect(appFrameCount).toBe(2);
		expect(pcReceived).toHaveLength(2);
		expect(pcReceived[1]).toEqual({
			seq: 1,
			ws: 'workspace-plus-one',
			payload: aboveBoundary,
		});
	});

	test('PC mux sends exactly 16 KiB as one frame and 16 KiB plus one byte as two fragments to the app mux', async () => {
		const { appChannel, pcChannel } = await establishAppInitiatorWithPcResponder();
		const appReceived: Array<{ seq: number; ws: string | undefined; payload: Uint8Array }> = [];
		const appMux = new AppFrameMux(appChannel, { sendSealed: () => { } });
		appMux.on(AppChannels.Browser, frame => {
			appReceived.push({ seq: frame.seq, ws: frame.ws, payload: frame.payload });
		});
		let pcFrameCount = 0;
		const pcMux = new PcFrameMux(pcChannel, {
			sendSealed: sealed => {
				pcFrameCount++;
				appMux.receive(sealed);
			},
		});

		const exactBoundary = new Uint8Array(16 * 1024).fill(0x3c);
		await pcMux.send(PcChannels.Browser, exactBoundary, 'workspace-exact');

		expect(pcFrameCount).toBe(1);
		expect(appReceived).toHaveLength(1);
		expect(appReceived[0]).toEqual({
			seq: 0,
			ws: 'workspace-exact',
			payload: exactBoundary,
		});

		pcFrameCount = 0;
		const aboveBoundary = new Uint8Array(16 * 1024 + 1).fill(0xc3);
		await pcMux.send(PcChannels.Browser, aboveBoundary, 'workspace-plus-one');

		expect(pcFrameCount).toBe(2);
		expect(appReceived).toHaveLength(2);
		expect(appReceived[1]).toEqual({
			seq: 1,
			ws: 'workspace-plus-one',
			payload: aboveBoundary,
		});
	});

	test('PC mux sends a voice chunk between the fragments of a screen JPEG and the app reassembles both in nonce order', async () => {
		const { appChannel, pcChannel } = await establishAppInitiatorWithPcResponder();
		const order: string[] = [];
		const appMux = new AppFrameMux(appChannel, { sendSealed: () => { }, onError: error => order.push(`error:${String(error)}`) });
		appMux.on(AppChannels.Browser, frame => {
			order.push(`${String.fromCharCode(frame.payload[0]!, frame.payload[1]!, frame.payload[2]!)}:${frame.payload.length}`);
		});
		const pcMux = new PcFrameMux(pcChannel, { sendSealed: sealed => appMux.receive(sealed) });

		const jpeg = new Uint8Array(64 * 1024);
		jpeg.set([0x50, 0x4a, 0x46, 0x01]);
		const voice = new Uint8Array(100);
		voice.set([0x50, 0x56, 0x53, 0x01]);
		// 待たずに続けて積む。JPEG の最初の断片の封緘中に音声が列に入り、次に送られる
		await Promise.all([pcMux.send(PcChannels.Browser, jpeg), pcMux.send(PcChannels.Browser, voice)]);

		expect(order).toEqual(['PVS:100', 'PJF:65536']);
	});

	test('the app mux still reassembles a legacy v3 chunked State from an old PC', () => {
		const { mobileChannel, pcChannel } = establishSync();
		const received: number[] = [];
		const appMux = new AppFrameMux(mobileChannel, { sendSealed: () => { } });
		appMux.on(AppChannels.State, frame => received.push(frame.payload.length));
		appMux.receive(pcChannel.seal(encodeAppFrame({ ch: AppChannels.State, seq: 0, payload: new Uint8Array(10), more: true })));
		appMux.receive(pcChannel.seal(encodeAppFrame({ ch: AppChannels.State, seq: 1, payload: new Uint8Array(5) })));

		expect(received).toEqual([15]);
	});
});
