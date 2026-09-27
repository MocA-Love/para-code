/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisIsSystemAppId,
	paradisIsValidAppId,
	paradisIsValidNativeDeviceId,
	paradisMobileInstallKindFor,
	paradisMobilePlatformOf,
	paradisNormalizeOrientation,
	paradisParseMobileDeviceRequestAnswer,
	paradisPinchFrames,
	paradisResolveMobilePermission,
	paradisSwipeEndpoints,
} from '../../common/paradisMobileDeviceOps.js';

suite('ParadisMobileDeviceOps', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('app ids: only dotted identifiers, nothing a device shell or an option parser could read differently', () => {
		const cases: [string, unknown][] = [
			['com.example.app', 'com.example.app'],
			['com.example.my-app', 'com.example.my-app'],
			['com.example.app;reboot', 'com.example.app;reboot'],
			['com.example.app reboot', 'com.example.app reboot'],
			['-n', '-n'],
			['single', 'single'],
			['$(id).x', '$(id).x'],
			['number', 42],
		];
		assert.deepStrictEqual(
			cases.map(([label, value]) => [label, paradisIsValidAppId('ios', value), paradisIsValidAppId('android', value)]),
			[
				['com.example.app', true, true],
				['com.example.my-app', true, false],
				['com.example.app;reboot', false, false],
				['com.example.app reboot', false, false],
				['-n', false, false],
				['single', false, false],
				['$(id).x', false, false],
				['number', false, false],
			],
		);
	});

	test('permissions resolve to one service or one runtime permission, never "all"', () => {
		assert.deepStrictEqual({
			iosPhotos: paradisResolveMobilePermission('ios', 'Photos'),
			iosAll: paradisResolveMobilePermission('ios', 'all'),
			iosCamera: paradisResolveMobilePermission('ios', 'camera'),
			androidCamera: paradisResolveMobilePermission('android', 'camera'),
			androidFull: paradisResolveMobilePermission('android', 'android.permission.READ_SMS'),
			androidInjection: paradisResolveMobilePermission('android', 'android.permission.CAMERA; rm -rf /'),
			androidCustom: paradisResolveMobilePermission('android', 'com.example.permission.X'),
		}, {
			iosPhotos: 'photos',
			iosAll: undefined,
			iosCamera: undefined,
			androidCamera: 'android.permission.CAMERA',
			androidFull: 'android.permission.READ_SMS',
			androidInjection: undefined,
			androidCustom: undefined,
		});
	});

	test('platforms, native ids, system apps, install kinds and orientations', () => {
		assert.deepStrictEqual({
			platforms: [paradisMobilePlatformOf('iOS'), paradisMobilePlatformOf('Android'), paradisMobilePlatformOf('watchOS')],
			ids: [
				paradisIsValidNativeDeviceId('ios', 'A1B2C3D4-0000-1111-2222-333344445555'),
				paradisIsValidNativeDeviceId('android', 'emulator-5554'),
				paradisIsValidNativeDeviceId('android', '-s'),
				paradisIsValidNativeDeviceId('ios', 'booted udid'),
			],
			system: [paradisIsSystemAppId('ios', 'com.apple.Preferences'), paradisIsSystemAppId('android', 'com.android.settings'), paradisIsSystemAppId('android', 'com.example.app')],
			kinds: [
				paradisMobileInstallKindFor('ios', '/b/My.app/'),
				paradisMobileInstallKindFor('ios', '/b/My.IPA'),
				paradisMobileInstallKindFor('ios', '/b/my.apk'),
				paradisMobileInstallKindFor('android', '/b/my.apk'),
				paradisMobileInstallKindFor('android', '/b/My.app'),
			],
			orientations: [paradisNormalizeOrientation('LANDSCAPE_RIGHT'), paradisNormalizeOrientation('landscape'), paradisNormalizeOrientation('sideways')],
		}, {
			platforms: ['ios', 'android', undefined],
			ids: [true, true, false, false],
			system: [true, true, false],
			kinds: ['app', 'ipa', undefined, 'apk', undefined],
			orientations: ['landscape-right', 'landscape-left', undefined],
		});
	});

	test('request answers: anything malformed is not an approval', () => {
		assert.deepStrictEqual([
			paradisParseMobileDeviceRequestAnswer({ outcome: 'approved', stateKey: 'space-1' }),
			paradisParseMobileDeviceRequestAnswer({ outcome: 'approve' }),
			paradisParseMobileDeviceRequestAnswer(true),
			paradisParseMobileDeviceRequestAnswer({ outcome: 'denied', stateKey: 7 }),
		], [
			{ outcome: 'approved', stateKey: 'space-1' },
			undefined,
			undefined,
			{ outcome: 'denied' },
		]);
	});

	test('gesture geometry stays inside the screen', () => {
		const size = { width: 400, height: 800 };
		const frames = paradisPinchFrames({ x: 200, y: 400 }, 80, 1000, 2, size);
		assert.deepStrictEqual({
			swipeUp: paradisSwipeEndpoints('up', size),
			swipeLeftFromEdge: paradisSwipeEndpoints('left', size, { x: 20, y: 100 }, 300),
			pinch: frames.map(([a, b]) => [a.x, b.x]),
		}, {
			swipeUp: { start: { x: 200, y: 400 }, end: { x: 200, y: 240 } },
			swipeLeftFromEdge: { start: { x: 20, y: 100 }, end: { x: 8, y: 100 } },
			pinch: [[160, 240], [8, 392], [8, 392]],
		});
	});
});
