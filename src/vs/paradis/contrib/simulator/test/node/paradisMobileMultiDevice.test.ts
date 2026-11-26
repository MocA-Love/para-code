/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 1 つのペインに複数の端末を割り当てたときの、台帳（本物）と mobile_* の全部の道具の振る舞い。
// 端末の口だけを偽る（どの端末へ届いたかは、口が受けたパスで見る）。

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMcpToolCallContext, IParadisMcpToolProvider } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { PARADIS_MOBILE_MAX_DEVICES_PER_PANE } from '../../common/paradisMobileAttachmentBook.js';
import { ParadisMobileCanvasService } from '../../node/paradisDeviceLedger.js';
import { ParadisMobileDeviceCommands } from '../../node/paradisMobileDeviceCommands.js';
import { ParadisServeSimBackend } from '../../node/paradisServeSimBackend.js';
import { ParadisServeSimDeviceHost } from '../../node/paradisServeSimDeviceHost.js';
import { IParadisMobileHostRequester, ParadisMobileDeviceOpsToolProvider } from '../../node/paradisSimulatorDeviceOps.js';
import { ParadisSimulatorFoldToolProvider } from '../../node/paradisSimulatorFoldTool.js';

const PANE = 'pane-a';
const OTHER = 'pane-b';
const IPHONE_ID = 'ios:core-simulator:CA66CB4A-B18A-410E-AECB-D50C73A15A51';
const ANDROID_ID = 'android:serial:emulator-5556';
const IPAD_ID = 'ios:core-simulator:0A66CB4A-B18A-410E-AECB-D50C73A15A52';

const DEVICES = [
	{ id: IPHONE_ID, udid: 'CA66CB4A-B18A-410E-AECB-D50C73A15A51', name: 'iPhone 17', platform: 'ios', runtimeName: 'iOS 27.2', state: 'booted' },
	{ id: ANDROID_ID, udid: 'emulator-5556', name: 'Para_Code_CLI_Test', platform: 'android', runtimeName: 'Android 16', state: 'device', avdId: 'android:avd:Para_Code_CLI_Test' },
	{ id: IPAD_ID, udid: '0A66CB4A-B18A-410E-AECB-D50C73A15A52', name: 'iPad Air', platform: 'ios', runtimeName: 'iOS 27.2', state: 'booted' },
	...Array.from({ length: PARADIS_MOBILE_MAX_DEVICES_PER_PANE }, (_, index) => ({ id: `ios:extra-${index}`, udid: `extra-${index}`, name: `Extra ${index}`, platform: 'ios', state: 'shutdown' })),
];

/** 幅と高さだけを持つ PNG の頭（IHDR まで）。 */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

function textOf(result: unknown): { readonly isError: boolean; readonly text: string; readonly structured: unknown } {
	const value = result as { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
	return { isError: value.isError === true, text: value.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), structured: value.structuredContent };
}

