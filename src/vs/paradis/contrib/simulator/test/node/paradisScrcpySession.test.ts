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

function fakeDevice(reverseList = ''): { device: IFakeDevice; options: Omit<ConstructorParameters<typeof ParadisScrcpySession>[0], 'serial'> } {
	const device: IFakeDevice = { adbCalls: [], control: [], sockets: [], killed: [] };
	return {
		device,
		options: {
			adbPath: '/sdk/platform-tools/adb',
			serverJar: '/app/scrcpy-server-v5.0.1.jar',
			adb: async args => {
				device.adbCalls.push(args.join(' ').replace(/scrcpy_(?!aaaaaaaa|bbbbbbbb)[0-9a-f]{8}/, 'scrcpy_<scid>').replace(/tcp:\d+/, 'tcp:<port>'));
				return args.includes('--list') ? reverseList : '';
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
					control.on('data', chunk => {
						device.control.push(chunk);
						// 端末の server の返事: クリップボードを求められたら中身を、書いたら ACK（sequence）を返す
						if (chunk[0] === 8) {
							const text = Buffer.from('user text');
							const reply = Buffer.alloc(5 + text.length);
							reply[0] = 0;
							reply.writeUInt32BE(text.length, 1);
							text.copy(reply, 5);
							control.write(reply);
						} else if (chunk[0] === 9) {
							const ack = Buffer.alloc(9);
							ack[0] = 1;
							chunk.copy(ack, 1, 1, 9);
							control.write(ack);
						}
					});
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
		// クリップボード: 読む、書いて ACK を待つ（sequence 付き）
		const clipboard = await session.getClipboard(2000);
		await session.setClipboard('あ', true, 2000);
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
			clipboard,
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
			control: '11' + '0800' + '09' + '0000000000000001' + '01' + '00000003' + 'e38182',
			clipboard: 'user text',
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

	// 初めての 2 件が重なっても、通話は 1 つだけ立てる（MEDIUM2）
	test('starts a single session when two first requests overlap', async () => {
		const { device, options } = fakeDevice();
		let factoryCalls = 0;
		const sessions = store.add(new ParadisScrcpySessions(async () => {
			factoryCalls++;
			await new Promise(resolve => setTimeout(resolve, 5));
			return options;
		}, new NullLogService(), 10));
		const [first, second] = await Promise.all([sessions.acquire('emulator-5554'), sessions.acquire('emulator-5554')]);
		const same = first.session === second.session;
		first.lease.dispose();
		second.lease.dispose();
		await new Promise(resolve => setTimeout(resolve, 30));
		device.sockets.forEach(socket => socket.destroy());
		assert.deepStrictEqual({ same, factoryCalls, pushes: device.adbCalls.filter(call => call.includes(' push ')).length }, { same: true, factoryCalls: 1, pushes: 1 });
	});

	// 前に Para Code が作ったまま残った reverse だけを外す（利用者自身の scrcpy の reverse には触れない）
	test('removes reverses Para Code left behind, and only those', async () => {
		const { device, options } = fakeDevice('emulator-5554 localabstract:scrcpy_aaaaaaaa tcp:40001\nemulator-5554 localabstract:scrcpy_bbbbbbbb tcp:27183\n');
		const recorded = new Map<string, Set<string>>([['emulator-5554', new Set(['aaaaaaaa', 'cccccccc'])]]);
		const record = {
			list: async (serial: string) => [...recorded.get(serial) ?? []],
			add: async (serial: string, scid: string) => { recorded.set(serial, new Set([...recorded.get(serial) ?? [], scid])); },
			remove: async (serial: string, scid: string) => { recorded.get(serial)?.delete(scid); },
		};
		const session = store.add(new ParadisScrcpySession({ ...options, serial: 'emulator-5554', reverseRecord: record }, new NullLogService()));
		await session.start();
		await new Promise(resolve => setTimeout(resolve, 20));
		session.dispose();
		device.sockets.forEach(socket => socket.destroy());
		assert.deepStrictEqual({ adb: device.adbCalls.slice(0, 3), left: [...recorded.get('emulator-5554') ?? []] }, {
			adb: [
				'-s emulator-5554 reverse --list',
				'-s emulator-5554 reverse --remove localabstract:scrcpy_aaaaaaaa',
				'-s emulator-5554 push /app/scrcpy-server-v5.0.1.jar /data/local/tmp/scrcpy-server.jar',
			],
			// 古いものは記録から消え、今回のものも外した後に消える
			left: [],
		});
	});
});
