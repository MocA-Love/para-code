/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	createInitiator as createAppInitiator,
	generateIdentity as generateAppIdentity,
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

	test('app mux sends exactly 700 KiB as one frame and 700 KiB plus one byte as two frames to the PC mux', async () => {
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

		const exactBoundary = new Uint8Array(700 * 1024).fill(0x5a);
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
		const aboveBoundary = new Uint8Array(700 * 1024 + 1).fill(0xa5);
		appMux.send(AppChannels.Fs, aboveBoundary, 'workspace-plus-one');
		await Promise.all(pcReceives);

		expect(appFrameCount).toBe(2);
		expect(pcReceived).toHaveLength(2);
		expect(pcReceived[1]).toEqual({
			seq: 2,
			ws: 'workspace-plus-one',
			payload: aboveBoundary,
		});
	});

	test('PC mux sends exactly 700 KiB as one frame and 700 KiB plus one byte as two frames to the app mux', async () => {
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

		const exactBoundary = new Uint8Array(700 * 1024).fill(0x3c);
		await pcMux.send(PcChannels.Browser, exactBoundary, 'workspace-exact');

		expect(pcFrameCount).toBe(1);
		expect(appReceived).toHaveLength(1);
		expect(appReceived[0]).toEqual({
			seq: 0,
			ws: 'workspace-exact',
			payload: exactBoundary,
		});

		pcFrameCount = 0;
		const aboveBoundary = new Uint8Array(700 * 1024 + 1).fill(0xc3);
		await pcMux.send(PcChannels.Browser, aboveBoundary, 'workspace-plus-one');

		expect(pcFrameCount).toBe(2);
		expect(appReceived).toHaveLength(2);
		expect(appReceived[1]).toEqual({
			seq: 2,
			ws: 'workspace-plus-one',
			payload: aboveBoundary,
		});
	});
});
