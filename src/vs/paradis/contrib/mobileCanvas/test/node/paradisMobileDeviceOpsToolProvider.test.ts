/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpToolCallContext, ParadisMcpCallerKind, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisMobileAttachment, IParadisMobileDevice } from '../../common/paradisMobileCanvas.js';
import { ParadisMobileCanvasHostClient } from '../../node/paradisMobileCanvasHostClient.js';
import { ParadisMobileCanvasService } from '../../node/paradisMobileCanvasService.js';
import { IParadisMobileCommandResult, IParadisMobileFileProbe, ParadisMobileDeviceCommands, paradisAdbCandidates } from '../../node/paradisMobileDeviceCommands.js';
import { IParadisMobileDeviceLedger, ParadisMobileDeviceOpsToolProvider } from '../../node/paradisMobileDeviceOpsToolProvider.js';

const PANE = 'pane-a';
const OTHER_PANE = 'pane-b';
const IOS_UDID = 'A1B2C3D4-0000-1111-2222-333344445555';

const IPHONE: IParadisMobileDevice = { id: 'ios:iphone', udid: IOS_UDID, name: 'iPhone 17', platform: 'iOS', runtime: 'iOS 26.5', state: 'Booted', isRunning: true };
const PIXEL: IParadisMobileDevice = { id: 'android:pixel', udid: 'emulator-5554', name: 'Pixel 9', platform: 'Android', state: 'device', isRunning: true };
const IPAD: IParadisMobileDevice = { id: 'ios:ipad', udid: 'B1B2C3D4-0000-1111-2222-333344445555', name: 'iPad Air', platform: 'iOS', state: 'Shutdown', isRunning: false };

class FakeLedger implements IParadisMobileDeviceLedger {
	readonly attachments = new Map<string, IParadisMobileAttachment>();
	devices: IParadisMobileDevice[] = [IPHONE, PIXEL, IPAD];

	getAttachment(paneToken: string): IParadisMobileAttachment | undefined {
		return this.attachments.get(paneToken);
	}
	listAttachments(): readonly IParadisMobileAttachment[] {
		return [...this.attachments.values()];
	}
	async listDevices(): Promise<IParadisMobileDevice[]> {
		return this.devices;
	}
	async attach(paneToken: string, deviceId: string, stateKey: string | undefined): Promise<IParadisMobileAttachment> {
		const device = this.devices.find(candidate => candidate.id === deviceId)!;
		const attachment = { paneToken, deviceId, deviceName: device.name, stateKey, attachedAt: 1 };
		this.attachments.set(paneToken, attachment);
		return attachment;
	}
	give(paneToken: string, device: IParadisMobileDevice): void {
		this.attachments.set(paneToken, { paneToken, deviceId: device.id, deviceName: device.name, stateKey: undefined, attachedAt: 0 });
	}
}

interface IHostCall { readonly method: string; readonly path: string; readonly body?: unknown }

class FakeHost {
	readonly calls: IHostCall[] = [];
	display: object = { pointWidth: 400, pointHeight: 800, scale: 3, orientation: 'portrait' };
	failTouchAfter: number | undefined;
	async request(method: string, path: string, body?: unknown): Promise<unknown> {
		this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
		if (path.endsWith('/display')) {
			return this.display;
		}
		if (path.endsWith('/input/rotate')) {
			this.display = { pointWidth: 800, pointHeight: 400, scale: 3, orientation: 'landscape-left' };
		}
		if (path.endsWith('/input/touch') && this.failTouchAfter !== undefined && this.calls.filter(call => call.path.endsWith('/input/touch')).length > this.failTouchAfter) {
			throw new Error('touch rejected');
		}
		return undefined;
	}
	inputs(): IHostCall[] {
		return this.calls.filter(call => !call.path.endsWith('/display'));
	}
}

interface IRun { readonly file: string; readonly args: readonly string[] }

