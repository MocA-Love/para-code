/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// iOS のシミュレータについて、Mobile Canvas ホストの REST と同じ道に serve-sim と simctl で答えること（③、案A）と、
// 端末ごとの振り分け、mobile_fold。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMobileAttachment } from '../../../mobileCanvas/common/paradisMobileCanvas.js';
import { IParadisMobileHostRequester } from '../../../mobileCanvas/node/paradisMobileDeviceOpsToolProvider.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, ParadisSimulatorFold } from '../../common/paradisSimulator.js';
import { ParadisMobileHostRouter } from '../../node/paradisMobileHostRouter.js';
import { ParadisServeSimBackend } from '../../node/paradisServeSimBackend.js';
import { ParadisServeSimDeviceHost } from '../../node/paradisServeSimDeviceHost.js';
import { PARADIS_SIMULATOR_FOLD_TOOL, ParadisSimulatorFoldToolProvider } from '../../node/paradisSimulatorFoldTool.js';

const UDID = 'CA66CB4A-B18A-410E-AECB-D50C73A15A51';
const ID = `ios:core-simulator:${UDID}`;
const PATH = `/api/v1/devices/${encodeURIComponent(ID)}`;

function decode(frame: Uint8Array): [number, unknown] {
	return [frame[0], JSON.parse(new TextDecoder().decode(frame.subarray(1)))];
}

const AX = [{
	type: 'Application', role_description: 'application', AXLabel: 'Settings', AXValue: null, AXUniqueId: null, enabled: true, frame: { x: 0, y: 0, width: 402, height: 874 }, children: [
		{ type: 'Button', role_description: 'button', AXLabel: 'Sign in', AXValue: null, AXUniqueId: 'signin', enabled: true, frame: { x: 0, y: 0, width: 201, height: 437 }, children: [] },
	],
}];

class FakeBackend {
	readonly frames: [number, unknown][] = [];
	config: IParadisSimulatorScreenConfig = { width: 1206, height: 2622, orientation: 'portrait' };
	foldAccepted = true;
	devices: IParadisSimulatorDevice[] = [{ udid: UDID, name: 'iPhone 17', runtime: 'iOS 27.2', state: 'Booted' }];
	async listDevices(): Promise<IParadisSimulatorDevice[]> {
		return this.devices;
	}
	async getScreenConfig(): Promise<IParadisSimulatorScreenConfig> {
		return this.config;
	}
	async getAccessibilityTree(): Promise<unknown> {
		return AX;
	}
	async send(_udid: string, frame: Uint8Array): Promise<void> {
		this.frames.push(decode(frame));
	}
	async fold(_udid: string, fold: ParadisSimulatorFold): Promise<boolean> {
		if (this.foldAccepted) {
			this.config = { ...this.config, hingeDegrees: fold.kind === 'pose' ? (fold.pose === 'closed' ? 0 : fold.pose === 'book' ? 130 : 180) : fold.hinge };
		}
		return this.foldAccepted;
	}
}

interface ISimctlCall { readonly args: readonly string[]; readonly input?: string }

function setup() {
	const backend = new FakeBackend();
	const simctl: ISimctlCall[] = [];
	const host = new ParadisServeSimDeviceHost(backend as unknown as ParadisServeSimBackend, new NullLogService(), async (args, options) => {
		simctl.push({ args, ...(options.input !== undefined ? { input: options.input } : {}) });
		if (args[0] === 'io') {
			return new Uint8Array([0x89, 0x50]);
		}
		if (args[0] === 'spawn') {
			return 'line one com.example.app ready\nline two other\nline three com.example.app crash\n';
		}
		return '';
	}, async () => { });
	return { backend, simctl, host };
}

