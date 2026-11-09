/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileStatus } from '../../common/paradisMobileRelay.js';
import { paradisBuildMobileTabModel } from '../../common/paradisMobileTabModel.js';

const NOTIFY = { agentDone: true, agentQuestion: false, pcFocusQuiet: true, includeContent: false };

function status(overrides: Partial<IParadisMobileStatus>): IParadisMobileStatus {
	return {
		state: 'online',
		deviceId: 'pc-1',
		pairedDevices: ['iPhone', 'iPad'],
		pairedMobiles: [
			{ mobileId: 'm1', name: 'iPhone', alias: '寝室', online: true, pairedAt: 10, lastSeenAt: 20, notify: NOTIFY },
			{ mobileId: 'm2', name: 'iPad', online: false },
		],
		onlineMobiles: 1,
		...overrides,
	};
}

suite('paradisBuildMobileTabModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks the state in the same order as the status bar', () => {
		const states = [
			paradisBuildMobileTabModel(status({ storeProblem: 'unreadable', unauthorized: true }), false),
			paradisBuildMobileTabModel(status({ storeProblem: 'unreadable', unauthorized: true }), true),
			paradisBuildMobileTabModel(status({ storeProblem: 'undecryptable' }), true),
			paradisBuildMobileTabModel(status({ unauthorized: true, state: 'disconnected' }), true),
			paradisBuildMobileTabModel(status({}), true),
			paradisBuildMobileTabModel(status({ onlineMobiles: 0 }), true),
			paradisBuildMobileTabModel(status({ state: 'disconnected' }), true),
			paradisBuildMobileTabModel(status({ state: 'disconnected', deviceId: undefined, pairedDevices: [], pairedMobiles: [] }), true),
			paradisBuildMobileTabModel(status({ state: 'connecting' }), true),
			paradisBuildMobileTabModel(status({ state: 'disabled' }), true),
		].map(model => [model.state, model.canPair, model.canStop, model.dimDevices]);
		assert.deepStrictEqual(states, [
			['disabled', false, false, true],
			['storeUnreadable', false, true, false],
			['storeUndecryptable', false, true, false],
			['unauthorized', false, true, false],
			['connected', true, true, false],
			['waiting', true, true, false],
			['disconnected', true, true, false],
			['unregistered', true, true, false],
			['connecting', true, true, false],
			['connecting', true, true, false],
		]);
	});

	test('lists the devices with the alias first, and shows no one online while the relay is not connected', () => {
		const online = paradisBuildMobileTabModel(status({}), true);
		const disconnected = paradisBuildMobileTabModel(status({ state: 'disconnected' }), true);
		assert.deepStrictEqual({
			online: { onlineCount: online.onlineCount, pairedCount: online.pairedCount, devices: online.devices },
			disconnected: { onlineCount: disconnected.onlineCount, online: disconnected.devices?.map(device => device.online) },
		}, {
			online: {
				onlineCount: 1,
				pairedCount: 2,
				devices: [
					{ mobileId: 'm1', displayName: '寝室', deviceName: 'iPhone', online: true, lastSeenAt: 20, pairedAt: 10, notify: NOTIFY },
					{ mobileId: 'm2', displayName: 'iPad', deviceName: undefined, online: false, lastSeenAt: undefined, pairedAt: undefined, notify: undefined },
				],
			},
			disconnected: { onlineCount: 0, online: [false, false] },
		});
	});

	test('hides the table when the ledger cannot be read, and falls back to names from an older shared process', () => {
		const unreadable = paradisBuildMobileTabModel(status({ storeProblem: 'unreadable' }), true);
		const older = paradisBuildMobileTabModel(status({ pairedMobiles: undefined }), true);
		assert.deepStrictEqual({
			unreadable: unreadable.devices,
			older: older.devices?.map(device => [device.mobileId, device.displayName, device.online]),
		}, {
			unreadable: undefined,
			older: [['iPhone', 'iPhone', false], ['iPad', 'iPad', false]],
		});
	});
});