class FakeRunner {
	readonly runs: IRun[] = [];
	respond: (run: IRun) => IParadisMobileCommandResult = () => ({ code: 0, stdout: '', stderr: '' });
	readonly run = async (file: string, args: readonly string[]): Promise<IParadisMobileCommandResult> => {
		const run = { file, args: [...args] };
		this.runs.push(run);
		return this.respond(run);
	};
}

/** 実在するものの表（パス → 種類）と、シンボリックリンク（パス → 実体）。 */
function fakeFiles(entries: Record<string, 'file' | 'directory'>, links: Record<string, string> = {}): IParadisMobileFileProbe {
	return {
		realpath: async path => {
			const real = links[path] ?? path.replace(/\/+$/, '');
			if (!entries[real]) {
				throw new Error('ENOENT');
			}
			return real;
		},
		kind: async path => entries[path],
	};
}

function text(result: unknown): { readonly isError: boolean; readonly body: string } {
	const value = result as { content: { text: string }[]; isError?: boolean };
	return { isError: value.isError === true, body: value.content[0].text };
}

suite('ParadisMobileDeviceOpsToolProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { caller?: ParadisMcpCallerKind; answer?: unknown; files?: IParadisMobileFileProbe; onWindowCall?: () => void } = {}) {
		const ledger = new FakeLedger();
		const host = new FakeHost();
		const runner = new FakeRunner();
		const windowCalls: IParadisMcpOwningWindowRequest[] = [];
		const files = options.files ?? fakeFiles({
			'/Users/example/Build/My.app': 'directory',
			'/Users/example/Build/My.app/Info.plist': 'file',
			'/Users/example/Build/app.apk': 'file',
			'/Users/example/Build/Notes.txt': 'file',
			'/Users/example/Library/Android/sdk/platform-tools/adb': 'file',
		}, { '/Users/example/Build/Link.app': '/Users/example/Build/Notes.txt' });
		const commands = new ParadisMobileDeviceCommands(runner.run, files, {}, 'darwin', '/Users/example');
		const provider = new ParadisMobileDeviceOpsToolProvider(ledger, host, commands, new NullLogService(), async () => { });
		const context: IParadisMcpToolCallContext = {
			classifyCaller: async () => options.caller ?? 'pane',
			callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> => {
				windowCalls.push(request);
				options.onWindowCall?.();
				return { ok: true, value: (options.answer ?? { outcome: 'approved', stateKey: 'space-1' }) as T };
			},
			getPaneAgentStatus: () => undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: () => false,
		};
		const call = async (name: string, args: object = {}) => text(await provider.callTool(PANE, name, args, undefined, context));
		return { ledger, host, runner, windowCalls, provider, context, call };
	}

	test('ignores tools it does not own', async () => {
		const { provider } = setup();
		assert.strictEqual(await provider.callTool(PANE, 'mobile_tap', {}), undefined);
	});

	test('request: asks the owning window, then attaches with the space it reported', async () => {
		const { ledger, windowCalls, call } = setup();
		ledger.give(PANE, PIXEL);
		const result = await call('mobile_request_device', { device: 'iPhone 17', reason: 'check the login screen' });
		assert.deepStrictEqual({
			isError: result.isError,
			window: windowCalls.map(request => ({ channel: request.channelName, method: request.method, args: request.args, timeoutMs: request.timeoutMs })),
			attached: ledger.getAttachment(PANE),
		}, {
			isError: false,
			window: [{
				channel: 'paradisMobileDeviceRequest',
				method: 'requestDevice',
				args: [PANE, { deviceName: 'iPhone 17', runtime: 'iOS 26.5', reason: 'check the login screen', replacingDeviceName: 'Pixel 9' }],
				timeoutMs: 55_000,
			}],
			attached: { paneToken: PANE, deviceId: 'ios:iphone', deviceName: 'iPhone 17', stateKey: 'space-1', attachedAt: 1 },
		});
	});

	test('request: refuses devices used by another pane, SSH panes, unverified callers and declined requests without attaching', async () => {
		const outcomes: Record<string, { isError: boolean; windowCalls: number; attached: boolean }> = {};
		const run = async (label: string, options: Parameters<typeof setup>[0], prepare?: (ledger: FakeLedger) => void) => {
			const { ledger, windowCalls, call } = setup(options);
			prepare?.(ledger);
			const result = await call('mobile_request_device', { device: 'ios:iphone' });
			outcomes[label] = { isError: result.isError, windowCalls: windowCalls.length, attached: ledger.getAttachment(PANE) !== undefined };
		};
		await run('usedByOtherPane', {}, ledger => ledger.give(OTHER_PANE, IPHONE));
		await run('tunnel', { caller: 'tunnel' });
		await run('unverified', { caller: 'unverified' });
		await run('denied', { answer: { outcome: 'denied' } });
		await run('recentlyDenied', { answer: { outcome: 'recentlyDenied' } });
		await run('malformed', { answer: { outcome: 'approve' } });
		assert.deepStrictEqual(outcomes, {
			usedByOtherPane: { isError: true, windowCalls: 0, attached: false },
			tunnel: { isError: true, windowCalls: 0, attached: false },
			unverified: { isError: true, windowCalls: 0, attached: false },
			denied: { isError: false, windowCalls: 1, attached: false },
			recentlyDenied: { isError: true, windowCalls: 1, attached: false },
			malformed: { isError: false, windowCalls: 1, attached: false },
		});
	});

	test('request: does not take a device that another pane got while the user was answering', async () => {
		const holder: { ledger?: FakeLedger } = {};
		const { ledger, call } = setup({ onWindowCall: () => holder.ledger!.give(OTHER_PANE, IPHONE) });
		holder.ledger = ledger;
		const result = await call('mobile_request_device', { device: 'ios:iphone' });
		assert.deepStrictEqual([result.isError, ledger.getAttachment(PANE)], [true, undefined]);
	});

	test('operations need a device attached to this pane and only ever touch that device', async () => {
		const { ledger, host, runner, call } = setup();
		const without = await call('mobile_rotate', { orientation: 'landscape-left' });
		ledger.give(OTHER_PANE, PIXEL);
		ledger.give(PANE, IPHONE);
		// 端末を名指しする引数は受けない（スキーマにも無い）ので、渡されても割り当てられた端末だけが動く
		const rotated = await call('mobile_rotate', { orientation: 'landscape_left', deviceId: 'android:pixel' });
		assert.deepStrictEqual({
			without: without.isError,
			rotated: rotated.isError,
			body: JSON.parse(rotated.body),
			hostPaths: host.inputs().map(call => [call.path, call.body]),
			commands: runner.runs.length,
		}, {
			without: true,
			rotated: false,
			body: { orientation: 'landscape-left', screen: { pointWidth: 800, pointHeight: 400, scale: 3 } },
			hostPaths: [['/api/v1/devices/ios%3Aiphone/input/rotate', { orientation: 'landscape-left' }]],
			commands: 0,
		});
	});

	test('gestures: long press, directional swipe and a pinch that always lifts both fingers', async () => {
		const { ledger, host, call } = setup({ caller: 'tunnel' });
		ledger.give(PANE, IPHONE);
		const longPress = await call('mobile_gesture', { kind: 'long_press', x: 100, y: 200, duration: 30 });
		const outside = await call('mobile_gesture', { kind: 'long_press', x: 500, y: 200 });
		const swipe = await call('mobile_gesture', { kind: 'swipe', direction: 'up' });
		host.calls.length = 0;
		host.failTouchAfter = 3;
		const pinch = await call('mobile_gesture', { kind: 'pinch', scale: 2 });
		const touches = host.inputs().map(entry => entry.body as { phase: string; fingerId: number });
		assert.deepStrictEqual({
			errors: [longPress.isError, outside.isError, swipe.isError, pinch.isError],
			touchPhases: touches.map(touch => `${touch.fingerId}:${touch.phase}`),
		}, {
			errors: [false, true, false, true],
			// 2本下ろして1本動かしたところで失敗しても、2本とも上げる
			touchPhases: ['0:down', '1:down', '0:move', '1:move', '0:up', '1:up'],
		});
	});

	test('install: checks the path, its type and the platform, then calls simctl / adb with an argument array', async () => {
		const { ledger, runner, call } = setup();
		ledger.give(PANE, IPHONE);
		runner.respond = run => run.file === '/usr/bin/plutil' ? { code: 0, stdout: 'com.example.myapp\n', stderr: '' } : { code: 0, stdout: 'Success', stderr: '' };
		const results = {
			relative: (await call('mobile_install_app', { path: 'Build/My.app' })).isError,
			missing: (await call('mobile_install_app', { path: '/Users/example/Build/Missing.app' })).isError,
			wrongType: (await call('mobile_install_app', { path: '/Users/example/Build/app.apk' })).isError,
			linkToText: (await call('mobile_install_app', { path: '/Users/example/Build/Link.app' })).isError,
			ios: JSON.parse((await call('mobile_install_app', { path: '/Users/example/Build/My.app/' })).body),
		};
		ledger.give(PANE, PIXEL);
		const android = await call('mobile_install_app', { path: '/Users/example/Build/app.apk' });
		assert.deepStrictEqual({ results, android: android.isError, runs: runner.runs }, {
			results: {
				relative: true,
				missing: true,
				wrongType: true,
				linkToText: true,
				ios: { installed: true, device: 'iPhone 17', path: '/Users/example/Build/My.app', appId: 'com.example.myapp' },
			},
			android: false,
			runs: [
				{ file: '/usr/bin/xcrun', args: ['simctl', 'install', IOS_UDID, '/Users/example/Build/My.app'] },
				{ file: '/usr/bin/plutil', args: ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Users/example/Build/My.app/Info.plist'] },
				{ file: '/Users/example/Library/Android/sdk/platform-tools/adb', args: ['-s', 'emulator-5554', 'install', '-r', '/Users/example/Build/app.apk'] },
			],
		});
	});

	test('install and launch refuse SSH panes and devices that are not running', async () => {
		const ssh = setup({ caller: 'tunnel' });
		ssh.ledger.give(PANE, IPHONE);
		const stopped = setup();
		stopped.ledger.give(PANE, IPAD);
		assert.deepStrictEqual([
			(await ssh.call('mobile_install_app', { path: '/Users/example/Build/My.app' })).isError,
			(await ssh.call('mobile_launch_app', { appId: 'com.example.myapp' })).isError,
			(await stopped.call('mobile_launch_app', { appId: 'com.example.myapp' })).isError,
			ssh.runner.runs.length + stopped.runner.runs.length,
		], [true, true, true, 0]);
	});

	test('launch and grant: validated ids, only installed non-system apps, one permission', async () => {
		const { ledger, runner, call } = setup();
		ledger.give(PANE, PIXEL);
		runner.respond = run => run.args.includes('path') && run.args.includes('com.example.missing')
			? { code: 0, stdout: '', stderr: '' }
			: { code: 0, stdout: run.args.includes('path') ? 'package:/data/app/base.apk\n' : 'Events injected: 1', stderr: '' };
		const results = {
			launch: (await call('mobile_launch_app', { appId: 'com.example.myapp', relaunch: true })).isError,
			launchInjection: (await call('mobile_launch_app', { appId: 'com.example.app;reboot' })).isError,
			grantSystem: (await call('mobile_grant_permission', { appId: 'com.android.settings', permission: 'camera' })).isError,
			grantUnknownPermission: (await call('mobile_grant_permission', { appId: 'com.example.myapp', permission: 'all' })).isError,
			grantNotInstalled: (await call('mobile_grant_permission', { appId: 'com.example.missing', permission: 'camera' })).isError,
			grant: (await call('mobile_grant_permission', { appId: 'com.example.myapp', permission: 'camera' })).isError,
		};
		const adb = '/Users/example/Library/Android/sdk/platform-tools/adb';
		assert.deepStrictEqual({ results, runs: runner.runs }, {
			results: { launch: false, launchInjection: true, grantSystem: true, grantUnknownPermission: true, grantNotInstalled: true, grant: false },
			runs: [
				{ file: adb, args: ['-s', 'emulator-5554', 'shell', 'am', 'force-stop', 'com.example.myapp'] },
				{ file: adb, args: ['-s', 'emulator-5554', 'shell', 'monkey', '-p', 'com.example.myapp', '-c', 'android.intent.category.LAUNCHER', '1'] },
				{ file: adb, args: ['-s', 'emulator-5554', 'shell', 'pm', 'path', 'com.example.missing'] },
				{ file: adb, args: ['-s', 'emulator-5554', 'shell', 'pm', 'path', 'com.example.myapp'] },
				{ file: adb, args: ['-s', 'emulator-5554', 'shell', 'pm', 'grant', 'com.example.myapp', 'android.permission.CAMERA'] },
			],
		});
	});

	test('iOS grant goes through simctl privacy for that device and that app', async () => {
		const { ledger, runner, call } = setup();
		ledger.give(PANE, IPHONE);
		runner.respond = run => ({ code: 0, stdout: run.args.includes('get_app_container') ? '/path/to/My.app\n' : '', stderr: '' });
		const result = await call('mobile_grant_permission', { appId: 'com.example.myapp', permission: 'photos' });
		assert.deepStrictEqual([result.isError, runner.runs.map(run => run.args)], [false, [
			['simctl', 'get_app_container', IOS_UDID, 'com.example.myapp', 'app'],
			['simctl', 'privacy', IOS_UDID, 'grant', 'photos', 'com.example.myapp'],
		]]);
	});

	test('adb candidates follow the SDK variables, then the default SDK folder', () => {
		assert.deepStrictEqual([
			paradisAdbCandidates({ ANDROID_HOME: '/opt/sdk', ANDROID_SDK_ROOT: 'relative/sdk' }, 'darwin', '/Users/example'),
			paradisAdbCandidates({}, 'linux', '/home/example'),
		], [
			['/opt/sdk/platform-tools/adb', '/Users/example/Library/Android/sdk/platform-tools/adb'],
			['/home/example/Android/Sdk/platform-tools/adb'],
		]);
	});
});

