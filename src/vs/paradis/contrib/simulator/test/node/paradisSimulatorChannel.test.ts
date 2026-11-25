/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 窓を閉じると、その窓の IPC の購読は shared process 側で外れる。最後の購読が外れたら映像の流れを閉じること。

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { BufferReader, BufferWriter, deserialize, serialize } from '../../../../../base/parts/ipc/common/ipc.js';
import { ParadisAndroidVideoTransport, ParadisAndroidVideoWire, ParadisScrcpyVideoEvent, paradisAndroidVideoFromTransport } from '../../common/paradisScrcpy.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisServeSimBackend, ParadisSimulatorCaptureNotStartedError } from '../../node/paradisServeSimBackend.js';
import { ParadisSimulatorChannel, ParadisSimulatorService } from '../../node/paradisSimulatorChannel.js';
import { ParadisSimulatorStreamEvent, ParadisSimulatorStreamWire, paradisSimulatorStreamFromWire } from '../../common/paradisSimulator.js';
import { IParadisSimulatorHostConnection } from '../../node/paradisSimulatorHostProcess.js';

const UDID = 'A1B2C3D4-0000-1111-2222-333344445555';

suite('Paradis simulator: video relay in the shared process', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the stream for the first subscriber and closes it when the last one goes away', () => {
		let open = 0;
		let emit: ((jpeg: Uint8Array) => void) | undefined;
		const backend = {
			subscribeFrames(_udid: string, onFrame: (jpeg: Uint8Array) => void): IDisposable {
				open++;
				emit = onFrame;
				return toDisposable(() => open--);
			},
		} as unknown as ParadisServeSimBackend;
		const host = { ensure: async (): Promise<IParadisSimulatorHostConnection> => ({ socketPath: '', token: '' }), isRunning: false, lastError: undefined, stop: async () => { } };
		const service = store.add(new ParadisSimulatorService(host, backend, true, new NullLogService()));
		const received: number[] = [];
		const first = service.onFrames(UDID)(message => received.push(message.kind === 'frame' ? message.jpeg.byteLength : -1));
		const second = service.onFrames(UDID)(() => { });
		emit?.(new Uint8Array(3));
		const whileOpen = open;
		first.dispose();
		const afterFirst = open;
		second.dispose();
		// macOS でない（iOS を使えない）ときは、購読しても流れを開かない
		const unsupportedService = store.add(new ParadisSimulatorService(host, backend, false, new NullLogService()));
		const unsupported = unsupportedService.onFrames(UDID)(() => { });
		unsupported.dispose();
		assert.deepStrictEqual({ whileOpen, afterFirst, afterLast: open, received, openedWhileUnsupported: open }, { whileOpen: 1, afterFirst: 1, afterLast: 0, received: [3], openedWhileUnsupported: 0 });
	});

	// ホストが起きない・serve-sim が断ったときは、ログだけでなく購読している窓へ理由を送る（ペインが黒いまま黙らない）。
	// 次の購読では流れを開き直す
	test('tells the subscribers why the stream ended and reopens it for the next subscriber', async () => {
		let opened = 0;
		let end: ((error?: Error) => void) | undefined;
		const backend = {
			subscribeFrames(_udid: string, _onFrame: (jpeg: Uint8Array) => void, onEnd: (error?: Error) => void): IDisposable {
				opened++;
				end = onEnd;
				return toDisposable(() => { });
			},
		} as unknown as ParadisServeSimBackend;
		const host = { ensure: async (): Promise<IParadisSimulatorHostConnection> => ({ socketPath: '', token: '' }), isRunning: false, lastError: undefined, stop: async () => { } };
		const service = store.add(new ParadisSimulatorService(host, backend, true, new NullLogService()));
		const received: ParadisSimulatorStreamEvent[] = [];
		const first = service.onFrames(UDID)(message => received.push(message));
		end?.(new Error('The simulator host did not become ready in time'));
		first.dispose();
		const second = service.onFrames(UDID)(message => received.push(message));
		end?.();
		second.dispose();
		// 映像の要求に応答の頭が返らなかった（取り込みが始まらない）ときは、その印を付けて送る
		const third = service.onFrames(UDID)(message => received.push(message));
		end?.(new ParadisSimulatorCaptureNotStartedError(UDID, 15_000));
		third.dispose();
		assert.deepStrictEqual({ opened, received }, {
			opened: 3,
			received: [
				{ kind: 'ended', udid: UDID, reason: 'The simulator host did not become ready in time' },
				{ kind: 'ended', udid: UDID },
				{ kind: 'ended', udid: UDID, reason: `The simulator host did not start capturing ${UDID} within 15 s`, captureNotStarted: true },
			],
		});
	});

	// Android の映像（⑥b）: 最初の購読で scrcpy の通話を使い始め、今の大きさと config を先に渡し、最後の購読が外れたら手放す
	test('relays Android video from the scrcpy session and releases it when the last window stops watching', async () => {
		const video = store.add(new Emitter<ParadisScrcpyVideoEvent>());
		const ended = store.add(new Emitter<Error | undefined>());
		let leases = 0;
		const resets: string[] = [];
		const session = { size: { width: 1080, height: 2400 }, config: new Uint8Array([7]), onVideo: video.event, onDidEnd: ended.event, resetVideo: async () => { resets.push('reset'); } };
		const scrcpy = {
			acquire: async () => {
				leases++;
				return { session: session as never, lease: { dispose: () => leases-- } };
			},
			use: async () => { throw new Error('not used'); },
		};
		const host = { ensure: async (): Promise<IParadisSimulatorHostConnection> => ({ socketPath: '', token: '' }), isRunning: false, lastError: undefined, stop: async () => { } };
		const service = store.add(new ParadisSimulatorService(host, {} as ParadisServeSimBackend, true, new NullLogService(), undefined, { adb: { bootAvd: async () => { }, listDevices: async () => [] }, scrcpy }));
		const received: string[] = [];
		const describe = (message: ParadisAndroidVideoWire) => message.kind === 'size' ? `size ${message.width}x${message.height}` : message.kind === 'config' ? `config ${message.data.byteLength}` : message.kind === 'frame' ? `frame ${message.key}` : 'ended';
		const listener = service.onAndroidVideo('emulator-5554')(message => received.push(describe(message)));
		await new Promise(resolve => setTimeout(resolve, 0));
		video.fire({ kind: 'frame', data: new Uint8Array([1]), key: true, pts: 1 });
		const whileWatching = leases;
		listener.dispose();
		const refused: string[] = [];
		service.onAndroidVideo('-bad')(() => refused.push('x')).dispose();
		assert.deepStrictEqual({ received, resets, whileWatching, afterLast: leases, refused }, {
			received: ['size 1080x2400', 'config 1', 'frame true'],
			resets: ['reset'],
			whileWatching: 1,
			afterLast: 0,
			refused: [],
		});
	});

	// チャネルが出すイベントを、本物の IPC の直列化（serialize → deserialize）に通す。オブジェクトの中に VSBuffer を
	// 入れて送ると JSON になり、窓の側で VSBuffer に戻らない（paracode-183〜194 で、iOS も Android もペインに映像が
	// 1 枚も描かれなかった。これまでのテストは service を直接購読していて、直列化を通っていなかった）
	test('sends frames through the IPC serialization so that the window gets the bytes back', async () => {
		const overWire = <T>(value: unknown): T => {
			const writer = new BufferWriter();
			serialize(writer, value);
			return deserialize(new BufferReader(writer.buffer)) as T;
		};
		const bytes = (buffer: VSBuffer) => buffer instanceof VSBuffer ? [...buffer.buffer] : 'not a VSBuffer';
		let emit: ((jpeg: Uint8Array) => void) | undefined;
		let end: ((error?: Error) => void) | undefined;
		const backend = {
			subscribeFrames(_udid: string, onFrame: (jpeg: Uint8Array) => void, onEnd: (error?: Error) => void): IDisposable {
				emit = onFrame;
				end = onEnd;
				return toDisposable(() => { });
			},
		} as unknown as ParadisServeSimBackend;
		const video = store.add(new Emitter<ParadisScrcpyVideoEvent>());
		const session = { size: { width: 720, height: 1600 }, config: new Uint8Array([7, 8]), onVideo: video.event, onDidEnd: store.add(new Emitter<Error | undefined>()).event, resetVideo: async () => { } };
		const scrcpy = { acquire: async () => ({ session: session as never, lease: { dispose: () => { } } }), use: async () => { throw new Error('not used'); } };
		const host = { ensure: async (): Promise<IParadisSimulatorHostConnection> => ({ socketPath: '', token: '' }), isRunning: false, lastError: undefined, stop: async () => { } };
		const service = store.add(new ParadisSimulatorService(host, backend, true, new NullLogService(), undefined, { adb: { bootAvd: async () => { }, listDevices: async () => [] }, scrcpy }));
		const channel = new ParadisSimulatorChannel<string>(service);

		const ios: unknown[] = [];
		const frames = channel.listen<ParadisSimulatorStreamWire>('window', 'frames', { udid: UDID })(wire => {
			const event = paradisSimulatorStreamFromWire(overWire<ParadisSimulatorStreamWire>(wire));
			ios.push(event.kind === 'frame' ? { kind: event.kind, udid: event.udid, jpeg: bytes(event.jpeg) } : event);
		});
		emit?.(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
		end?.(new Error('gone'));
		frames.dispose();

		const android: unknown[] = [];
		const androidVideo = channel.listen<ParadisAndroidVideoTransport>('window', 'androidVideo', { serial: 'emulator-5554' })(transport => {
			const message = paradisAndroidVideoFromTransport(overWire<ParadisAndroidVideoTransport>(transport));
			android.push(message.kind === 'config' || message.kind === 'frame' ? { ...message, data: bytes(message.data) } : message);
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		video.fire({ kind: 'frame', data: new Uint8Array([1, 2, 3]), key: true, pts: 40 });
		androidVideo.dispose();

		assert.deepStrictEqual({ ios, android }, {
			ios: [
				{ kind: 'frame', udid: UDID, jpeg: [0xff, 0xd8, 0xff, 0xd9] },
				{ kind: 'ended', udid: UDID, reason: 'gone' },
			],
			android: [
				{ serial: 'emulator-5554', kind: 'size', width: 720, height: 1600 },
				{ serial: 'emulator-5554', kind: 'config', data: [7, 8] },
				{ serial: 'emulator-5554', kind: 'frame', key: true, pts: 40, data: [1, 2, 3] },
			],
		});
	});

	// 始まったばかりの通話（config がまだ無い）には key frame を求めない。取り込みの用意ができる前に求めると
	// scrcpy-server が落ちる（最初の config と key frame は server が自分から送る）
	test('does not ask a scrcpy session that has just started for a key frame', async () => {
		const video = store.add(new Emitter<ParadisScrcpyVideoEvent>());
		const resets: string[] = [];
		const session = { size: undefined, config: undefined, onVideo: video.event, onDidEnd: store.add(new Emitter<Error | undefined>()).event, resetVideo: async () => { resets.push('reset'); } };
		const scrcpy = { acquire: async () => ({ session: session as never, lease: { dispose: () => { } } }), use: async () => { throw new Error('not used'); } };
		const host = { ensure: async (): Promise<IParadisSimulatorHostConnection> => ({ socketPath: '', token: '' }), isRunning: false, lastError: undefined, stop: async () => { } };
		const service = store.add(new ParadisSimulatorService(host, {} as ParadisServeSimBackend, true, new NullLogService(), undefined, { adb: { bootAvd: async () => { }, listDevices: async () => [] }, scrcpy }));
		const received: string[] = [];
		const listener = service.onAndroidVideo('emulator-5554')(message => received.push(message.kind));
		await new Promise(resolve => setTimeout(resolve, 0));
		video.fire({ kind: 'config', data: new Uint8Array([7]) });
		video.fire({ kind: 'frame', data: new Uint8Array([1]), key: true, pts: 1 });
		listener.dispose();
		assert.deepStrictEqual({ received, resets }, { received: ['config', 'frame'], resets: [] });
	});

	// Android（adb・scrcpy）は全 OS で使う。iOS（serve-sim）を使えない OS でも Android の呼び出しは断らない（Q588）
	test('serves Android calls where the iOS simulator is not supported', async () => {
		const booted: string[] = [];
		const host = { ensure: async (): Promise<IParadisSimulatorHostConnection> => ({ socketPath: '', token: '' }), isRunning: false, lastError: undefined, stop: async () => { } };
		const service = store.add(new ParadisSimulatorService(host, {} as ParadisServeSimBackend, false, new NullLogService(), undefined, {
			adb: { bootAvd: async (deviceId: string) => { booted.push(deviceId); }, listDevices: async () => [{ id: 'android:serial:emulator-5554', name: 'Pixel 9', runtimeName: 'Android 16', state: 'device' }] },
		}));
		await service.bootAndroid('android:avd:Pixel_9');
		const devices = await service.listAndroidDevices();
		const ios = await Promise.resolve().then(() => service.listDevices()).then(() => 'listed', (error: Error) => error.message);
		assert.deepStrictEqual({ booted, devices, ios }, {
			booted: ['android:avd:Pixel_9'],
			devices: [{ serial: 'emulator-5554', name: 'Pixel 9', runtime: 'Android 16', state: 'device' }],
			ios: 'The iOS simulator is only available on macOS',
		});
	});
});
