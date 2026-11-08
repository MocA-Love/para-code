/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 窓を閉じると、その窓の IPC の購読は shared process 側で外れる。最後の購読が外れたら映像の流れを閉じること。

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ParadisAndroidVideoWire, ParadisScrcpyVideoEvent } from '../../common/paradisScrcpy.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisServeSimBackend } from '../../node/paradisServeSimBackend.js';
import { ParadisSimulatorService } from '../../node/paradisSimulatorChannel.js';
import { IParadisSimulatorHostConnection } from '../../node/paradisSimulatorHostProcess.js';
import { paradisDropUnreachableAttachments } from '../../node/paradisSimulator.sharedProcess.js';
import { IParadisMobileAttachment, IParadisMobileDevice } from '../../../mobileCanvas/common/paradisMobileCanvas.js';

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
		const service = store.add(new ParadisSimulatorService(host, backend, () => true, true, new NullLogService()));
		const received: number[] = [];
		const first = service.onFrames(UDID)(frame => received.push(frame.jpeg.byteLength));
		const second = service.onFrames(UDID)(() => { });
		emit?.(new Uint8Array(3));
		const whileOpen = open;
		first.dispose();
		const afterFirst = open;
		second.dispose();
		const disabledService = store.add(new ParadisSimulatorService(host, backend, () => false, true, new NullLogService()));
		const disabled = disabledService.onFrames(UDID)(() => { });
		disabled.dispose();
		assert.deepStrictEqual({ whileOpen, afterFirst, afterLast: open, received, openedWhileDisabled: open }, { whileOpen: 1, afterFirst: 1, afterLast: 0, received: [3], openedWhileDisabled: 0 });
	});

	// 設定を切り替えると iOS と Android を受け持つ仕組みが替わる。新しい一覧に無い割り当てを外す（Android は Android を確かに読めた一覧のときだけ。一覧が取れなければ iOS の分をすべて）。ほかは触らない
	test('detaches iOS simulator and Android panes the new list does not have after the setting changes, and leaves the others alone', async () => {
		const attachment = (paneToken: string, deviceId: string): IParadisMobileAttachment => ({ paneToken, deviceId, deviceName: deviceId, stateKey: undefined, attachedAt: 0 });
		const run = async (devices: IParadisMobileDevice[] | Error, androidListed = false) => {
			const attachments = [attachment('pane-ios', `ios:core-simulator:${UDID}`), attachment('pane-gone', 'ios:core-simulator:B0000000-0000-0000-0000-000000000000'), attachment('pane-android', 'android:emulator-5554'), attachment('pane-other', 'web:thing')];
			const detached: string[] = [];
			const dropped = await paradisDropUnreachableAttachments({
				listAttachments: () => attachments,
				listDevices: async () => { if (devices instanceof Error) { throw devices; } return devices; },
				detach: token => detached.push(token),
			}, new NullLogService(), () => androidListed);
			return { dropped, detached };
		};
		const device = (id: string): IParadisMobileDevice => ({ id, name: id, platform: id.split(':')[0], state: 'booted', isRunning: true });
		assert.deepStrictEqual({
			listed: await run([device(`ios:core-simulator:${UDID}`), device('android:emulator-5554')], true),
			// Mobile Canvas の id（`android:emulator-5554`）は新しい仕組みの一覧（`android:serial:`）に無いので外す
			idChanged: await run([device(`ios:core-simulator:${UDID}`), device('android:serial:emulator-5554')], true),
			// adb や Mobile Canvas が再起動中などで失敗すると、振り分けは iOS だけの一覧を返す。Android の割り当ては外さない
			androidNotListed: await run([device(`ios:core-simulator:${UDID}`)], false),
			failed: await run(new Error('no host')),
		}, {
			listed: { dropped: 1, detached: ['pane-gone'] },
			idChanged: { dropped: 2, detached: ['pane-gone', 'pane-android'] },
			androidNotListed: { dropped: 1, detached: ['pane-gone'] },
			failed: { dropped: 2, detached: ['pane-ios', 'pane-gone'] },
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
		const service = store.add(new ParadisSimulatorService(host, {} as ParadisServeSimBackend, () => true, true, new NullLogService(), undefined, { adb: { bootAvd: async () => { }, listDevices: async () => [] }, scrcpy }));
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
});
