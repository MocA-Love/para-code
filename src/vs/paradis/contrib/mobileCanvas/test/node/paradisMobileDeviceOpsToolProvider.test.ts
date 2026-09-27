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
import { paradisDeviceHeldByAnotherPane } from '../../common/paradisMobileDeviceOps.js';
import { ParadisMobileCanvasHostClient } from '../../node/paradisMobileCanvasHostClient.js';
import { ParadisMobileCanvasService } from '../../node/paradisMobileCanvasService.js';
import { IParadisMobileCommandResult, IParadisMobileFileProbe, ParadisMobileDeviceCommands, paradisAdbCandidates } from '../../node/paradisMobileDeviceCommands.js';
import { IParadisMobileDeviceLedger, ParadisMobileDeviceOpsToolProvider } from '../../node/paradisMobileDeviceOpsToolProvider.js';

const PANE = 'pane-a';
const OTHER_PANE = 'pane-b';
const IOS_UDID = 'A1B2C3D4-0000-1111-2222-333344445555';
const ADB = '/Users/example/Library/Android/sdk/platform-tools/adb';

const IPHONE: IParadisMobileDevice = { id: 'ios:iphone', udid: IOS_UDID, name: 'iPhone 17', platform: 'iOS', runtime: 'iOS 26.5', state: 'Booted', isRunning: true };
const PIXEL: IParadisMobileDevice = { id: 'android:pixel', udid: 'emulator-5554', name: 'Pixel 9', platform: 'Android', state: 'device', isRunning: true };
const PIXEL_BY_SERIAL: IParadisMobileDevice = { id: 'android:serial:emulator-5554', udid: 'emulator-5554', name: 'emulator-5554', platform: 'Android', state: 'device', isRunning: true };
const IPAD: IParadisMobileDevice = { id: 'ios:ipad', udid: 'B1B2C3D4-0000-1111-2222-333344445555', name: 'iPad Air', platform: 'iOS', state: 'Shutdown', isRunning: false };

class FakeLedger implements IParadisMobileDeviceLedger {
	readonly attachments = new Map<string, IParadisMobileAttachment>();
	devices: IParadisMobileDevice[] = [IPHONE, PIXEL, PIXEL_BY_SERIAL, IPAD];

