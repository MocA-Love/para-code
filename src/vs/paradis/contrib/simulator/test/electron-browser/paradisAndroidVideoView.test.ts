/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android の映像（scrcpy の H.264 を WebCodecs で復号する部品）。偽の復号器で、key frame を待つこと・config を
// 前に付けること・追いつかないときに捨てること・復号できないときに繰り返さず知らせること・放すことを確かめる。

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAndroidVideoWire } from '../../common/paradisScrcpy.js';
import { IParadisVideoDecoders, ParadisAndroidVideoView } from '../../electron-browser/paradisAndroidVideoView.js';
import { IParadisSimulatorClient } from '../../electron-browser/paradisSimulatorClient.js';

const SERIAL = 'emulator-5554';
const SPS = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28];

class FakeDecoder {
	state: CodecState = 'unconfigured';
	decodeQueueSize = 0;
	readonly chunks: { type: string; bytes: number[] }[] = [];
	constructor(readonly init: VideoDecoderInit, private readonly _log: string[]) { }
	configure(config: VideoDecoderConfig): void {
		this.state = 'configured';
		this._log.push(`configure ${config.codec}`);
	}
	decode(chunk: EncodedVideoChunk): void {
		const bytes = new Uint8Array(chunk.byteLength);
		chunk.copyTo(bytes);
		this.chunks.push({ type: chunk.type, bytes: [...bytes] });
	}
	close(): void {
		this.state = 'closed';
		this._log.push('close');
	}
}

suite('Paradis simulator: Android video view', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(supported = true) {
		const video = store.add(new Emitter<ParadisAndroidVideoWire>());
		let listeners = 0;
		const event = (listener: (message: ParadisAndroidVideoWire) => void) => {
			listeners++;
			const subscription = video.event(listener);
			return { dispose: () => { listeners--; subscription.dispose(); } };
		};
		const resets: string[] = [];
		const client = { onAndroidVideo: () => event, androidResetVideo: async () => { resets.push('reset'); }, androidInput: async () => { } } as unknown as IParadisSimulatorClient;
		const log: string[] = [];
		const decoders: FakeDecoder[] = [];
		const factory: IParadisVideoDecoders = {
			create: init => {
				const decoder = new FakeDecoder(init, log);
				decoders.push(decoder);
				return decoder as unknown as VideoDecoder;
			},
			isSupported: async () => supported,
		};
		const view = store.add(new ParadisAndroidVideoView(document.createElement('div'), SERIAL, client, factory));
		const send = (message: { readonly kind: ParadisAndroidVideoWire['kind'];[field: string]: unknown }) => video.fire({ serial: SERIAL, ...message } as unknown as ParadisAndroidVideoWire);
		const settle = () => new Promise(resolve => setTimeout(resolve, 0));
		return { view, send, settle, log, decoders, resets, listeners: () => listeners };
	}

	test('waits for a key frame, puts the config in front of it, and releases everything when closed', async () => {
		const { view, send, settle, log, decoders, listeners } = setup();
		view.start();
		send({ kind: 'size', width: 1080, height: 2400 });
		send({ kind: 'config', data: VSBuffer.wrap(new Uint8Array(SPS)) });
		send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x41])), key: false, pts: 1 });
		await settle();
		send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x65])), key: true, pts: 2 });
		await settle();
		send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x41])), key: false, pts: 3 });
		await settle();
		const whileWatching = { listeners: listeners(), open: view.decoderOpen };
		view.dispose();
		assert.deepStrictEqual({ chunks: decoders[0].chunks, log, whileWatching, after: { listeners: listeners(), open: view.decoderOpen } }, {
			chunks: [
				{ type: 'key', bytes: [...SPS, 0, 0, 0, 1, 0x65] },
				{ type: 'delta', bytes: [0, 0, 0, 1, 0x41] },
			],
			log: ['configure avc1.640028', 'close'],
			whileWatching: { listeners: 1, open: true },
			after: { listeners: 0, open: false },
		});
	});

	test('drops frames and asks for a key frame when decoding falls behind', async () => {
		const { view, send, settle, decoders, resets } = setup();
		view.start();
		send({ kind: 'config', data: VSBuffer.wrap(new Uint8Array(SPS)) });
		send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x65])), key: true, pts: 1 });
		await settle();
		decoders[0].decodeQueueSize = 20;
		send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x41])), key: false, pts: 2 });
		await settle();
		decoders[0].decodeQueueSize = 0;
		send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x41])), key: false, pts: 3 });
		await settle();
		view.stop();
		assert.deepStrictEqual({ decoded: decoders[0].chunks.map(chunk => chunk.type), resets }, { decoded: ['key'], resets: ['reset'] });
	});

	// 復号できない codec なら、繰り返し key frame を求めずに 1 回だけ知らせて止める
	test('gives up once when the codec cannot be decoded, and after repeated decode errors', async () => {
		const unsupported = setup(false);
		const reasons: string[] = [];
		store.add(unsupported.view.onDidGiveUp(reason => reasons.push(reason)));
		unsupported.view.start();
		unsupported.send({ kind: 'config', data: VSBuffer.wrap(new Uint8Array(SPS)) });
		for (let pts = 1; pts <= 3; pts++) {
			unsupported.send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x65])), key: true, pts });
			await unsupported.settle();
		}
		const failing = setup();
		const failingReasons: string[] = [];
		store.add(failing.view.onDidGiveUp(reason => failingReasons.push(reason)));
		failing.view.start();
		failing.send({ kind: 'config', data: VSBuffer.wrap(new Uint8Array(SPS)) });
		for (let pts = 1; pts <= 5; pts++) {
			failing.send({ kind: 'frame', data: VSBuffer.wrap(new Uint8Array([0, 0, 0, 1, 0x65])), key: true, pts });
			await failing.settle();
			failing.decoders[failing.decoders.length - 1]?.init.error(new DOMException('broken'));
		}
		assert.deepStrictEqual({
			unsupported: { reasons: reasons.length, decoders: unsupported.decoders.length, resets: unsupported.resets.length, listening: unsupported.listeners() },
			failing: { reasons: failingReasons.length, decoders: failing.decoders.length, resets: failing.resets.length, listening: failing.listeners() },
		}, {
			unsupported: { reasons: 1, decoders: 0, resets: 0, listening: 0 },
			failing: { reasons: 1, decoders: 3, resets: 2, listening: 0 },
		});
	});
});
