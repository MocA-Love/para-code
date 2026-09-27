/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エミュレータ操作の追加（B13）。para-browser MCP へ、登録口（paradisRegisterMcpToolProvider）から足す。
//
//  - mobile_request_device: 端末を「エージェントが要求 → 利用者が承認」で割り当てる（Q71 の回答 A）。
//    承認ダイアログはページ共有の承認と同じもの（renderer の IParadisAgentBrowserTabsService.askApproval）を使う
//  - mobile_rotate / mobile_gesture: 回転・スワイプ（向きの指定）・長押し・ピンチ。Mobile Canvas ホストへの入力
//  - mobile_install_app / mobile_launch_app / mobile_grant_permission: `xcrun simctl` / `adb` を引数配列で呼ぶ
//
// どのツールも端末の ID を引数に取らず、そのペインに割り当てられた端末だけを台帳から引く
// （既存の mobile_tap などと同じ）。要求だけは端末を名指しするが、ほかのペインが使っている端末は断る。
//
// 接続元の確認: 状態を変える操作はすべて `context.classifyCaller()` を通す。SSH の接続先のペイン（`tunnel`）は、
// 既存の方針（利用者がダイアログでそのペインに渡した端末は、画面の入力で操作できる）に合わせて回転と
// ジェスチャーだけ通す。要求・インストール・起動・権限の付与は SSH の接続先からは断る（方針が無いため）。

import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, ParadisMcpCallerKind } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisMobileAttachment, IParadisMobileDevice } from '../common/paradisMobileCanvas.js';
import {
	IParadisMobileDeviceRequestPrompt,
	IParadisPoint,
	IParadisPointSize,
	PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
	PARADIS_MOBILE_DEVICE_REQUEST_METHOD,
	ParadisMobileOrientation,
	ParadisMobilePlatform,
	paradisIsInsideScreen,
	paradisIsSystemAppId,
	paradisIsValidAppId,
	paradisIsValidNativeDeviceId,
	paradisMobilePermissionNames,
	paradisMobilePlatformOf,
	paradisNormalizeOrientation,
	paradisParseDisplaySize,
	paradisParseMobileDeviceRequestAnswer,
	paradisParseSwipeDirection,
	paradisPinchFrames,
	paradisResolveMobilePermission,
	paradisSwipeEndpoints,
} from '../common/paradisMobileDeviceOps.js';
import { ParadisMobileDeviceCommands } from './paradisMobileDeviceCommands.js';

/** 端末の割り当て台帳のうち、このプロバイダが使う部分（ParadisMobileCanvasService が満たす）。 */
export interface IParadisMobileDeviceLedger {
	/** そのペインの割り当て（ツールの利用として最終利用時刻も進める）。 */
	getAttachment(paneToken: string): IParadisMobileAttachment | undefined;
	listAttachments(): readonly IParadisMobileAttachment[];
	listDevices(signal?: AbortSignal): Promise<IParadisMobileDevice[]>;
	attach(paneToken: string, deviceId: string, stateKey: string | undefined, signal?: AbortSignal): Promise<IParadisMobileAttachment>;
}

/** Mobile Canvas ホストの REST（ParadisMobileCanvasHostClient が満たす）。 */
export interface IParadisMobileHostRequester {
	request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
}

export type ParadisMobileSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: ParadisMobileSleep = (ms, signal) => new Promise<void>(resolve => {
	if (signal?.aborted) {
		resolve();
		return;
	}
	const timer = setTimeout(() => {
		signal?.removeEventListener('abort', onAbort);
		resolve();
	}, ms);
	const onAbort = () => {
		clearTimeout(timer);
		resolve();
	};
	signal?.addEventListener('abort', onAbort, { once: true });
});