	getAttachment(paneToken: string): IParadisMobileAttachment | undefined {
		return this.attachments.get(paneToken);
	}
	listAttachments(): readonly IParadisMobileAttachment[] {
		return [...this.attachments.values()];
	}
	async listDevices(): Promise<IParadisMobileDevice[]> {
		return this.devices;
	}
	async attachIfFree(paneToken: string, deviceId: string, stateKey: string | undefined): Promise<IParadisMobileAttachment | undefined> {
		const device = this.devices.find(candidate => candidate.id === deviceId);
		if (!device || paradisDeviceHeldByAnotherPane(paneToken, device, this.devices, this.listAttachments())) {
			return undefined;
		}
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
	onTouch: (() => void) | undefined;
	async request(method: string, path: string, body?: unknown): Promise<unknown> {
		this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
		if (path.endsWith('/display')) {
			return this.display;
		}
		if (path.endsWith('/input/rotate')) {
			this.display = { pointWidth: 800, pointHeight: 400, scale: 3, orientation: 'landscape-left' };
		}
		if (path.endsWith('/input/touch')) {
			this.onTouch?.();
			if (this.failTouchAfter !== undefined && this.calls.filter(call => call.path.endsWith('/input/touch')).length > this.failTouchAfter) {
				throw new Error('touch rejected');
			}
		}
		return undefined;
	}
	inputs(): IHostCall[] {
		return this.calls.filter(call => !call.path.endsWith('/display'));
	}
}

interface IRun { readonly file: string; readonly args: readonly string[] }

const DANGEROUS = 'Dangerous Permissions:\n\ngroup:android.permission-group.CAMERA\n  permission:android.permission.CAMERA\n';
const LISTAPPS = '{\n    "com.apple.Preferences" =     {\n        ApplicationType = System;\n    };\n    "com.example.myapp" =     {\n        ApplicationType = User;\n    };\n}\n';

/** 端末の応答を真似る。`com.example.myapp` だけが利用者のアプリ、`com.android.settings` は OS のアプリ。 */
function deviceResponse(run: IRun): IParadisMobileCommandResult {
	const args = run.args.join(' ');
	if (run.file === '/usr/bin/plutil') {
		return { code: 0, stdout: 'com.example.myapp\n', stderr: '' };
	}
	if (args.includes('listapps')) {
		return { code: 0, stdout: LISTAPPS, stderr: '' };
	}
	if (args.includes('pm list packages -3')) {
		return { code: 0, stdout: 'package:com.example.myapp\n', stderr: '' };
	}
	if (args.includes('pm path')) {
		return { code: 0, stdout: args.endsWith('com.android.settings') ? 'package:/system/app/Settings.apk\n' : '', stderr: '' };
	}
	if (args.includes('pm list permissions')) {
		return { code: 0, stdout: DANGEROUS, stderr: '' };
	}
	if (args.includes('monkey')) {
		return { code: 0, stdout: 'Events injected: 1', stderr: '' };
	}
	return { code: 0, stdout: 'Success', stderr: '' };
}

class FakeRunner {
	readonly runs: IRun[] = [];
	respond: (run: IRun) => IParadisMobileCommandResult = deviceResponse;
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

const FILES = {
	'/Users/example/Build/My.app': 'directory',
	'/Users/example/Build/My.app/Info.plist': 'file',
	'/Users/example/Build/app.apk': 'file',
	'/Users/example/Build/Notes.txt': 'file',
	[ADB]: 'file',
} as const;

function text(result: unknown): { readonly isError: boolean; readonly body: string } {
	const value = result as { content: { text: string }[]; isError?: boolean };
	return { isError: value.isError === true, body: value.content[0].text };
}

interface ISetupOptions {
	readonly caller?: ParadisMcpCallerKind;
	readonly answer?: unknown;
	readonly installAnswer?: unknown;
	readonly onWindowCall?: (request: IParadisMcpOwningWindowRequest) => void;
}

suite('ParadisMobileDeviceOpsToolProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: ISetupOptions = {}) {
		const ledger = new FakeLedger();
		const host = new FakeHost();
		const runner = new FakeRunner();
		const windowCalls: IParadisMcpOwningWindowRequest[] = [];
		const files = fakeFiles({ ...FILES }, { '/Users/example/Build/Link.app': '/Users/example/Build/Notes.txt' });
		const commands = new ParadisMobileDeviceCommands(runner.run, files, {}, 'darwin', '/Users/example');
		const provider = new ParadisMobileDeviceOpsToolProvider(ledger, host, commands, new NullLogService(), async () => { });
		let callerChecks = 0;
		const context: IParadisMcpToolCallContext = {
			classifyCaller: async () => {
				callerChecks++;
				return options.caller ?? 'pane';
			},
			callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> => {
				windowCalls.push(request);
				options.onWindowCall?.(request);
				const answer = request.method === 'approveInstall' ? options.installAnswer : options.answer;
				return { ok: true, value: (answer ?? { outcome: 'approved', stateKey: 'space-1' }) as T };
			},
			getPaneAgentStatus: () => undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: () => false,
		};
		const call = async (name: string, args: object = {}, withContext = true) => text(await provider.callTool(PANE, name, args, undefined, withContext ? context : undefined));
		return { ledger, host, runner, windowCalls, provider, call, callerChecks: () => callerChecks };
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
				args: [PANE, { deviceId: 'ios:iphone', deviceName: 'iPhone 17', runtime: 'iOS 26.5', reason: 'check the login screen', replacingDeviceName: 'Pixel 9' }],
				timeoutMs: 55_000,
			}],
			attached: { paneToken: PANE, deviceId: 'ios:iphone', deviceName: 'iPhone 17', stateKey: 'space-1', attachedAt: 1 },
		});
	});

	test('request: refuses devices used by another pane (also under another id), SSH panes, unverified callers and unapproved answers without attaching', async () => {
		const outcomes: Record<string, { isError: boolean; windowCalls: number; attached: boolean; body?: string }> = {};
		const run = async (label: string, options: ISetupOptions, prepare?: (ledger: FakeLedger) => void, device = 'ios:iphone', keepBody = false) => {
			const { ledger, windowCalls, call } = setup(options);
			prepare?.(ledger);
			const result = await call('mobile_request_device', { device });
			outcomes[label] = { isError: result.isError, windowCalls: windowCalls.length, attached: ledger.getAttachment(PANE) !== undefined, ...(keepBody ? { body: JSON.parse(result.body).message } : {}) };
		};
		await run('usedByOtherPane', {}, ledger => ledger.give(OTHER_PANE, IPHONE));
		await run('sameSerialOtherId', {}, ledger => ledger.give(OTHER_PANE, PIXEL), 'android:serial:emulator-5554');
		await run('tunnel', { caller: 'tunnel' });
		await run('unverified', { caller: 'unverified' });
		await run('denied', { answer: { outcome: 'denied' } });
		await run('recentlyDenied', { answer: { outcome: 'recentlyDenied' } });
		await run('unanswered', { answer: { outcome: 'unanswered' } }, undefined, 'ios:iphone', true);
		await run('malformed', { answer: { outcome: 'approve' } });
		assert.deepStrictEqual(outcomes, {
			usedByOtherPane: { isError: true, windowCalls: 0, attached: false },
			sameSerialOtherId: { isError: true, windowCalls: 0, attached: false },
			tunnel: { isError: true, windowCalls: 0, attached: false },
			unverified: { isError: true, windowCalls: 0, attached: false },
			denied: { isError: false, windowCalls: 1, attached: false },
			recentlyDenied: { isError: true, windowCalls: 1, attached: false },
			unanswered: { isError: false, windowCalls: 1, attached: false, body: 'Para Code could not get a clear answer: the dialog was answered right after it appeared or with a keyboard shortcut. Ask the user to click a button in the dialog, then ask again.' },
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

	test('rotate and gestures work with the token alone, and only ever touch the device attached to this pane', async () => {
		const { ledger, host, runner, call, callerChecks } = setup({ caller: 'unverified' });
		const without = await call('mobile_rotate', { orientation: 'landscape-left' }, false);
		ledger.give(OTHER_PANE, PIXEL);
		ledger.give(PANE, IPHONE);
		// 端末を名指しする引数は受けない（スキーマにも無い）ので、渡されても割り当てられた端末だけが動く
		const rotated = await call('mobile_rotate', { orientation: 'landscape_left', deviceId: 'android:pixel' }, false);
		assert.deepStrictEqual({
			without: without.isError,
			rotated: rotated.isError,
			body: JSON.parse(rotated.body),
			hostPaths: host.inputs().map(entry => [entry.path, entry.body]),
			commands: runner.runs.length,
			callerChecks: callerChecks(),
		}, {
			without: true,
			rotated: false,
			body: { orientation: 'landscape-left', screen: { pointWidth: 800, pointHeight: 400, scale: 3 } },
			hostPaths: [['/api/v1/devices/ios%3Aiphone/input/rotate', { orientation: 'landscape-left' }]],
			commands: 0,
			callerChecks: 0,
		});
	});

	test('gestures: long press, a directional swipe with a bounded duration, and a pinch that always lifts both fingers', async () => {
		const { ledger, host, call } = setup();
		ledger.give(PANE, IPHONE);
		const longPress = await call('mobile_gesture', { kind: 'long_press', x: 100, y: 200, duration: 30 });
		const outside = await call('mobile_gesture', { kind: 'long_press', x: 500, y: 200 });
		const swipe = await call('mobile_gesture', { kind: 'swipe', direction: 'up', duration: 1e9 });
		const bodies = host.inputs().map(entry => (entry.body as { duration?: number }).duration);
		host.calls.length = 0;
		host.failTouchAfter = 3;
		const pinch = await call('mobile_gesture', { kind: 'pinch', scale: 2 });
		const touches = host.inputs().map(entry => entry.body as { phase: string; fingerId: number });
		assert.deepStrictEqual({
			errors: [longPress.isError, outside.isError, swipe.isError, pinch.isError],
			durations: bodies,
			touchPhases: touches.map(touch => `${touch.fingerId}:${touch.phase}`),
		}, {
			errors: [false, true, false, true],
			durations: [10, 10],
			// 2本下ろして1本動かしたところで失敗しても、2本とも上げる
			touchPhases: ['0:down', '1:down', '0:move', '1:move', '0:up', '1:up'],
		});
	});

	test('pinch: a finger whose request failed after the host accepted it is still lifted, and a cancellation says so', async () => {
		const failed = setup();
		failed.ledger.give(PANE, IPHONE);
		failed.host.failTouchAfter = 0;
		const failedResult = await failed.call('mobile_gesture', { kind: 'pinch', scale: 0.5 });

		const cancelled = setup();
		cancelled.ledger.give(PANE, IPHONE);
		const controller = new AbortController();
		cancelled.host.onTouch = () => {
			if (cancelled.host.calls.filter(entry => entry.path.endsWith('/input/touch')).length === 2) {
				controller.abort();
			}
		};
		const provider = cancelled.provider;
		const context = { classifyCaller: async () => 'pane' } as unknown as IParadisMcpToolCallContext;
		const cancelledResult = text(await provider.callTool(PANE, 'mobile_gesture', { kind: 'pinch', scale: 2 }, controller.signal, context));
		assert.deepStrictEqual({
			failed: [failedResult.isError, failed.host.inputs().map(entry => { const body = entry.body as { phase: string; fingerId: number }; return `${body.fingerId}:${body.phase}`; })],
			cancelled: [cancelledResult.body, cancelled.host.inputs().map(entry => (entry.body as { phase: string }).phase)],
		}, {
			failed: [true, ['0:down', '0:up']],
			cancelled: ['The gesture was cancelled.', ['down', 'down', 'up', 'up']],
		});
	});

	test('install: checks the path, asks the user every time with the resolved path, then calls simctl / adb with an argument array', async () => {
		const { ledger, runner, windowCalls, call } = setup();
		ledger.give(PANE, IPHONE);
		const results = {
			relative: (await call('mobile_install_app', { path: 'Build/My.app' })).isError,
			unc: (await call('mobile_install_app', { path: '//server/share/My.app' })).isError,
			missing: (await call('mobile_install_app', { path: '/Users/example/Build/Missing.app' })).isError,
			wrongType: (await call('mobile_install_app', { path: '/Users/example/Build/app.apk' })).isError,
			linkToText: (await call('mobile_install_app', { path: '/Users/example/Build/Link.app' })).isError,
			ios: JSON.parse((await call('mobile_install_app', { path: '/Users/example/Build/My.app/' })).body),
		};
		ledger.give(PANE, PIXEL);
		const android = await call('mobile_install_app', { path: '/Users/example/Build/app.apk' });
		assert.deepStrictEqual({
			results,
			android: android.isError,
			approvals: windowCalls.map(request => [request.method, request.args[1]]),
			runs: runner.runs,
		}, {
			results: {
				relative: true,
				unc: true,
				missing: true,
				wrongType: true,
				linkToText: true,
				ios: { installed: true, device: 'iPhone 17', path: '/Users/example/Build/My.app', appId: 'com.example.myapp' },
			},
			android: false,
			approvals: [
				['approveInstall', { deviceId: 'ios:iphone', deviceName: 'iPhone 17', path: '/Users/example/Build/My.app' }],
				['approveInstall', { deviceId: 'android:pixel', deviceName: 'Pixel 9', path: '/Users/example/Build/app.apk' }],
			],
			runs: [
				{ file: '/usr/bin/xcrun', args: ['simctl', 'install', IOS_UDID, '/Users/example/Build/My.app'] },
				{ file: '/usr/bin/plutil', args: ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Users/example/Build/My.app/Info.plist'] },
				{ file: ADB, args: ['-s', 'emulator-5554', 'install', '-r', '/Users/example/Build/app.apk'] },
			],
		});
	});

	test('install: nothing is installed when the user declines or the attached device changes while they answer', async () => {
		const declined = setup({ installAnswer: { outcome: 'denied' } });
		declined.ledger.give(PANE, IPHONE);
		const holder: { ledger?: FakeLedger } = {};
		const switched = setup({ onWindowCall: () => holder.ledger!.give(PANE, PIXEL) });
		holder.ledger = switched.ledger;
		switched.ledger.give(PANE, IPHONE);
		assert.deepStrictEqual([
			(await declined.call('mobile_install_app', { path: '/Users/example/Build/My.app' })).isError,
			(await switched.call('mobile_install_app', { path: '/Users/example/Build/My.app' })).isError,
			declined.runner.runs.length + switched.runner.runs.length,
		], [false, true, 0]);
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
			ssh.runner.runs.length + stopped.runner.runs.length + ssh.windowCalls.length,
		], [true, true, true, 0]);
	});

	test('Android launch and grant: validated ids, only apps the user installed, only runtime permissions', async () => {
		const { ledger, runner, call } = setup();
		ledger.give(PANE, PIXEL);
		const results = {
			launch: (await call('mobile_launch_app', { appId: 'com.example.myapp', relaunch: true })).isError,
			launchInjection: (await call('mobile_launch_app', { appId: 'com.example.app;reboot' })).isError,
			grantSystem: (await call('mobile_grant_permission', { appId: 'com.android.settings', permission: 'camera' })).isError,
			grantNotInstalled: (await call('mobile_grant_permission', { appId: 'com.example.missing', permission: 'camera' })).isError,
			grantUnknownPermission: (await call('mobile_grant_permission', { appId: 'com.example.myapp', permission: 'all' })).isError,
			grantDevelopmentPermission: (await call('mobile_grant_permission', { appId: 'com.example.myapp', permission: 'android.permission.WRITE_SECURE_SETTINGS' })).isError,
			grant: (await call('mobile_grant_permission', { appId: 'com.example.myapp', permission: 'camera' })).isError,
		};
		const serial = ['-s', 'emulator-5554', 'shell'];
		assert.deepStrictEqual({ results, runs: runner.runs.map(run => run.args.slice(3).join(' ')), files: [...new Set(runner.runs.map(run => run.file))], prefix: runner.runs.every(run => run.args.slice(0, 3).join() === serial.join()) }, {
			results: { launch: false, launchInjection: true, grantSystem: true, grantNotInstalled: true, grantUnknownPermission: true, grantDevelopmentPermission: true, grant: false },
			runs: [
				'am force-stop com.example.myapp',
				'monkey -p com.example.myapp -c android.intent.category.LAUNCHER 1',
				'pm list packages -3',
				'pm path com.android.settings',
				'pm list packages -3',
				'pm path com.example.missing',
				'pm list packages -3',
				'pm list permissions -g -d',
				'pm list packages -3',
				'pm list permissions -g -d',
				'pm grant com.example.myapp android.permission.CAMERA',
			],
			files: [ADB],
			prefix: true,
		});
	});

	test('iOS grant asks simctl listapps whether the app is the user\'s, then grants through simctl privacy', async () => {
		const { ledger, runner, call } = setup();
		ledger.give(PANE, IPHONE);
		const system = await call('mobile_grant_permission', { appId: 'com.apple.Preferences', permission: 'photos' });
		const granted = await call('mobile_grant_permission', { appId: 'com.example.myapp', permission: 'photos' });
		assert.deepStrictEqual([system.isError, granted.isError, runner.runs.map(run => run.args)], [true, false, [
			['simctl', 'listapps', IOS_UDID],
			['simctl', 'listapps', IOS_UDID],
			['simctl', 'privacy', IOS_UDID, 'grant', 'photos', 'com.example.myapp'],
		]]);
	});

	test('adb: SDK variables, the default SDK folder, then absolute PATH entries; a miss is not remembered', async () => {
		const found: Record<string, 'file'> = {};
		const commands = new ParadisMobileDeviceCommands(async () => ({ code: 0, stdout: 'package:com.example.myapp\n', stderr: '' }), { realpath: async path => path, kind: async path => found[path] }, { PATH: '/usr/local/bin:relative/bin' }, 'darwin', '/Users/example');
		const first = await commands.appKind('android', 'emulator-5554', 'com.example.myapp').then(() => 'ok', (error: Error) => error.message);
		found['/usr/local/bin/adb'] = 'file';
		const second = await commands.appKind('android', 'emulator-5554', 'com.example.myapp');
		assert.deepStrictEqual({
			candidates: [
				paradisAdbCandidates({ ANDROID_HOME: '/opt/sdk', ANDROID_SDK_ROOT: 'relative/sdk', PATH: '/usr/bin:bin' }, 'darwin', '/Users/example'),
				paradisAdbCandidates({}, 'linux', '/home/example'),
			],
			first,
			second,
		}, {
			candidates: [
				['/opt/sdk/platform-tools/adb', '/Users/example/Library/Android/sdk/platform-tools/adb', '/usr/bin/adb'],
				['/home/example/Android/Sdk/platform-tools/adb'],
			],
			first: 'Para Code could not find adb. Install the Android SDK platform-tools, or set ANDROID_HOME for Para Code, and try again.',
			second: 'user',
		});
	});
});

suite('ParadisMobileCanvasService screen tools', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('screen input works with the token alone, and an agent request cannot take a device another pane holds', async () => {
		const requests: string[] = [];
		const hostClient = {
			request: async (_method: string, path: string) => {
				requests.push(path);
				return path === '/api/v1/devices'
					? [{ id: 'ios:iphone', udid: IOS_UDID, name: 'iPhone 17', platform: 'iOS', state: 'Booted' }, { id: 'ios:alias', udid: IOS_UDID, name: 'iPhone 17 (alias)', platform: 'iOS', state: 'Booted' }]
					: {};
			},
		} as unknown as ParadisMobileCanvasHostClient;
		const service = store.add(new ParadisMobileCanvasService(hostClient, new NullLogService()));
		await service.attach(PANE, 'ios:iphone', undefined);
		const tap = await service.callTool(PANE, 'mobile_tap', { x: 1, y: 2 }) as { isError?: boolean };
		const listed = JSON.parse((await service.callTool(OTHER_PANE, 'mobile_list_devices', {}) as { content: { text: string }[] }).content[0].text) as { devices: { id: string; usedByAnotherPane: boolean }[] };
		assert.deepStrictEqual({
			tap: tap.isError === true,
			taps: requests.filter(path => path.endsWith('/input/tap')).length,
			listed: listed.devices.map(device => [device.id, device.usedByAnotherPane]),
			sameDevice: await service.attachIfFree(OTHER_PANE, 'ios:iphone', undefined),
			aliasOfSameDevice: await service.attachIfFree(OTHER_PANE, 'ios:alias', undefined),
			ownPane: (await service.attachIfFree(PANE, 'ios:alias', 'space-1'))?.deviceId,
		}, {
			tap: false,
			taps: 1,
			listed: [['ios:iphone', true], ['ios:alias', true]],
			sameDevice: undefined,
			aliasOfSameDevice: undefined,
			ownPane: 'ios:alias',
		});
	});
});