suite('Paradis simulator: serve-sim answers the Mobile Canvas REST for iOS', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists devices in the Mobile Canvas shape and describes one with its display', async () => {
		const { host } = setup();
		assert.deepStrictEqual({
			list: await host.listDevices(),
			one: await host.request('GET', PATH, undefined),
			display: await host.request('GET', `${PATH}/display`, undefined),
		}, {
			list: [{ id: ID, udid: UDID, name: 'iPhone 17', platform: 'ios', runtimeName: 'iOS 27.2', state: 'booted' }],
			one: { id: ID, udid: UDID, name: 'iPhone 17', platform: 'ios', runtimeName: 'iOS 27.2', state: 'booted', display: { pointWidth: 402, pointHeight: 874, pixelWidth: 1206, pixelHeight: 2622, scale: 3, orientation: 'portrait' }, foldable: false },
			display: { pointWidth: 402, pointHeight: 874, pixelWidth: 1206, pixelHeight: 2622, scale: 3, orientation: 'portrait' },
		});
	});

	// ポイント → 0〜1。ui_tap は見つけた要素の真ん中を押す
	test('turns taps, swipes, element taps and buttons into HID frames', async () => {
		const { host, backend } = setup();
		await host.request('POST', `${PATH}/input/tap`, { x: 201, y: 437 });
		const tapped = await host.request('POST', `${PATH}/ui/tap`, { text: 'sign in' });
		await host.request('POST', `${PATH}/input/button`, { button: 'home' });
		await host.request('POST', `${PATH}/input/rotate`, { orientation: 'landscape-left' });
		const unknownButton = await host.request('POST', `${PATH}/input/button`, { button: 'back' }).then(() => 'accepted', (error: Error) => error.message.startsWith('Unknown button "back"'));
		assert.deepStrictEqual({ frames: backend.frames, tapped: (tapped as { tapped: { identifier: string; center: unknown }; candidates: number }).tapped.center, unknownButton }, {
			frames: [
				[0x03, { type: 'begin', x: 0.5, y: 0.5 }],
				[0x03, { type: 'end', x: 0.5, y: 0.5 }],
				[0x03, { type: 'begin', x: 0.25, y: 0.25 }],
				[0x03, { type: 'end', x: 0.25, y: 0.25 }],
				[0x04, { button: 'home' }],
				[0x07, { orientation: 'landscape_left' }],
			],
			tapped: { x: 100.5, y: 218.5 },
			unknownButton: true,
		});
	});

	// 日本語はキーで打てないので、シミュレータのクリップボードへ写して Command+V で貼る
	test('types ASCII as keys and pastes other text', async () => {
		const { host, backend, simctl } = setup();
		const keys = await host.request('POST', `${PATH}/input/text`, { text: 'A' });
		const keyFrames = backend.frames.splice(0);
		const paste = await host.request('POST', `${PATH}/input/text`, { text: 'こんにちは' });
		assert.deepStrictEqual({ keys, keyFrames, paste, pasteFrames: backend.frames.map(([, body]) => body), simctl }, {
			keys: { method: 'keys' },
			keyFrames: [[0x06, { type: 'down', usage: 0xe1 }], [0x06, { type: 'down', usage: 0x04 }], [0x06, { type: 'up', usage: 0x04 }], [0x06, { type: 'up', usage: 0xe1 }]],
			paste: { method: 'paste' },
			pasteFrames: [{ type: 'down', usage: 0xe3 }, { type: 'down', usage: 0x19 }, { type: 'up', usage: 0x19 }, { type: 'up', usage: 0xe3 }],
			simctl: [{ args: ['pbcopy', UDID], input: 'こんにちは' }],
		});
	});

	// ピンチは指 0 → 指 1 の順に 1 本ずつ来る。指 1 のときに 2 本ぶんをまとめて送る
	test('pairs the two fingers of a pinch into multi-touch frames and reads the log', async () => {
		const { host, backend } = setup();
		for (const [fingerId, phase, x] of [[0, 'down', 100], [1, 'down', 300], [0, 'move', 80], [1, 'move', 320], [0, 'up', 80], [1, 'up', 320]] as const) {
			await host.request('POST', `${PATH}/input/touch`, { x, y: 437, phase, fingerId });
		}
		const log = await host.request('GET', `${PATH}/log?seconds=30&limit=500&bundleId=com.example.app`, undefined);
		assert.deepStrictEqual({ frames: backend.frames.map(([tag, body]) => [tag, (body as { type: string }).type]), log }, {
			frames: [[0x05, 'begin'], [0x05, 'move'], [0x05, 'end']],
			log: { seconds: 30, lines: ['line one com.example.app ready', 'line three com.example.app crash'], truncated: false },
		});
	});

	test('takes screenshots with simctl and refuses paths it does not know', async () => {
		const { host, simctl } = setup();
		const png = await host.requestBinary(`${PATH}/screenshot`);
		const unknown = await host.request('POST', `${PATH}/install`, {}).then(() => 'accepted', () => 'refused');
		const notOurs = await host.request('GET', '/api/v1/devices/android%3Aemulator-5554', undefined).then(() => 'accepted', () => 'refused');
		assert.deepStrictEqual({ png: [...png], simctl, unknown, notOurs }, { png: [0x89, 0x50], simctl: [{ args: ['io', UDID, 'screenshot', '--type=png', '-'] }], unknown: 'refused', notOurs: 'refused' });
	});
});

