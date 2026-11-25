/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDeviceHubActive, paradisParseSimctlDevices, paradisParseSimulatorBootIds, paradisParseSimulatorFold, paradisParseSimulatorHostMessage, paradisSimulatorFoldFrame, paradisSimulatorInputFrame, ParadisMjpegSplitter } from '../../common/paradisSimulatorFrames.js';

function decode(frame: Uint8Array): [number, unknown] {
	return [frame[0], JSON.parse(new TextDecoder().decode(frame.subarray(1)))];
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function part(jpeg: Uint8Array): Uint8Array {
	const header = encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
	const bytes = new Uint8Array(header.length + jpeg.length + 2);
	bytes.set(header, 0);
	bytes.set(jpeg, header.length);
	bytes.set(encode('\r\n'), header.length + jpeg.length);
	return bytes;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

suite('Paradis simulator: frames', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the input frames serve-sim reads', () => {
		assert.deepStrictEqual([
			paradisSimulatorInputFrame({ kind: 'touch', phase: 'begin', x: 0.25, y: 1.5 }),
			paradisSimulatorInputFrame({ kind: 'touch', phase: 'move', x: 0.5, y: 0.97, edge: 3 }),
			paradisSimulatorInputFrame({ kind: 'key', type: 'down', usage: 4 }),
			paradisSimulatorInputFrame({ kind: 'button', button: 'home' }),
			paradisSimulatorInputFrame({ kind: 'button', button: 'volumeUp' }),
			paradisSimulatorInputFrame({ kind: 'rotate', orientation: 'landscape_left' }),
			paradisSimulatorFoldFrame({ kind: 'pose', pose: 'book' }),
			paradisSimulatorFoldFrame({ kind: 'hinge', hinge: 90 }),
		].map(decode), [
			[0x03, { type: 'begin', x: 0.25, y: 1 }],
			[0x03, { type: 'move', x: 0.5, y: 0.97, edge: 3 }],
			[0x06, { type: 'down', usage: 4 }],
			[0x04, { button: 'home' }],
			[0x04, { button: 'volume_up', page: 0x0c, usage: 0xe9, phase: 'press' }],
			[0x07, { orientation: 'landscape_left' }],
			[0x0e, { pose: 'book' }],
			[0x0e, { hinge: 90 }],
		]);
	});

	test('refuses malformed input and fold requests', () => {
		const attempts: (() => unknown)[] = [
			() => paradisSimulatorInputFrame(undefined),
			() => paradisSimulatorInputFrame({ kind: 'touch', phase: 'tap', x: 0, y: 0 }),
			() => paradisSimulatorInputFrame({ kind: 'touch', phase: 'begin', x: Number.NaN, y: 0 }),
			() => paradisSimulatorInputFrame({ kind: 'touch', phase: 'begin', x: 0, y: 0, edge: 9 }),
			() => paradisSimulatorInputFrame({ kind: 'key', type: 'down', usage: 1.5 }),
			() => paradisSimulatorInputFrame({ kind: 'button', button: 'back' }),
			() => paradisSimulatorInputFrame({ kind: 'rotate', orientation: 'sideways' }),
			() => paradisSimulatorInputFrame({ kind: 'exec', command: 'ls' }),
			() => paradisParseSimulatorFold({}),
			() => paradisParseSimulatorFold({ pose: 'open', hinge: 10 }),
			() => paradisParseSimulatorFold({ pose: 'flat' }),
			() => paradisParseSimulatorFold({ hinge: 181 }),
		];
		assert.deepStrictEqual(attempts.map(attempt => { try { attempt(); return 'accepted'; } catch { return 'refused'; } }), attempts.map(() => 'refused'));
		assert.deepStrictEqual([paradisParseSimulatorFold({ pose: 'closed' }), paradisParseSimulatorFold({ hinge: 0 })], [{ kind: 'pose', pose: 'closed' }, { kind: 'hinge', hinge: 0 }]);
	});

	test('reads the config and the fold acknowledgement from the host', () => {
		assert.deepStrictEqual([
			paradisParseSimulatorHostMessage(concat(new Uint8Array([0x82]), encode('{"width":1206,"height":2622,"orientation":"portrait"}'))),
			paradisParseSimulatorHostMessage(concat(new Uint8Array([0x82]), encode('{"width":2007,"height":2853,"orientation":"portrait","hingeDegrees":180}'))),
			paradisParseSimulatorHostMessage(concat(new Uint8Array([0x0e]), encode('{"ok":true}'))),
			paradisParseSimulatorHostMessage(concat(new Uint8Array([0x0e]), encode('{"ok":false}'))),
			paradisParseSimulatorHostMessage(concat(new Uint8Array([0x82]), encode('not json'))),
			paradisParseSimulatorHostMessage(new Uint8Array([0x01, 0x7b, 0x7d])),
		], [
			{ kind: 'config', config: { width: 1206, height: 2622, orientation: 'portrait' } },
			{ kind: 'config', config: { width: 2007, height: 2853, orientation: 'portrait', hingeDegrees: 180 } },
			{ kind: 'foldAck', ok: true },
			{ kind: 'foldAck', ok: false },
			undefined,
			undefined,
		]);
	});

	// 1 バイトずつ届いても、JPEG の中に境界の文字列があっても、Content-Length で切る
	test('splits an MJPEG stream into JPEGs', () => {
		const first = concat(new Uint8Array([0xff, 0xd8]), encode('\r\n--frame\r\n'), new Uint8Array([0xff, 0xd9]));
		const second = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
		const stream = concat(encode('junk'), part(first), part(second), encode('--frame\r\nContent-Length: nope\r\n\r\n'), part(second));
		const oneByOne = new ParadisMjpegSplitter();
		const fromBytes = [...stream].flatMap(byte => oneByOne.push(new Uint8Array([byte])));
		const fromWhole = new ParadisMjpegSplitter().push(stream);
		assert.deepStrictEqual([fromBytes, fromWhole], [[first, second, second], [first, second, second]]);
	});

	// 塊の切れ目がどこに来ても、切り出す枚は同じ（中身を待つ間は塊を溜めるだけにしているので、その境目を全部通す）
	test('splits an MJPEG stream into the same JPEGs wherever the chunks are cut', () => {
		const big = new Uint8Array(300).map((_, index) => index % 251);
		const small = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
		// 上限（32 MiB）を 1 バイト超える Content-Length の頭は読み飛ばし、次の `--frame` から続ける
		const stream = concat(encode('junk'), part(big), encode('--frame\r\nContent-Length: 33554433\r\n\r\n'), part(small), part(big), encode('--fra'));
		const hex = (frames: Uint8Array[]) => frames.map(frame => `${frame.length}:${frame[0]}:${frame[frame.length - 1]}`);
		const differing: string[] = [];
		const check = (label: string, chunks: Uint8Array[]) => {
			const splitter = new ParadisMjpegSplitter();
			const frames = chunks.flatMap(chunk => splitter.push(chunk));
			if (JSON.stringify(frames.map(frame => [...frame])) !== JSON.stringify([big, small, big].map(frame => [...frame]))) {
				differing.push(label);
			}
		};
		for (let size = 1; size <= stream.length; size++) {
			const chunks: Uint8Array[] = [];
			for (let offset = 0; offset < stream.length; offset += size) {
				chunks.push(stream.slice(offset, offset + size));
			}
			check(`size ${size}`, chunks);
		}
		for (let cut = 0; cut <= stream.length; cut++) {
			check(`cut ${cut}`, [stream.slice(0, cut), stream.slice(cut)]);
		}
		assert.deepStrictEqual({ whole: hex(new ParadisMjpegSplitter().push(stream)), differing }, { whole: ['300:0:48', '7:255:217', '300:0:48'], differing: [] });
	});

	// 起動している端末ごとの launchd_sim の pid（起動し直すと変わる）。ほかのプロセスと、Devices の外の launchd_sim は拾わない
	test('reads which launchd_sim belongs to which booted simulator', () => {
		const ps = [
			'    1 /sbin/launchd',
			'13075 launchd_sim /Users/example/Library/Developer/CoreSimulator/Devices/DB4F859B-A7C7-490A-883D-F2FA17F4AA66/data/var/run/launchd_bootstrap.plist',
			'  812 /Library/Developer/CoreSimulator/Volumes/iOS_24B91/usr/libexec/launchd_sim /Users/example/Library/Developer/CoreSimulator/Devices/5291324e-08bc-457c-9a65-a978e7d13e76/data/var/run/launchd_bootstrap.plist',
			'  900 grep launchd_sim /Users/example/Library/Developer/CoreSimulator/Devices/AAAAAAAA-0000-0000-0000-000000000000/data',
			'  901 launchd_sim /tmp/not-a-device/launchd_bootstrap.plist',
			'',
		].join('\n');
		assert.deepStrictEqual([...paradisParseSimulatorBootIds(ps)], [
			['DB4F859B-A7C7-490A-883D-F2FA17F4AA66', '13075'],
			['5291324E-08BC-457C-9A65-A978E7D13E76', '812'],
		]);
	});

	test('parses simctl devices and the Device Hub flag', () => {
		const stdout = JSON.stringify({
			devices: {
				'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [
					{ udid: 'B0000000-0000-0000-0000-000000000000', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
					{ udid: 'C0000000-0000-0000-0000-000000000000', name: 'iPhone Air', state: 'Booted', isAvailable: true },
					{ udid: 'D0000000-0000-0000-0000-000000000000', name: 'Old', state: 'Shutdown', isAvailable: false },
				],
				'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [
					{ udid: 'E0000000-0000-0000-0000-000000000000', name: 'iPhone Duo', state: 'Shutting Down', isAvailable: true },
				],
			},
		});
		assert.deepStrictEqual({
			devices: paradisParseSimctlDevices(stdout),
			hub: ['com.apple.coredevice.dtuhidd.active 1\n', 'com.apple.coredevice.dtuhidd.active 0', ''].map(paradisDeviceHubActive),
		}, {
			devices: [
				{ udid: 'C0000000-0000-0000-0000-000000000000', name: 'iPhone Air', runtime: 'iOS 27.1', state: 'Booted' },
				{ udid: 'B0000000-0000-0000-0000-000000000000', name: 'iPhone 17', runtime: 'iOS 27.1', state: 'Shutdown' },
				{ udid: 'E0000000-0000-0000-0000-000000000000', name: 'iPhone Duo', runtime: 'iOS 27.2', state: 'ShuttingDown' },
			],
			hub: [true, false, false],
		});
	});
});
