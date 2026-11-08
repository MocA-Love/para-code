/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAdbInputText, paradisAndroidAvdOf, paradisAndroidKeycode, paradisAndroidRotation, paradisAndroidSerialOf, paradisFilterLogcat, paradisNormalizeUiautomator, paradisParseAdbDevices, paradisParseAvdList, paradisParseSurfaceOrientation, paradisParseWmDensity, paradisParseWmSize } from '../../common/paradisAndroid.js';
import { paradisFindSimulatorAx } from '../../common/paradisSimulatorAx.js';

const UI_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" enabled="true" focused="false" bounds="[0,0][1080,2400]">
<node index="0" text="Sign in" resource-id="com.example:id/signin" class="android.widget.Button" content-desc="" clickable="true" enabled="true" focused="false" bounds="[105,420][975,567]" />
<node index="1" text="me@example.com" resource-id="com.example:id/email" class="android.widget.EditText" content-desc="Email" clickable="true" enabled="true" focused="true" bounds="[105,630][975,777]" />
<node index="2" text="Terms &amp; conditions" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" focused="false" bounds="[105,840][975,903]" />
</node>
</hierarchy>`;

suite('Paradis simulator: Android with adb', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads adb, wm and dumpsys output', () => {
		assert.deepStrictEqual({
			devices: paradisParseAdbDevices('List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nR5CT10ABC      unauthorized usb:1-1 transport_id:2\n-bad   device\n\n'),
			avds: paradisParseAvdList('Pixel_9_API_36\nMedium_Phone\nINFO | something\n'),
			size: [paradisParseWmSize('Physical size: 1080x2400\n'), paradisParseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n'), paradisParseWmSize('nothing')],
			density: [paradisParseWmDensity('Physical density: 420\n'), paradisParseWmDensity('Physical density: 420\nOverride density: 320\n')],
			orientation: [paradisParseSurfaceOrientation('  SurfaceOrientation: 1\n'), paradisParseSurfaceOrientation('')],
		}, {
			devices: [{ serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 arm64' }, { serial: 'R5CT10ABC', state: 'unauthorized' }],
			avds: ['Pixel_9_API_36', 'Medium_Phone'],
			size: [{ width: 1080, height: 2400 }, { width: 720, height: 1600 }, undefined],
			density: [420, 320],
			orientation: [1, 0],
		});
	});

	test('maps ids, buttons, rotation and text for adb', () => {
		assert.deepStrictEqual({
			serials: ['android:serial:emulator-5554', 'android:serial:-x', 'ios:core-simulator:A'].map(paradisAndroidSerialOf),
			avds: ['android:avd:Pixel_9', 'android:avd:bad name'].map(paradisAndroidAvdOf),
			keys: ['home', 'back', 'volumeUp', 'app-switcher', 'power', 'siri'].map(paradisAndroidKeycode),
			rotations: ['portrait', 'landscape-left', 'portrait-upside-down', 'landscape-right', 'sideways'].map(paradisAndroidRotation),
			text: [paradisAdbInputText('hello world'), paradisAdbInputText('a&b'), paradisAdbInputText('こんにちは')],
		}, {
			serials: ['emulator-5554', undefined, undefined],
			avds: ['Pixel_9', undefined],
			keys: [3, 4, 24, 187, 26, undefined],
			rotations: [0, 1, 2, 3, undefined],
			text: ['hello%sworld', 'a\\&b', undefined],
		});
	});

	// iOS と同じ形の木（ポイント = 画素 ÷ density/160）にし、同じ探し方で探せること
	test('turns a uiautomator dump into the shared tree in points', () => {
		const snapshot = paradisNormalizeUiautomator(UI_DUMP, 420 / 160);
		const signIn = paradisFindSimulatorAx(snapshot, { text: 'sign in' });
		assert.deepStrictEqual({
			screen: snapshot.screen,
			count: snapshot.count,
			children: snapshot.root.children.map(child => ({ role: child.role, label: child.label, value: child.value, identifier: child.identifier, focused: child.focused })),
			signIn: signIn.matches.map(match => match.center),
		}, {
			screen: { width: 1080 / (420 / 160), height: 2400 / (420 / 160) },
			count: 4,
			children: [
				{ role: 'button', label: 'Sign in', value: '', identifier: 'com.example:id/signin', focused: undefined },
				{ role: 'field', label: 'Email', value: 'me@example.com', identifier: 'com.example:id/email', focused: true },
				{ role: 'text', label: 'Terms & conditions', value: '', identifier: undefined, focused: undefined },
			],
			signIn: [{ x: 205.7, y: 188 }],
		});
	});

	test('keeps the recent logcat lines of the app', () => {
		const stdout = [
			'  1700000000.100  1234  1234 I ActivityManager: start com.example.app',
			'  1700000050.200  4321  4321 E Example: crash',
			'  1700000055.300  999  999 I Other: noise',
		].join('\n');
		assert.deepStrictEqual(paradisFilterLogcat(stdout, 1700000010, { bundleId: 'com.example.app', pids: ['4321'] }), ['  1700000050.200  4321  4321 E Example: crash']);
	});
});