suite('Paradis mobile: several devices on one terminal pane', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	function setup() {
		const paths: string[] = [];
		const host: IParadisMobileHostRequester = {
			request: async (method, path) => {
				if (path === '/api/v1/devices') {
					return DEVICES;
				}
				paths.push(`${method} ${decodeURIComponent(path)}`);
				const id = decodeURIComponent(/^\/api\/v1\/devices\/(?<id>[^/?]+)/.exec(path)!.groups!.id);
				if (/\/display$/.test(path)) {
					return { pointWidth: 400, pointHeight: 800, scale: 3, orientation: 'portrait' };
				}
				if (/\/ui$/.test(path)) {
					return { root: { children: [] } };
				}
				return /\/devices\/[^/]+$/.test(path) ? DEVICES.find(device => device.id === id) : { ok: true };
			},
			requestBinary: async path => {
				paths.push(`GET ${decodeURIComponent(path)}`);
				return pngHeader(1200, 2400);
			},
		};
		const service = store.add(new ParadisMobileCanvasService(host, new NullLogService()));
		const deviceOps = new ParadisMobileDeviceOpsToolProvider(service, host, new ParadisMobileDeviceCommands(async () => ({ code: 1, stdout: '', stderr: 'not available in this test' })), undefined, async () => { });
		const fold = new ParadisSimulatorFoldToolProvider(
			service,
			{ getScreenConfig: async () => ({ width: 1206, height: 2622, orientation: 'portrait' }), listDevices: async () => [], fold: async () => false } as unknown as ParadisServeSimBackend,
			{ request: async () => undefined, forgetDisplay: () => { } } as unknown as ParadisServeSimDeviceHost,
			() => { },
			() => true,
			undefined,
		);
		const context = { classifyCaller: async () => 'pane', callOwningWindow: async () => ({ ok: false, error: 'no window in this test' }) } as unknown as IParadisMcpToolCallContext;
		const providers: IParadisMcpToolProvider[] = [service, deviceOps, fold];
		const call = async (name: string, args: object, paneToken = PANE) => {
			for (const provider of providers) {
				const result = await provider.callTool(paneToken, name, args, undefined, context);
				if (result !== undefined) {
					return textOf(result);
				}
			}
			throw new Error(`no provider answered ${name}`);
		};
		return { service, providers, call, paths };
	}

	// 利用者の決定: 端末の取り違えを防ぐため、返事には必ず操作した端末の名前と id を入れる
	test('every mobile tool that acts on a device names that device (name and id) in its answer, whether it worked or failed', async () => {
		const { service, providers, call, paths } = setup();
		await service.attach(PANE, IPHONE_ID, undefined);
		await service.attach(PANE, ANDROID_ID, undefined);
		// 端末を選ばない道具（一覧）・端末を足す道具（要求）・手放す道具は別に確かめる
		const tools = providers.flatMap(provider => provider.listTools().map(tool => tool.name)).filter(name => !['mobile_list_devices', 'mobile_request_device', 'mobile_release_device'].includes(name));
		const unnamed: string[] = [];
		const wrongDevice: string[] = [];
		for (const name of tools) {
			paths.length = 0;
			// 今の端末は最後に割り当てた Android。名指しした iPhone だけに届く。引数が足りない道具は失敗するが、それでも名乗る
			const result = await call(name, { device: 'iPhone 17', x: 1, y: 2, startX: 1, startY: 2, endX: 3, endY: 4, text: 'a', button: 'home', orientation: 'portrait', kind: 'long_press' });
			if (!result.text.includes('iPhone 17') || !result.text.includes(IPHONE_ID)) {
				unnamed.push(name);
			}
			// どの端末へ届いたかは、端末の口が受けたパスで見る
			if (paths.some(path => !path.includes(IPHONE_ID))) {
				wrongDevice.push(name);
			}
		}
		assert.deepStrictEqual({ tools: tools.length, unnamed, wrongDevice }, { tools: 16, unnamed: [], wrongDevice: [] });
	});

	test('the list shows every device of the pane and which one is current; the ledger keeps devices of other panes apart', async () => {
		const { service, call, paths } = setup();
		await service.attach(PANE, IPHONE_ID, 'space-1');
		await service.attach(PANE, ANDROID_ID, 'space-1');
		await service.attach(OTHER, IPAD_ID, undefined);
		const listed = (await call('mobile_list_devices', {})).structured as { devices: { id: string; attachedToThisPane: boolean; currentForThisPane?: boolean; usedByAnotherPane: boolean }[]; attachedToThisPane: object; attachedDevices: object[]; maxAttachedDevices: number; hint: string };
		const one = (await call('mobile_list_devices', {}, OTHER)).structured as { devices: { currentForThisPane?: boolean }[]; attachedDevices: object[]; hint?: string };
		paths.length = 0;
		const attached = (await call('mobile_get_attached_device', {})).structured as { id: string; runtime: string; attachedDevices: object[]; device: { id: string; note?: string } };
		const named = (await call('mobile_get_attached_device', { device: IPHONE_ID })).structured as { id: string; device: object };
		const foreign = await call('mobile_get_attached_device', { device: IPAD_ID });
		const snapshot = await service.getSnapshot();
		assert.deepStrictEqual({
			devices: listed.devices.slice(0, 3).map(device => [device.attachedToThisPane, device.currentForThisPane, device.usedByAnotherPane]),
			current: listed.attachedToThisPane,
			attachedDevices: listed.attachedDevices,
			max: listed.maxAttachedDevices,
			hint: listed.hint.includes('Pass "device"'),
			one: [one.attachedDevices, one.devices[0].currentForThisPane, one.hint],
			attached: [attached.id, attached.runtime, attached.attachedDevices.length, attached.device.id, attached.device.note !== undefined],
			named: [named.id, named.device],
			foreign: [foreign.isError, foreign.text.includes('is not attached to this terminal pane')],
			paths,
			snapshot: snapshot.attachments.map(attachment => [attachment.paneToken, attachment.deviceName, attachment.current === true]),
		}, {
			devices: [[true, false, false], [true, true, false], [false, false, true]],
			// 今までの形（今の端末 1 台）も残す
			current: { deviceId: ANDROID_ID, name: 'Para_Code_CLI_Test' },
			attachedDevices: [{ id: IPHONE_ID, name: 'iPhone 17', current: false }, { id: ANDROID_ID, name: 'Para_Code_CLI_Test', current: true }],
			max: 10,
			hint: true,
			// 1 台だけのペインでは、今までどおりの形（currentForThisPane・hint は出さない）
			one: [[{ id: IPAD_ID, name: 'iPad Air', current: true }], undefined, undefined],
			attached: [ANDROID_ID, 'Android 16', 2, ANDROID_ID, true],
			named: [IPHONE_ID, { id: IPHONE_ID, name: 'iPhone 17' }],
			foreign: [true, true],
			// ほかのペインの端末には、口へ何も送らない
			paths: [`GET /api/v1/devices/${ANDROID_ID}`, `GET /api/v1/devices/${IPHONE_ID}`],
			snapshot: [[PANE, 'iPhone 17', false], [PANE, 'Para_Code_CLI_Test', true], [OTHER, 'iPad Air', true]],
		});
	});

	test('the user can attach up to ten devices to a pane from the dialog, detach one of them, and closing the terminal detaches all', async () => {
		const { service } = setup();
		for (let index = 0; index < PARADIS_MOBILE_MAX_DEVICES_PER_PANE; index++) {
			await service.attach(PANE, `ios:extra-${index}`, undefined);
		}
		const eleventh = await service.attach(PANE, IPHONE_ID, undefined).then(() => 'attached', error => (error as Error).message);
		// 同じ端末をもう一度渡しても増えない
		const again = (await service.attach(PANE, 'ios:extra-3', undefined)).deviceId;
		const count = service.listPaneAttachments(PANE).length;
		const one = service.detach(PANE, 'ios:extra-3').map(attachment => attachment.deviceId);
		const afterOne = service.listPaneAttachments(PANE).length;
		const afterRoom = await service.attach(PANE, IPHONE_ID, undefined).then(attachment => attachment.deviceId);
		const all = service.detach(PANE).length;
		assert.deepStrictEqual({ eleventh, again, count, one, afterOne, afterRoom, all, left: service.listAttachments().length }, {
			eleventh: 'This terminal pane already has 10 devices attached. Detach one first.',
			again: 'ios:extra-3',
			count: 10,
			one: ['ios:extra-3'],
			afterOne: 9,
			afterRoom: IPHONE_ID,
			all: 10,
			left: 0,
		});
	});

	// 24 時間の掃除は端末ごと（使っている端末の割り当ては残り、使っていない端末だけが外れる）
	test('a device no tool used for a day is dropped while the one in use stays', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const { service, call } = setup();
			await service.attach(PANE, IPHONE_ID, undefined);
			await service.attach(PANE, ANDROID_ID, undefined);
			const hour = 60 * 60 * 1000;
			for (let hours = 0; hours < 30; hours++) {
				await clock.tickAsync(hour);
				await call('mobile_tap', { x: 1, y: 2, device: 'iPhone 17' });
			}
			assert.deepStrictEqual(service.listPaneAttachments(PANE).map(attachment => attachment.deviceName), ['iPhone 17']);
		} finally {
			clock.restore();
		}
	});
});
