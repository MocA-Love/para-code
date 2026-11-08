/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileDevice } from '../../common/paradisMobileCanvas.js';
import {
	paradisDeviceHeldByAnotherPane,
	paradisIsValidAppId,
	paradisIsValidNativeDeviceId,
	paradisMobileInstallKindFor,
	paradisListappsApplicationType,
	paradisMobilePlatformOf,
	paradisNormalizeOrientation,
	paradisPackageListIncludes,
	paradisParseDangerousPermissions,
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

	test('platforms, native ids, install kinds and orientations', () => {
		assert.deepStrictEqual({
			platforms: [paradisMobilePlatformOf('iOS'), paradisMobilePlatformOf('Android'), paradisMobilePlatformOf('watchOS')],
			ids: [
				paradisIsValidNativeDeviceId('ios', 'A1B2C3D4-0000-1111-2222-333344445555'),
				paradisIsValidNativeDeviceId('android', 'emulator-5554'),
				paradisIsValidNativeDeviceId('android', '-s'),
				paradisIsValidNativeDeviceId('ios', 'booted udid'),
			],
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
			kinds: ['app', 'ipa', undefined, 'apk', undefined],
			orientations: ['landscape-right', 'landscape-left', undefined],
		});
	});

	test('reads what the device reports: dangerous permissions, user packages and the iOS application type', () => {
		const permissions = [
			'Dangerous Permissions:',
			'',
			'group:android.permission-group.CAMERA',
			'  permission:android.permission.CAMERA',
			'',
			'ungrouped:',
			'  permission:android.permission.POST_NOTIFICATIONS',
		].join('\n');
		const listapps = [
			'{',
			'    "com.apple.Preferences" =     {',
			'        ApplicationType = System;',
			'        GroupContainers =         {',
			'            "group.com.example.app" = "file:///x/";',
			'        };',
			'    };',
			'    "com.example.app" =     {',
			'        ApplicationType = User;',
			'        CFBundleIdentifier = "com.example.app";',
			'    };',
			'    "com.example.noType" =     {',
			'        CFBundleIdentifier = "com.example.noType";',
			'    };',
			'}',
		].join('\n');
		assert.deepStrictEqual({
			permissions: [...paradisParseDangerousPermissions(permissions)],
			packages: [paradisPackageListIncludes('package:com.example.app\npackage:com.example.app2\n', 'com.example.app'), paradisPackageListIncludes('package:com.example.app2\n', 'com.example.app')],
			types: ['com.example.app', 'com.apple.Preferences', 'group.com.example.app', 'com.example.noType', 'com.example.missing'].map(id => paradisListappsApplicationType(listapps, id)),
		}, {
			permissions: ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'],
			packages: [true, false],
			types: ['User', 'System', undefined, undefined, undefined],
		});
	});

	test('a device held by another pane is recognised by id and by native id', () => {
		const device = (id: string, udid?: string): IParadisMobileDevice => ({ id, udid, name: id, platform: 'Android', state: 'device', isRunning: true });
		const devices = [device('avd:pixel', 'emulator-5554'), device('serial:emulator-5554', 'emulator-5554'), device('avd:other', 'emulator-5556')];
		const attachments = [{ paneToken: 'pane-b', deviceId: 'avd:pixel', deviceName: 'Pixel', stateKey: undefined, attachedAt: 0 }];
		assert.deepStrictEqual(
			devices.map(entry => [paradisDeviceHeldByAnotherPane('pane-a', entry, devices, attachments), paradisDeviceHeldByAnotherPane('pane-b', entry, devices, attachments)]),
			[[true, false], [true, false], [false, false]],
		);
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
