/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// scrcpy の通話（⑥b）を、偽の adb と偽の端末（fork の待ち受けへ 2 本つなぐ）で確かめる。

import assert from 'assert';
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { AddressInfo, Server, Socket } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisScrcpyVideoEvent } from '../../common/paradisScrcpy.js';
import { ParadisScrcpySession } from '../../node/android/paradisScrcpySession.js';
import { ParadisScrcpySessions } from '../../node/android/paradisScrcpySessions.js';
import { paradisScrcpyTestStream } from '../common/paradisScrcpy.test.js';

interface IFakeDevice {
	readonly adbCalls: string[];
	readonly control: Buffer[];
	server?: Server;
	readonly sockets: Socket[];
	readonly killed: boolean[];
}

function fakeDevice(): { device: IFakeDevice; options: Omit<ConstructorParameters<typeof ParadisScrcpySession>[0], 'serial'> } {
	const device: IFakeDevice = { adbCalls: [], control: [], sockets: [], killed: [] };
	return {
		device,
		options: {
			adbPath: '/sdk/platform-tools/adb',
			serverJar: '/app/scrcpy-server-v5.0.1.jar',
			adb: async args => {
				device.adbCalls.push(args.join(' ').replace(/scrcpy_[0-9a-f]{8}/, 'scrcpy_<scid>').replace(/tcp:\d+/, 'tcp:<port>'));
				return '';
			},
			createServer: async () => {
				const { createServer } = await import('net');
				const server = createServer();
				await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
				device.server = server;
				return server;
			},
			// 端末の server の代わり: 起こされたら fork の待ち受けへ映像・操作の順に 2 本つなぐ
			spawnServer: () => {
				const child = new EventEmitter() as EventEmitter & { exitCode: number | null; stderr: EventEmitter; kill(): boolean };
				child.exitCode = null;
				child.stderr = new EventEmitter();
				child.kill = () => {
					device.killed.push(true);
					child.exitCode = 0;
					return true;
				};
				void (async () => {
					const { connect } = await import('net');
					const port = (device.server!.address() as AddressInfo).port;
					const video = connect(port, '127.0.0.1');
					await new Promise(resolve => video.once('connect', resolve));
					const control = connect(port, '127.0.0.1');
					await new Promise(resolve => control.once('connect', resolve));
					control.on('data', chunk => device.control.push(chunk));
					device.sockets.push(video, control);
					video.write(paradisScrcpyTestStream());
				})();
				return child as unknown as ChildProcess;
			},
		},
	};
}

suite('Paradis simulator: scrcpy session', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('pushes the server, connects over adb reverse, reads the video and sends controls', async () => {
		const { device, options } = fakeDevice();
		const session = store.add(new ParadisScrcpySession({ ...options, serial: 'emulator-5554' }, new NullLogService()));
		const events: ParadisScrcpyVideoEvent[] = [];
		store.add(session.onVideo(event => events.push(event)));
		await session.start();
		await new Promise<void>(resolve => {
			const check = () => events.some(event => event.kind === 'frame' && !event.key) ? resolve() : setTimeout(check, 5);
			check();
		});
		await session.resetVideo();
		await new Promise(resolve => setTimeout(resolve, 20));
		const sizeBefore = session.size;
		session.dispose();
		device.sockets.forEach(socket => socket.destroy());
		assert.deepStrictEqual({
			adb: device.adbCalls,
			kinds: events.map(event => event.kind),
			name: session.deviceName,
			size: sizeBefore,
			control: Buffer.concat(device.control).toString('hex'),
			killed: device.killed.length,
			listening: device.server!.listening,
		}, {
			adb: [
				'-s emulator-5554 push /app/scrcpy-server-v5.0.1.jar /data/local/tmp/scrcpy-server.jar',
				'-s emulator-5554 reverse localabstract:scrcpy_<scid> tcp:<port>',
				'-s emulator-5554 reverse --remove localabstract:scrcpy_<scid>',
			],
			kinds: ['session', 'config', 'frame', 'frame'],
			name: 'Pixel 9',
			size: { width: 1080, height: 2400 },
			control: '11',
			killed: 1,
			// 2 本を受けたら待ち受けは閉じる
			listening: false,
		});
	});

	test('shares one session per device and stops it after the last user leaves', async () => {
		const { device, options } = fakeDevice();
		const sessions = store.add(new ParadisScrcpySessions(async () => options, new NullLogService(), 10));
		const first = await sessions.acquire('emulator-5554');
		const second = await sessions.acquire('emulator-5554');
		const same = first.session === second.session;
		first.lease.dispose();
		second.lease.dispose();
		await new Promise(resolve => setTimeout(resolve, 30));
		device.sockets.forEach(socket => socket.destroy());
		assert.deepStrictEqual({ same, endedAfterIdle: first.session.ended }, { same: true, endedAfterIdle: true });
	});
});