suite('ParadisMobileCanvasService caller check', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('state-changing tools refuse unverified callers; reading tools and SSH panes keep working', async () => {
		const requests: string[] = [];
		const hostClient = {
			request: async (_method: string, path: string) => {
				requests.push(path);
				return path === '/api/v1/devices' ? [{ id: 'ios:iphone', name: 'iPhone 17', platform: 'iOS', state: 'Booted' }] : {};
			},
		} as unknown as ParadisMobileCanvasHostClient;
		const service = store.add(new ParadisMobileCanvasService(hostClient, new NullLogService()));
		await service.attach(PANE, 'ios:iphone', undefined);
		const context = (caller: ParadisMcpCallerKind) => ({ classifyCaller: async () => caller }) as unknown as IParadisMcpToolCallContext;
		const tap = async (caller: ParadisMcpCallerKind | undefined) => (await service.callTool(PANE, 'mobile_tap', { x: 1, y: 2 }, undefined, caller ? context(caller) : undefined) as { isError?: boolean }).isError === true;
		const results = {
			unverified: await tap('unverified'),
			noContext: await tap(undefined),
			tunnel: await tap('tunnel'),
			pane: await tap('pane'),
			readUnverified: (await service.callTool(PANE, 'mobile_ui_snapshot', {}, undefined, context('unverified')) as { isError?: boolean }).isError === true,
		};
		assert.deepStrictEqual({ results, taps: requests.filter(path => path.endsWith('/input/tap')).length }, {
			results: { unverified: true, noContext: true, tunnel: false, pane: false, readUnverified: false },
			taps: 2,
		});
	});
});