suite('Paradis simulator: routing the mobile tools per device', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function fakeCanvas(list: unknown[] | Error) {
		const calls: string[] = [];
		const canvas: IParadisMobileHostRequester = {
			async request(method, path) {
				calls.push(`${method} ${path}`);
				if (path === '/api/v1/devices') {
					if (list instanceof Error) {
						throw list;
					}
					return list;
				}
				return 'from-canvas';
			},
			async requestBinary(path) {
				calls.push(`BINARY ${path}`);
				return new Uint8Array();
			},
		};
		return { canvas, calls };
	}
	const IOS_CANVAS = { id: 'ios:core-simulator:B0000000-0000-0000-0000-000000000000', platform: 'ios', name: 'iPhone 16' };
	const ANDROID = { id: 'android:emulator-5554', platform: 'android', name: 'Pixel 9' };

	test('sends everything to Mobile Canvas while the setting is off', async () => {
		const { host } = setup();
		const { canvas, calls } = fakeCanvas([IOS_CANVAS, ANDROID]);
		const router = new ParadisMobileHostRouter(canvas, host, () => false, new NullLogService());
		assert.deepStrictEqual({ list: await router.request('GET', '/api/v1/devices'), one: await router.request('GET', PATH), calls }, {
			list: [IOS_CANVAS, ANDROID],
			one: 'from-canvas',
			calls: ['GET /api/v1/devices', `GET ${PATH}`],
		});
	});

	// iOS は serve-sim だけが受け持つ（Mobile Canvas の一覧の iOS は外す）。Mobile Canvas が使えなくても iOS は出る
	test('lists iOS from serve-sim and Android from Mobile Canvas while the setting is on', async () => {
		const { host } = setup();
		const { canvas, calls } = fakeCanvas([IOS_CANVAS, ANDROID]);
		const router = new ParadisMobileHostRouter(canvas, host, () => true, new NullLogService());
		const list = await router.request('GET', '/api/v1/devices') as { id: string }[];
		const androidCall = await router.request('POST', '/api/v1/devices/android%3Aemulator-5554/input/tap', { x: 1, y: 1 });
		const { canvas: broken } = fakeCanvas(new Error('Mobile Canvas is not installed'));
		const iosOnly = await new ParadisMobileHostRouter(broken, host, () => true, new NullLogService()).request('GET', '/api/v1/devices') as { id: string }[];
		assert.deepStrictEqual({ list: list.map(entry => entry.id), androidCall, calls, iosOnly: iosOnly.map(entry => entry.id) }, {
			list: [ID, ANDROID.id],
			androidCall: 'from-canvas',
			calls: ['GET /api/v1/devices', 'POST /api/v1/devices/android%3Aemulator-5554/input/tap'],
			iosOnly: [ID],
		});
	});
});

suite('Paradis simulator: mobile_fold', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// mobile_fold は 17 本とは別に固定する（設計書 4 節）
	test('keeps its name and input schema', () => {
		assert.deepStrictEqual({ name: PARADIS_SIMULATOR_FOLD_TOOL.name, inputSchema: PARADIS_SIMULATOR_FOLD_TOOL.inputSchema }, {
			name: 'mobile_fold',
			inputSchema: {
				type: 'object',
				properties: {
					pose: { type: 'string', enum: ['closed', 'book', 'open'] },
					angle: { type: 'number', description: 'Hinge angle in degrees, 0 (closed) to 180 (flat open).' },
				},
				additionalProperties: false,
			},
		});
	});

	function provider(attachment: IParadisMobileAttachment | undefined, enabled = true) {
		const { host, backend } = setup();
		const forgotten: string[] = [];
		const fold = new ParadisSimulatorFoldToolProvider({ getAttachment: () => attachment }, backend as unknown as ParadisServeSimBackend, host, id => forgotten.push(id), () => enabled, undefined);
		return { fold, backend, forgotten };
	}
	const attachment: IParadisMobileAttachment = { paneToken: 'pane-a', deviceId: ID, deviceName: 'iPhone Duo', stateKey: undefined, attachedAt: 0 };
	const textOf = (result: unknown) => (result as { content: { text: string }[]; isError?: boolean });

	test('folds the device of this pane only, and explains why it cannot', async () => {
		const duo = provider(attachment);
		duo.backend.config = { width: 2007, height: 2853, orientation: 'portrait', hingeDegrees: 180 };
		const closed = textOf(await duo.fold.callTool('pane-a', 'mobile_fold', { pose: 'closed' }));
		const both = textOf(await duo.fold.callTool('pane-a', 'mobile_fold', { pose: 'open', angle: 90 }));
		const flat = provider(attachment);
		const notFoldable = textOf(await flat.fold.callTool('pane-a', 'mobile_fold', { angle: 90 }));
		const refusedDuo = provider(attachment);
		refusedDuo.backend.config = { width: 2007, height: 2853, orientation: 'portrait', hingeDegrees: 180 };
		refusedDuo.backend.foldAccepted = false;
		const refused = textOf(await refusedDuo.fold.callTool('pane-a', 'mobile_fold', { pose: 'book' }));
		const none = textOf(await provider(undefined).fold.callTool('pane-a', 'mobile_fold', { pose: 'open' }));
		const off = provider(attachment, false);
		assert.deepStrictEqual({
			closed: JSON.parse(closed.content[0].text),
			forgotten: duo.forgotten,
			both: both.isError,
			notFoldable: [notFoldable.isError, notFoldable.content[0].text.includes('not a foldable')],
			refused: [refused.isError, refused.content[0].text.includes('Device Hub')],
			none: [none.isError, none.content[0].text.includes('No mobile device is attached')],
			hiddenWhenOff: off.fold.listTools().length,
			otherTool: await duo.fold.callTool('pane-a', 'mobile_tap', {}),
		}, {
			closed: { hingeDegrees: 0, activeDisplay: 'cover', screen: { pointWidth: 402, pointHeight: 874, scale: 3.3 } },
			forgotten: [ID],
			both: true,
			notFoldable: [true, true],
			refused: [true, true],
			none: [true, true],
			hiddenWhenOff: 0,
			otherTool: undefined,
		});
	});
});
