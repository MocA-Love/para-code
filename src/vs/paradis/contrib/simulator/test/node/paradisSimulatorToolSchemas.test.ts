/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントへ出している mobile_* の名前と引数（inputSchema）を固定する（q.html Q585・設計書 4 節）。
//
// 下の `EXPECTED` の表は、1 ペイン 1 台だった頃からの 17 本の名前と引数で、変えないこと（今の呼び方を壊さない）。
// 1 ペインに複数の端末を割り当てられるようにしたとき（2026-11-27、利用者の決定）に足したのは次の 2 つで、
// どちらもこのテストの中で表に重ねて確かめる:
//  - 割り当てた端末を操作する 15 本に、任意の引数 `device`（id か名前）。省けば今までどおり動く
//  - 端末を手放す mobile_release_device
// 説明（description）は固定の外。mobile_fold は別の固定（paradisServeSimDeviceHost.test.ts）。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMcpToolDefinition } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { PARADIS_MOBILE_DEVICE_ARGUMENT } from '../../common/paradisMobileAttachmentBook.js';
import { ParadisMobileCanvasService } from '../../node/paradisDeviceLedger.js';
import { ParadisMobileDeviceCommands } from '../../node/paradisMobileDeviceCommands.js';
import { IParadisMobileHostRequester, ParadisMobileDeviceOpsToolProvider } from '../../node/paradisSimulatorDeviceOps.js';

const OBJECT = 'object';

