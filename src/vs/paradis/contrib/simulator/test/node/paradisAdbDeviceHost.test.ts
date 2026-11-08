/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android について、Mobile Canvas ホストの REST と同じ道に利用者の adb で答えること（⑥a）。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_ADB_NOT_FOUND, ParadisAdbDeviceHost } from '../../node/android/paradisAdbDeviceHost.js';

const SDK = '/Users/example/Library/Android/sdk';
const ADB = `${SDK}/platform-tools/adb`;
const EMULATOR = `${SDK}/emulator/emulator`;

function setup(options: { files?: string[]; running?: boolean } = {}) {
	const calls: string[] = [];
	const launched: string[] = [];
	const files = new Set(options.files ?? [ADB, EMULATOR]);
	const running = options.running ?? true;
	const host = new ParadisAdbDeviceHost({
		env: {},
		platform: 'darwin',
		home: '/Users/example',
		exists: async path => files.has(path),
		launch: (file, args) => launched.push([file, ...args].join(' ')),
		exec: async (file, args) => {
			const line = [file === ADB ? 'adb' : file === EMULATOR ? 'emulator' : file, ...args].join(' ');
			calls.push(line);
			if (line === 'adb devices -l') {
				return running ? 'List of devices attached\nemulator-5554 device model:Pixel_9\n' : 'List of devices attached\n';
			}
			if (line === 'emulator -list-avds') {
				return 'Pixel_9_API_36\nMedium_Phone\n';
			}
			if (line.endsWith('emu avd name')) {
				return 'Pixel_9_API_36\nOK\n';
			}
			if (line.endsWith('getprop ro.build.version.release')) {
				return '16\n';
			}
			if (line.endsWith('wm size')) {
				return 'Physical size: 1080x2400\n';
			}
			if (line.endsWith('wm density')) {
				return 'Physical density: 480\n';
			}
			if (line.endsWith('dumpsys input')) {
				return 'SurfaceOrientation: 0\n';
			}
			if (line.includes('exec-out screencap')) {
				return new Uint8Array([0x89, 0x50]);
			}
			return '';
		},
	}, new NullLogService());
	return { host, calls, launched };
}

const SERIAL_ID = 'android%3Aserial%3Aemulator-5554';

suite('Paradis simulator: adb answers the Mobile Canvas REST for Android', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists running devices and the AVDs that are not running', async () => {
		const { host } = setup();
		assert.deepStrictEqual(await host.listDevices(), [
			{ id: 'android:serial:emulator-5554', udid: 'emulator-5554', name: 'Pixel 9 API 36', platform: 'android', runtimeName: 'Android 16', state: 'device' },
			{ id: 'android:avd:Medium_Phone', name: 'Medium Phone', platform: 'android', state: 'shutdown' },
		]);
	});

	// ポイント = 画素 ÷ (480/160 = 3)。adb の input は画素を受ける
	test('turns taps, swipes, keys, rotation and text into adb shell input', async () => {
		const { host, calls } = setup();
		await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/tap`, { x: 100, y: 200 });
		await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/tap`, { x: 100, y: 200, duration: 1 });
		await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/swipe`, { startX: 10, startY: 20, endX: 30, endY: 40, duration: 0.5 });
		await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/button`, { button: 'back' });
		await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/rotate`, { orientation: 'landscape-left' });
		await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/text`, { text: 'hi there' });
		const japanese = await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/text`, { text: 'こんにちは' }).then(() => 'typed', (error: Error) => error.message.includes('ASCII'));
		const pinch = await host.request('POST', `/api/v1/devices/${SERIAL_ID}/input/touch`, { x: 1, y: 1, phase: 'down', fingerId: 0 }).then(() => 'accepted', () => 'refused');
		const display = await host.request('GET', `/api/v1/devices/${SERIAL_ID}/display`, undefined);
		assert.deepStrictEqual({ inputs: calls.filter(call => call.includes('shell input') || call.includes('shell settings')), japanese, pinch, display }, {
			inputs: [
				'adb -s emulator-5554 shell input tap 300 600',
				'adb -s emulator-5554 shell input swipe 300 600 300 600 1000',
				'adb -s emulator-5554 shell input swipe 30 60 90 120 500',
				'adb -s emulator-5554 shell input keyevent 4',
				'adb -s emulator-5554 shell settings put system accelerometer_rotation 0',
				'adb -s emulator-5554 shell settings put system user_rotation 1',
				'adb -s emulator-5554 shell input text hi%sthere',
			],
			japanese: true,
			pinch: 'refused',
			display: { pointWidth: 360, pointHeight: 800, pixelWidth: 1080, pixelHeight: 2400, scale: 3, orientation: 'portrait' },
		});
	});

	// AVD の id を割り当てたペインは、そのエミュレータが動いていればその serial へ。動いていなければ理由を返し、承認で起動する
	test('resolves an AVD id to its running emulator and boots it when it is not running', async () => {
		const runningSetup = setup();
		const png = await runningSetup.host.requestBinary('/api/v1/devices/android%3Aavd%3APixel_9_API_36/screenshot');
		const stopped = setup({ running: false });
		const notRunning = await stopped.host.request('POST', '/api/v1/devices/android%3Aavd%3APixel_9_API_36/input/tap', { x: 1, y: 1 }).then(() => 'tapped', (error: Error) => error.message.includes('is not running'));
		await stopped.host.bootAvd('android:avd:Pixel_9_API_36');
		assert.deepStrictEqual({ png: [...png], screencap: runningSetup.calls.filter(call => call.includes('screencap')), notRunning, launched: stopped.launched }, {
			png: [0x89, 0x50],
			screencap: ['adb -s emulator-5554 exec-out screencap -p'],
			notRunning: true,
			launched: [`${EMULATOR} -avd Pixel_9_API_36`],
		});
	});

	test('explains how to install adb when it is missing', async () => {
		const { host } = setup({ files: [] });
		assert.deepStrictEqual(await host.listDevices().then(() => 'listed', (error: Error) => error.message), PARADIS_ADB_NOT_FOUND);
	});
});
