/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisBindingDialogDevicePollLease, ParadisBindingDialogTabController } from '../../electron-browser/paradisBindingDialogResources.js';

suite('ParadisBindingDialogDevicePollLease', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('owns exactly one poll lease only while the devices tab is visible', () => {
		let starts = 0;
		let stops = 0;
		let live = 0;
		const owner = store.add(new ParadisBindingDialogDevicePollLease(() => {
			starts++;
			live++;
			return toDisposable(() => {
				stops++;
				live--;
			});
		}));

		owner.setDevicesVisible(false);
		owner.setDevicesVisible(true);
		owner.setDevicesVisible(true);
		owner.setDevicesVisible(false);
		owner.setDevicesVisible(true);
		owner.dispose();

		assert.deepStrictEqual({ starts, stops, live }, { starts: 2, stops: 2, live: 0 });
	});

	test('acquires the initial poll lease for a devices-first dialog and releases it on disposal', () => {
		let starts = 0;
		let stops = 0;
		const owner = store.add(new ParadisBindingDialogDevicePollLease(() => {
			starts++;
			return toDisposable(() => stops++);
		}));

		owner.setDevicesVisible(true);
		owner.setDevicesVisible(true);
		assert.deepStrictEqual({ starts, stops }, { starts: 1, stops: 0 });

		owner.dispose();
		assert.deepStrictEqual({ starts, stops }, { starts: 1, stops: 1 });
	});
});

suite('ParadisBindingDialogTabController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createController(events: string[]): ParadisBindingDialogTabController {
		const controller = store.add(new ParadisBindingDialogTabController(
			() => {
				events.push('poll:start');
				return toDisposable(() => events.push('poll:stop'));
			},
			() => events.push(`render:${controller.activeTab}`),
		));
		return controller;
	}

	test('starts a normal dialog on panes and delegates every transition before rendering', () => {
		const events: string[] = [];
		const controller = createController(events);

		controller.initialize(true);
		controller.setActiveTab('devices');
		controller.setActiveTab('devices');
		controller.setActiveTab('mcp');
		controller.setActiveTab('devices');
		controller.dispose();

		assert.deepStrictEqual(events, [
			'render:panes',
			'poll:start', 'render:devices',
			'render:devices',
			'poll:stop', 'render:mcp',
			'poll:start', 'render:devices',
			'poll:stop',
		]);
	});

	test('starts a page-less dialog on devices and releases its lease on owner disposal', () => {
		const events: string[] = [];
		const controller = createController(events);

		controller.initialize(false);
		controller.dispose();

		assert.deepStrictEqual(events, ['poll:start', 'render:devices', 'poll:stop']);
	});
});