const EXPECTED: readonly { readonly name: string; readonly inputSchema: unknown }[] = [
	{ name: 'mobile_list_devices', inputSchema: { type: OBJECT, properties: {}, additionalProperties: false } },
	{ name: 'mobile_get_attached_device', inputSchema: { type: OBJECT, properties: {}, additionalProperties: false } },
	{ name: 'mobile_screenshot', inputSchema: { type: OBJECT, properties: {}, additionalProperties: false } },
	{ name: 'mobile_ui_snapshot', inputSchema: { type: OBJECT, properties: {}, additionalProperties: false } },
	{
		name: 'mobile_tap', inputSchema: {
			type: OBJECT,
			properties: {
				x: { type: 'number', description: 'Horizontal coordinate in device points.' },
				y: { type: 'number', description: 'Vertical coordinate in device points.' },
				duration: { type: 'number', description: 'Press duration in seconds. Use 1 or more for a long press. Defaults to a normal tap.' },
			},
			required: ['x', 'y'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_swipe', inputSchema: {
			type: OBJECT,
			properties: {
				startX: { type: 'number' },
				startY: { type: 'number' },
				endX: { type: 'number' },
				endY: { type: 'number' },
				duration: { type: 'number', description: 'Gesture duration in seconds. Defaults to 0.4; much faster swipes may not register (for example, a home screen page does not turn).' },
			},
			required: ['startX', 'startY', 'endX', 'endY'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_type_text', inputSchema: {
			type: OBJECT,
			properties: { text: { type: 'string' } },
			required: ['text'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_press_button', inputSchema: {
			type: OBJECT,
			properties: { button: { type: 'string', description: 'Button name, for example "home", "back", "power", "volumeUp".' } },
			required: ['button'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_ui_find', inputSchema: {
			type: OBJECT,
			properties: {
				text: { type: 'string', description: 'Matched against the label, value and hint of an element.' },
				identifier: { type: 'string', description: 'Matched against the accessibility identifier (iOS) or resource id (Android).' },
				role: { type: 'string', description: 'Restrict to one role: button, text, field, image, switch, slider, link, cell, list, tab, checkbox, container, other.' },
				exact: { type: 'boolean', description: 'Require the whole field to equal the term instead of containing it.' },
				interactableOnly: { type: 'boolean', description: 'Skip elements that do not respond to a tap.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_ui_tap', inputSchema: {
			type: OBJECT,
			properties: {
				text: { type: 'string', description: 'Matched against the label, value and hint of an element.' },
				identifier: { type: 'string', description: 'Matched against the accessibility identifier (iOS) or resource id (Android).' },
				role: { type: 'string', description: 'Restrict to one role, for example "button".' },
				exact: { type: 'boolean', description: 'Require the whole field to equal the term instead of containing it.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_read_log', inputSchema: {
			type: OBJECT,
			properties: {
				seconds: { type: 'number', description: 'How far back to read, in seconds. Defaults to 60.' },
				text: { type: 'string', description: 'Only return lines containing this text.' },
				bundleId: { type: 'string', description: 'Only return lines from this app bundle id / package name.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_request_device', inputSchema: {
			type: OBJECT,
			properties: {
				device: { type: 'string', description: 'The id or the exact name of the device, as returned by mobile_list_devices.' },
				reason: { type: 'string', description: 'One short sentence shown to the user explaining why you need the device.' },
			},
			required: ['device'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_rotate', inputSchema: {
			type: OBJECT,
			properties: {
				orientation: { type: 'string', enum: ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'] },
			},
			required: ['orientation'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_gesture', inputSchema: {
			type: OBJECT,
			properties: {
				kind: { type: 'string', enum: ['swipe', 'long_press', 'pinch'] },
				x: { type: 'number', description: 'Horizontal coordinate in device points.' },
				y: { type: 'number', description: 'Vertical coordinate in device points.' },
				direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'swipe only.' },
				distance: { type: 'number', description: 'swipe only: how far to move, in points. Defaults to 40% of the shorter side of the screen.' },
				duration: { type: 'number', description: 'Seconds. long_press: how long to hold (default 1, at most 10). swipe: how long the movement takes (default 0.4; much faster swipes may not register).' },
				scale: { type: 'number', description: 'pinch only: between 0.2 and 5. 2 doubles the distance between the fingers, 0.5 halves it.' },
			},
			required: ['kind'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_install_app', inputSchema: {
			type: OBJECT,
			properties: {
				path: { type: 'string', description: 'Absolute path to the .app bundle, .ipa or .apk on this computer.' },
			},
			required: ['path'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_launch_app', inputSchema: {
			type: OBJECT,
			properties: {
				appId: { type: 'string', description: 'The bundle id (iOS) or package name (Android), for example "com.example.myapp".' },
				relaunch: { type: 'boolean', description: 'Stop the app first if it is already running, so it starts fresh.' },
			},
			required: ['appId'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_grant_permission', inputSchema: {
			type: OBJECT,
			properties: {
				appId: { type: 'string', description: 'The bundle id (iOS) or package name (Android).' },
				permission: { type: 'string', description: 'A permission name from the list in this tool\'s description.' },
			},
			required: ['appId', 'permission'],
			additionalProperties: false,
		},
	},
];

suite('Paradis simulator: the mobile_* tool names and arguments stay fixed', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** 今エージェントへ出している mobile_* のツール（③ で変えてよいのはこの関数の中だけ）。 */
	function currentMobileTools(): readonly IParadisMcpToolDefinition[] {
		const hostClient = { request: async () => [] } as unknown as IParadisMobileHostRequester;
		const ledger = store.add(new ParadisMobileCanvasService(hostClient, new NullLogService()));
		const deviceOps = new ParadisMobileDeviceOpsToolProvider(ledger, hostClient, new ParadisMobileDeviceCommands(), undefined);
		return [...ledger.listTools(), ...deviceOps.listTools()];
	}

	/** `device` を受けない道具: 一覧（端末を選ばない）と要求（`device` は頼む端末の名指しで、元からある）。 */
	const WITHOUT_DEVICE_ARGUMENT = new Set(['mobile_list_devices', 'mobile_request_device']);

	test('the 17 tools keep their names and arguments; the ones that act on a device also take an optional "device"', () => {
		const expected = [
			...EXPECTED.map(tool => {
				const schema = tool.inputSchema as { readonly properties: object };
				return WITHOUT_DEVICE_ARGUMENT.has(tool.name) ? tool : { name: tool.name, inputSchema: { ...schema, properties: { ...schema.properties, device: PARADIS_MOBILE_DEVICE_ARGUMENT } } };
			}),
			{
				name: 'mobile_release_device', inputSchema: {
					type: OBJECT,
					properties: { device: { type: 'string', description: 'The id or the exact name of a device attached to this terminal pane (attachedDevices in mobile_list_devices).' } },
					required: ['device'],
					additionalProperties: false,
				},
			},
		];
		const current = currentMobileTools().map(tool => ({ name: tool.name, inputSchema: tool.inputSchema }));
		assert.deepStrictEqual({
			current,
			// `device` は必須にしない（省いた呼び出しは今までどおり通る）
			deviceRequired: current.filter(tool => tool.name !== 'mobile_request_device' && tool.name !== 'mobile_release_device' && ((tool.inputSchema as { required?: string[] }).required ?? []).includes('device')).map(tool => tool.name),
		}, { current: expected, deviceRequired: [] });
	});
});