const NO_DEVICE_ATTACHED_MESSAGE = 'No mobile device is attached to this terminal pane. Call mobile_request_device to ask the user for one (or ask them to attach it from Para Code), then try again.';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so it refuses to change the device. Start this agent CLI from a terminal inside Para Code.';
const SSH_REFUSED_MESSAGE = 'This terminal pane runs on an SSH host. Para Code does not let an agent on an SSH host request a device on this computer, install apps, launch apps or grant permissions there. Ask the user to do it on this computer.';
const REQUEST_TIMEOUT_MESSAGE = 'The user did not answer in time, so the device was not attached. Ask the user in the conversation before requesting it again.';

/** 回転の後、画面の寸法が新しい向きに変わるのを待つ回数と間隔（ホストは寸法が変わる前に応答する）。 */
const ROTATE_SETTLE_ATTEMPTS = 20;
const ROTATE_SETTLE_INTERVAL_MS = 100;
/** ピンチの指を動かす回数と間隔。 */
const PINCH_STEPS = 12;
const PINCH_STEP_INTERVAL_MS = 16;
const LONG_PRESS_DEFAULT_SECONDS = 1;
const LONG_PRESS_MAX_SECONDS = 10;

export const PARADIS_MOBILE_DEVICE_OPS_TOOLS: readonly IParadisMcpToolDefinition[] = [
	{
		name: 'mobile_request_device',
		description: 'Ask the user to attach a mobile device (iOS simulator or Android emulator on this computer) to this terminal pane. Para Code shows the user an approval dialog and attaches the device only if they approve. Call mobile_list_devices first and pass the id or the exact name of a device. You cannot request a device that another terminal pane is using. If this pane already has a different device, approving replaces it. If the user declines, do not ask again straight away: Para Code turns down further requests from this pane for a few minutes.',
		inputSchema: {
			type: 'object',
			properties: {
				device: { type: 'string', description: 'The id or the exact name of the device, as returned by mobile_list_devices.' },
				reason: { type: 'string', description: 'One short sentence shown to the user explaining why you need the device.' },
			},
			required: ['device'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	},
	{
		name: 'mobile_rotate',
		description: 'Rotate the mobile device attached to this terminal pane. Returns the new screen size in points: every coordinate you pass to input tools afterwards must use this new size.',
		inputSchema: {
			type: 'object',
			properties: {
				orientation: { type: 'string', enum: ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'] },
			},
			required: ['orientation'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	},
	{
		name: 'mobile_gesture',
		description: 'Perform a gesture on the mobile device attached to this terminal pane. Coordinates are in POINTS (not screenshot pixels). kind="swipe" moves one finger in a direction ("up" moves the finger upwards, which scrolls a list down) from x/y (default: the centre of the screen) by distance points. kind="long_press" presses and holds at x/y for duration seconds (default 1). kind="pinch" moves two fingers around x/y (default: the centre): scale greater than 1 spreads them apart (zoom in), less than 1 brings them together (zoom out).',
		inputSchema: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['swipe', 'long_press', 'pinch'] },
				x: { type: 'number', description: 'Horizontal coordinate in device points.' },
				y: { type: 'number', description: 'Vertical coordinate in device points.' },
				direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'swipe only.' },
				distance: { type: 'number', description: 'swipe only: how far to move, in points. Defaults to 40% of the shorter side of the screen.' },
				duration: { type: 'number', description: 'Seconds. long_press: how long to hold (default 1, at most 10). swipe: how long the movement takes.' },
				scale: { type: 'number', description: 'pinch only: between 0.2 and 5. 2 doubles the distance between the fingers, 0.5 halves it.' },
			},
			required: ['kind'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	},
	{
		name: 'mobile_install_app',
		description: 'Install an app you built onto the mobile device attached to this terminal pane. path must be an absolute path on this computer: a .app bundle (or an .ipa) for an iOS simulator, an .apk for an Android emulator. An app that is already installed is replaced and keeps its data. Returns the bundle id when Para Code can read it, so you can pass it to mobile_launch_app.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute path to the .app bundle, .ipa or .apk on this computer.' },
			},
			required: ['path'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
	},
	{
		name: 'mobile_launch_app',
		description: 'Launch an installed app on the mobile device attached to this terminal pane.',
		inputSchema: {
			type: 'object',
			properties: {
				appId: { type: 'string', description: 'The bundle id (iOS) or package name (Android), for example "com.example.myapp".' },
				relaunch: { type: 'boolean', description: 'Stop the app first if it is already running, so it starts fresh.' },
			},
			required: ['appId'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	},
	{
		name: 'mobile_grant_permission',
		description: `Grant one permission to one app installed on the mobile device attached to this terminal pane, so you can reach a screen that needs it without answering the system prompt. Only apps that are installed on that device can be given permissions, and never the system's own apps. iOS simulator permissions: ${paradisMobilePermissionNames('ios').join(', ')}. Android emulator permissions: ${paradisMobilePermissionNames('android').join(', ')}.`,
		inputSchema: {
			type: 'object',
			properties: {
				appId: { type: 'string', description: 'The bundle id (iOS) or package name (Android).' },
				permission: { type: 'string', description: 'A permission name from the list in this tool\'s description.' },
			},
			required: ['appId', 'permission'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
	},
];

const TOOL_NAMES: ReadonlySet<string> = new Set(PARADIS_MOBILE_DEVICE_OPS_TOOLS.map(tool => tool.name));

/** 手元のペインだけに許すツール（SSH の接続先の `tunnel` からは断る）。 */
const LOCAL_ONLY_TOOLS: ReadonlySet<string> = new Set(['mobile_request_device', 'mobile_install_app', 'mobile_launch_app', 'mobile_grant_permission']);

interface IToolResult {
	content: { type: 'text'; text: string }[];
	isError?: boolean;
	structuredContent?: unknown;
}

/** 割り当てられた端末を、コマンドを打てる形まで解いたもの。 */
interface IResolvedDevice {
	readonly device: IParadisMobileDevice;
	readonly platform: ParadisMobilePlatform;
	/** 形を確かめた UDID / シリアル。 */
	readonly nativeId: string;
}

export class ParadisMobileDeviceOpsToolProvider implements IParadisMcpToolProvider {

	constructor(
		private readonly _ledger: IParadisMobileDeviceLedger,
		private readonly _host: IParadisMobileHostRequester,
		private readonly _commands: ParadisMobileDeviceCommands,
		private readonly _logService: ILogService | undefined,
		private readonly _sleep: ParadisMobileSleep = realSleep,
	) { }

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_MOBILE_DEVICE_OPS_TOOLS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!TOOL_NAMES.has(name)) {
			return undefined;
		}
		const record = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
		try {
			// どれも状態を変えるので、トークンだけでなく接続元のプロセスを確かめる
			const caller: ParadisMcpCallerKind = context ? await context.classifyCaller() : 'unverified';
			if (caller === 'unverified') {
				return errorResult(CALLER_UNVERIFIED_MESSAGE);
			}
			if (caller === 'tunnel' && LOCAL_ONLY_TOOLS.has(name)) {
				return errorResult(SSH_REFUSED_MESSAGE);
			}
			switch (name) {
				case 'mobile_request_device':
					return await this._requestDevice(paneToken, record, context!, signal);
				case 'mobile_rotate':
					return await this._rotate(paneToken, record, signal);
				case 'mobile_gesture':
					return await this._gesture(paneToken, record, signal);
				case 'mobile_install_app':
					return await this._install(paneToken, record, signal);
				case 'mobile_launch_app':
					return await this._launch(paneToken, record, signal);
				case 'mobile_grant_permission':
					return await this._grant(paneToken, record, signal);
			}
			return errorResult(`Unhandled mobile tool: ${name}`);
		} catch (error) {
			return errorResult(toMessage(error));
		}
	}

	// --- 端末の要求 ---

	private async _requestDevice(paneToken: string, args: Record<string, unknown>, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<IToolResult> {
		const wanted = typeof args.device === 'string' ? args.device.trim() : '';
		if (!wanted) {
			return errorResult('"device" must be the id or the exact name of a device from mobile_list_devices.');
		}
		const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined;
		const devices = await this._ledger.listDevices(signal);
		const byId = devices.find(device => device.id === wanted);
		const byName = byId ? [] : devices.filter(device => device.name === wanted);
		if (!byId && byName.length > 1) {
			return errorResult(`More than one device is named "${wanted}". Pass its id from mobile_list_devices instead.`);
		}
		const device = byId ?? byName[0];
		if (!device) {
			return errorResult(`There is no device "${wanted}". Call mobile_list_devices to see the devices on this computer.`);
		}
		const current = this._ledger.getAttachment(paneToken);
		if (current?.deviceId === device.id) {
			return jsonResult({ attached: true, alreadyAttached: true, device: describeDevice(device) });
		}
		if (this._isUsedByAnotherPane(paneToken, device.id)) {
			return errorResult(`${device.name} is being used by another terminal pane, so it cannot be requested. Pick a device that no other pane is using, or ask the user.`);
		}

		const prompt: IParadisMobileDeviceRequestPrompt = {
			deviceName: device.name,
			...(device.runtime ? { runtime: device.runtime } : {}),
			...(reason ? { reason } : {}),
			...(current ? { replacingDeviceName: current.deviceName } : {}),
		};
		const call = await context.callOwningWindow<unknown>({
			channelName: PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
			method: PARADIS_MOBILE_DEVICE_REQUEST_METHOD,
			args: [paneToken, prompt],
			failureLabel: 'mobile_request_device',
			failureMessage: 'Para Code could not show the approval dialog in its window. Retry once; if it keeps failing, ask the user to attach the device from Para Code.',
			timeoutMs: PARADIS_AGENT_PAGE_REQUEST_TIMEOUT_MS,
			timeoutMessage: REQUEST_TIMEOUT_MESSAGE,
		}, signal);
		if (!call.ok) {
			return errorResult(call.error);
		}
		const answer = paradisParseMobileDeviceRequestAnswer(call.value);
		switch (answer?.outcome) {
			case 'approved':
				break;
			case 'denied':
				return jsonResult({ attached: false, approved: false, message: 'The user declined. Do not request a device again for now; Para Code turns down requests from this pane for a few minutes.' });
			case 'recentlyDenied':
				return errorResult('The user declined a request from this pane a short while ago, so Para Code turned this one down without asking. Wait a few minutes, or ask the user in the conversation.');
			case 'busy':
				return errorResult('Another request from this pane is still waiting for the user\'s answer.');
			case 'paneUnresolved':
				return errorResult('Para Code could not find this terminal pane in its window (it may be restoring). Retry in a few seconds.');
			default:
				// 取り消し・時間切れ・速すぎる承認の打ち切り・形の違う応答は、どれも割り当てない
				return jsonResult({ attached: false, approved: false, timedOut: true, message: REQUEST_TIMEOUT_MESSAGE });
		}
		// 承認を待つ間に、別のペインへ渡っていたら割り当てない（ほかのペインの端末は奪わない）
		if (this._isUsedByAnotherPane(paneToken, device.id)) {
			return errorResult(`${device.name} was given to another terminal pane while the user was answering, so it was not attached.`);
		}
		const attachment = await this._ledger.attach(paneToken, device.id, answer.stateKey, signal);
		this._logService?.info(`[paradis-mobile-canvas] the user approved attaching ${attachment.deviceName} to a terminal pane`);
		return jsonResult({ attached: true, approved: true, device: describeDevice(device), replaced: current ? current.deviceName : undefined });
	}

	private _isUsedByAnotherPane(paneToken: string, deviceId: string): boolean {
		return this._ledger.listAttachments().some(entry => entry.deviceId === deviceId && entry.paneToken !== paneToken);
	}

	// --- 画面の入力（Mobile Canvas ホスト） ---

	private async _rotate(paneToken: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const orientation = paradisNormalizeOrientation(args.orientation);
		if (!orientation) {
			return errorResult('"orientation" must be one of portrait, portrait-upside-down, landscape-left, landscape-right.');
		}
		const attachment = this._requireAttachment(paneToken);
		const id = encodeURIComponent(attachment.deviceId);
		await this._host.request('POST', `/api/v1/devices/${id}/input/rotate`, { orientation }, signal);
		// ホストは向きが変わる前に応答するので、寸法が新しい向きになるまで少し待つ
		let display = undefined as ReturnType<typeof paradisParseDisplaySize>;
		for (let attempt = 0; attempt < ROTATE_SETTLE_ATTEMPTS && !signal?.aborted; attempt++) {
			display = paradisParseDisplaySize(await this._host.request('GET', `/api/v1/devices/${id}/display`, undefined, signal));
			if (display && orientationSettled(orientation, display)) {
				return jsonResult({ orientation, screen: { pointWidth: display.width, pointHeight: display.height, scale: display.scale } });
			}
			await this._sleep(ROTATE_SETTLE_INTERVAL_MS, signal);
		}
		return jsonResult({
			orientation,
			screen: display ? { pointWidth: display.width, pointHeight: display.height, scale: display.scale } : null,
			note: 'The rotation was sent, but the screen had not reported the new orientation yet. Take a screenshot before using coordinates.',
		});
	}

	private async _gesture(paneToken: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const kind = args.kind;
		if (kind !== 'swipe' && kind !== 'long_press' && kind !== 'pinch') {
			return errorResult('"kind" must be one of swipe, long_press, pinch.');
		}
		const attachment = this._requireAttachment(paneToken);
		const id = encodeURIComponent(attachment.deviceId);
		const size = paradisParseDisplaySize(await this._host.request('GET', `/api/v1/devices/${id}/display`, undefined, signal).catch(() => undefined));
		const point = optionalPoint(args);
		if (point && size && !paradisIsInsideScreen(point, size)) {
			return errorResult(`(${point.x}, ${point.y}) is outside the screen, which is ${size.width}x${size.height} points.`);
		}

		if (kind === 'long_press') {
			if (!point) {
				return errorResult('long_press needs "x" and "y" in points.');
			}
			const duration = clamp(optionalNumber(args, 'duration') ?? LONG_PRESS_DEFAULT_SECONDS, 0.5, LONG_PRESS_MAX_SECONDS);
			await this._host.request('POST', `/api/v1/devices/${id}/input/tap`, { x: point.x, y: point.y, duration }, signal);
			return textResult(`Pressed and held ${attachment.deviceName} at (${point.x}, ${point.y}) for ${duration} seconds.`);
		}
		if (!size) {
			return errorResult('Para Code could not read the screen size of the device, so it cannot place this gesture. Try again in a moment.');
		}

		if (kind === 'swipe') {
			const direction = paradisParseSwipeDirection(args.direction);
			if (!direction) {
				return errorResult('swipe needs "direction": up, down, left or right. To swipe between two exact points use mobile_swipe.');
			}
			const { start, end } = paradisSwipeEndpoints(direction, size, point, optionalNumber(args, 'distance'));
			const duration = optionalNumber(args, 'duration');
			await this._host.request('POST', `/api/v1/devices/${id}/input/swipe`, { startX: start.x, startY: start.y, endX: end.x, endY: end.y, duration }, signal);
			return textResult(`Swiped ${direction} on ${attachment.deviceName} from (${start.x}, ${start.y}) to (${end.x}, ${end.y}).`);
		}

		const scale = optionalNumber(args, 'scale');
		if (scale === undefined || scale < 0.2 || scale > 5 || scale === 1) {
			return errorResult('pinch needs "scale" between 0.2 and 5 (not 1): above 1 zooms in, below 1 zooms out.');
		}
		const center = point ?? { x: size.width / 2, y: size.height / 2 };
		const shorter = Math.min(size.width, size.height);
		const startSpan = scale > 1 ? shorter * 0.2 : shorter * 0.6;
		const frames = paradisPinchFrames(center, startSpan, startSpan * scale, PINCH_STEPS, size);
		await this._twoFingerGesture(id, frames, signal);
		return textResult(`Pinched ${scale > 1 ? 'out (zoom in)' : 'in (zoom out)'} on ${attachment.deviceName} around (${Math.round(center.x)}, ${Math.round(center.y)}).`);
	}

	/**
	 * 2本の指を下ろし、動かし、上げる。ホストの `input/touch` は1本ずつの指（fingerId）で受ける。
	 * 途中で失敗しても、下ろした指は必ず上げる（押したままの指が残ると、その後の入力をすべて受け付けなくなる）。
	 */
	private async _twoFingerGesture(encodedId: string, frames: readonly (readonly [IParadisPoint, IParadisPoint])[], signal?: AbortSignal): Promise<void> {
		const down = new Map<number, IParadisPoint>();
		const touch = (fingerId: number, point: IParadisPoint, phase: 'down' | 'move' | 'up') =>
			this._host.request('POST', `/api/v1/devices/${encodedId}/input/touch`, { x: point.x, y: point.y, phase, fingerId }, signal);
		try {
			const [first0, first1] = frames[0];
			await touch(0, first0, 'down');
			down.set(0, first0);
			await touch(1, first1, 'down');
			down.set(1, first1);
			for (let index = 1; index < frames.length; index++) {
				if (signal?.aborted) {
					throw new Error('The gesture was cancelled.');
				}
				await this._sleep(PINCH_STEP_INTERVAL_MS, signal);
				const [point0, point1] = frames[index];
				await touch(0, point0, 'move');
				down.set(0, point0);
				await touch(1, point1, 'move');
				down.set(1, point1);
			}
		} catch (error) {
			throw new Error(`The two-finger gesture failed (${toMessage(error)}). This device may not accept two-finger input from Para Code.`);
		} finally {
			for (const [fingerId, point] of down) {
				try {
					// 取り消し後も指は上げたいので、ここでは signal を渡さない
					await this._host.request('POST', `/api/v1/devices/${encodedId}/input/touch`, { x: point.x, y: point.y, phase: 'up', fingerId });
				} catch (error) {
					this._logService?.warn('[paradis-mobile-canvas] could not lift a finger after a gesture', error);
				}
			}
		}
	}

	// --- アプリ（simctl / adb） ---

	private async _install(paneToken: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const resolved = await this._resolve(paneToken, signal);
		const target = await this._commands.resolveInstallTarget(resolved.platform, args.path);
		await this._commands.install(resolved.platform, resolved.nativeId, target, signal);
		const bundleId = await this._commands.readBundleId(target, signal).catch(() => undefined);
		this._logService?.info(`[paradis-mobile-canvas] installed an app on ${resolved.device.name}`);
		return jsonResult({ installed: true, device: resolved.device.name, path: target.path, ...(bundleId ? { appId: bundleId } : {}) });
	}

	private async _launch(paneToken: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const resolved = await this._resolve(paneToken, signal);
		const appId = requireAppId(resolved.platform, args.appId);
		await this._commands.launch(resolved.platform, resolved.nativeId, appId, args.relaunch === true, signal);
		return textResult(`Launched ${appId} on ${resolved.device.name}.`);
	}

	private async _grant(paneToken: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const resolved = await this._resolve(paneToken, signal);
		const appId = requireAppId(resolved.platform, args.appId);
		if (paradisIsSystemAppId(resolved.platform, appId)) {
			return errorResult(`${appId} is part of the operating system. Para Code only grants permissions to your own apps.`);
		}
		const permission = paradisResolveMobilePermission(resolved.platform, args.permission);
		if (!permission) {
			return errorResult(`"permission" must be one of: ${paradisMobilePermissionNames(resolved.platform).join(', ')}.`);
		}
		// 付けるのは、その端末に実際に入っているそのアプリだけ（入っていない ID へ前もって付けておくことはしない）
		if (!await this._commands.isInstalled(resolved.platform, resolved.nativeId, appId, signal)) {
			return errorResult(`${appId} is not installed on ${resolved.device.name}. Install it with mobile_install_app first.`);
		}
		await this._commands.grantPermission(resolved.platform, resolved.nativeId, appId, permission, signal);
		this._logService?.info(`[paradis-mobile-canvas] granted a permission on ${resolved.device.name}`);
		return textResult(`Granted ${permission} to ${appId} on ${resolved.device.name}.${resolved.platform === 'ios' ? ' iOS may have stopped the app if it was running.' : ''}`);
	}

	/** そのペインに割り当てられた端末（画面の入力に使う）。台帳に無ければ断る（ほかの端末は触らせない）。 */
	private _requireAttachment(paneToken: string): IParadisMobileAttachment {
		const attachment = this._ledger.getAttachment(paneToken);
		if (!attachment) {
			throw new Error(NO_DEVICE_ATTACHED_MESSAGE);
		}
		return attachment;
	}

	/**
	 * そのペインに割り当てられた端末を、コマンド（simctl / adb）を打てる形まで解く。
	 * 起動中で、端末の種類と番号（UDID / シリアル）が分かる必要がある。
	 */
	private async _resolve(paneToken: string, signal: AbortSignal | undefined): Promise<IResolvedDevice> {
		const attachment = this._requireAttachment(paneToken);
		const device = (await this._ledger.listDevices(signal)).find(candidate => candidate.id === attachment.deviceId);
		if (!device) {
			throw new Error(`${attachment.deviceName} is attached to this pane but Para Code cannot find it any more (it may have been deleted). Ask the user.`);
		}
		const platform = paradisMobilePlatformOf(device.platform);
		if (!platform) {
			throw new Error(`Para Code does not know how to manage apps on ${device.name}.`);
		}
		if (!device.isRunning) {
			throw new Error(`${device.name} is not running. Ask the user to start it from Para Code.`);
		}
		if (!paradisIsValidNativeDeviceId(platform, device.udid)) {
			throw new Error(`Para Code could not read the ${platform === 'ios' ? 'UDID' : 'serial'} of ${device.name}.`);
		}
		return { device, platform, nativeId: device.udid };
	}
}

function orientationSettled(target: ParadisMobileOrientation, display: IParadisPointSize & { readonly orientation?: string }): boolean {
	const reported = display.orientation?.toLowerCase();
	if (reported) {
		return target.startsWith('landscape') ? reported.startsWith('landscape') : reported === target;
	}
	// 向きを返さないホストでは、縦横の比で判断する
	return target.startsWith('landscape') ? display.width > display.height : display.height > display.width;
}

function describeDevice(device: IParadisMobileDevice): object {
	return { id: device.id, name: device.name, platform: device.platform, runtime: device.runtime, udid: device.udid, running: device.isRunning };
}

function requireAppId(platform: ParadisMobilePlatform, value: unknown): string {
	if (!paradisIsValidAppId(platform, value)) {
		throw new Error(`"appId" must be a ${platform === 'ios' ? 'bundle id' : 'package name'} such as "com.example.myapp".`);
	}
	return value;
}

function optionalPoint(args: Record<string, unknown>): IParadisPoint | undefined {
	const x = optionalNumber(args, 'x');
	const y = optionalNumber(args, 'y');
	if (x === undefined && y === undefined) {
		return undefined;
	}
	if (x === undefined || y === undefined) {
		throw new Error('Give both "x" and "y", or neither.');
	}
	return { x, y };
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
	const value = args[name];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`"${name}" must be a number.`);
	}
	return value;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function jsonResult(value: object): IToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }], structuredContent: value };
}

function textResult(text: string): IToolResult {
	return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): IToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
