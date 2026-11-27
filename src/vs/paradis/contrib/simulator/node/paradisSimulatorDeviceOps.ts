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
//  - mobile_rotate / mobile_gesture: 回転・スワイプ（向きの指定）・長押し・ピンチ。端末の口（serve-sim・adb）への入力
//  - mobile_install_app / mobile_launch_app / mobile_grant_permission: `xcrun simctl` / `adb` を引数配列で呼ぶ
//
// どのツールも、そのペインに割り当てられた端末だけを台帳から引く（既存の mobile_tap などと同じ）。1 つのペインに
// 10 台まで割り当てられ、任意の引数 `device` はその中から選ぶ（省いたら最後に割り当てた端末。決まりは
// simulator/common/paradisMobileAttachmentBook.ts）。要求だけは端末の一覧から名指しするが、ほかのペインが
// 使っている端末は断る。要求は「足す」で、上限のときは、外す端末を利用者が承認の画面で選ぶ。
// mobile_release_device は、エージェントが自分のペインの端末を手放す（外すだけなので承認は取らない）。
//
// 接続元の確認（`context.classifyCaller()`）は、要求・インストール・起動・権限の付与だけに掛ける。
// 回転とジェスチャーは既存の mobile_tap などと同じく、利用者がその端末をそのペインへ渡した後の画面の操作
// なので、トークンだけで動かす（tmux・WSL・採用した Codex app-server では確認を通らないため）。
// SSH の接続先のペイン（`tunnel`）は、端末の要求だけを受ける（q.html の案 B。シミュレータは手元の Mac の機能で、
// 要求は必ず Mac の窓の承認ダイアログを通るため）。インストール・起動・権限の付与は断る（.app が接続先にあり、
// 入れたアプリは Mac の権限で動くため）。
//
// インストールは毎回、別に承認を取る。入れたアプリは Para Code の権限で動き、エージェントのサンドボックス
// （作業フォルダの制限）の外に出られるため。起動は入っているアプリを動かすだけなので承認しない。

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, ParadisMcpCallerKind } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisMobileAttachment, IParadisMobileDevice, paradisFindMobileDevice } from '../common/paradisMobileCanvas.js';
import { IParadisMobileTarget, IParadisMobileToolResult, PARADIS_MOBILE_MAX_DEVICES_PER_PANE, ParadisMobileAttachResult, paradisStampMobileDevice, paradisWithMobileDeviceArgument } from '../common/paradisMobileAttachmentBook.js';
import {
	IParadisMobileDeviceRequestPrompt,
	IParadisMobileInstallPrompt,
	PARADIS_MOBILE_APPROVAL_TIMEOUT_MS,
	PARADIS_MOBILE_SWIPE_DEFAULT_SECONDS,
	PARADIS_MOBILE_INSTALL_APPROVAL_METHOD,
	PARADIS_MOBILE_INSTALL_PRECHECK_METHOD,
	ParadisMobileDeviceRequestOutcome,
	paradisDeviceHeldByAnotherPane,
	IParadisPoint,
	IParadisPointSize,
	PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
	PARADIS_MOBILE_DEVICE_REQUEST_METHOD,
	ParadisMobileOrientation,
	ParadisMobilePlatform,
	paradisIsInsideScreen,
	paradisIsValidAppId,
	paradisIsValidNativeDeviceId,
	paradisMobilePermissionNames,
	paradisMobilePlatformOf,
	paradisNormalizeOrientation,
	paradisParseDisplaySize,
	paradisParseMobileApprovalPrecheck,
	paradisParseMobileDeviceRequestAnswer,
	paradisParseSwipeDirection,
	paradisPinchFrames,
	paradisPngSize,
	paradisScreenSizeFromScreenshot,
	paradisResolveMobilePermission,
	paradisSwipeEndpoints,
} from '../common/paradisMobileDeviceOps.js';
import { ParadisMobileDeviceCommands } from './paradisMobileDeviceCommands.js';

/** 端末の割り当て台帳のうち、このプロバイダが使う部分（ParadisMobileCanvasService が満たす）。 */
export interface IParadisMobileDeviceLedger {
	/**
	 * 道具が操作する端末。`device`（道具の引数。id か名前）はそのペインの割り当ての中だけで引き、省いたら今の端末
	 * （最後に割り当てたもの）。ツールの利用として最終利用時刻も進める。決まらなければ、エージェントに返す文で throw する。
	 */
	resolveTarget(paneToken: string, device: unknown, signal?: AbortSignal): Promise<IParadisMobileTarget>;
	/** そのペインの割り当て（割り当てた順。最後が今の端末）。 */
	listPaneAttachments(paneToken: string): readonly IParadisMobileAttachment[];
	listAttachments(): readonly IParadisMobileAttachment[];
	listDevices(signal?: AbortSignal): Promise<IParadisMobileDevice[]>;
	/**
	 * ほかのペインが使っていなければ足す（確かめと書き込みの間に await を挟まない）。`releaseDeviceId` があれば、
	 * その端末を外してから足す。端末が無ければ undefined、断ったときはその理由。
	 */
	attachIfFree(paneToken: string, deviceId: string, stateKey: string | undefined, signal?: AbortSignal, releaseDeviceId?: string): Promise<ParadisMobileAttachResult | undefined>;
	/** そのペインの割り当てを外す（`deviceId` は台帳の id）。外したものを返す。 */
	detach(paneToken: string, deviceId?: string): readonly IParadisMobileAttachment[];
}

/** 端末の口（`/api/v1/devices/...` の道。paradisSimulatorDeviceRouter.ts が満たす。もとは Mobile Canvas ホストの REST の形）。 */
export interface IParadisMobileHostRequester {
	request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
	requestBinary(path: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** 入力の座標に使う画面の大きさ。`fromScreenshot` が false なら端末の向き（`/display`）からの推定で、ずれうる。 */
interface IParadisScreen extends IParadisPointSize {
	readonly scale: number | undefined;
	readonly fromScreenshot: boolean;
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

const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so it does not attach devices, install or launch apps, or grant permissions for it. This happens inside tmux, screen, zellij, WSL or a container. Ask the user to do it from Para Code; screen tools such as mobile_tap keep working on a device already attached to this pane.';
const SSH_REFUSED_MESSAGE = 'This terminal pane runs on an SSH host. Para Code does not let an agent on an SSH host install apps, launch apps or grant permissions on a device on this computer. Ask the user to do it on this computer. mobile_request_device still works: the user approves it in Para Code.';
const REQUEST_TIMEOUT_MESSAGE = 'The user did not answer in time. Ask the user in the conversation before asking again.';
const REQUEST_CANCELLED_MESSAGE = 'The request was cancelled before the user answered.';
const INSTALL_DENIED_MESSAGE = 'The user declined to install this app. Do not try again straight away: Para Code turns down installs from this pane onto this device for a few minutes.';
const INSTALL_RECENTLY_DENIED_MESSAGE = 'The user declined an install from this pane onto this device a short while ago, so Para Code turned this one down without asking. Wait a few minutes, or ask the user in the conversation.';
const REQUEST_UNANSWERED_MESSAGE = 'Para Code could not get a clear answer: the dialog was closed before it appeared on screen, answered right after it appeared, or answered with a keyboard shortcut. This does not count as a refusal. Ask the user to click a button in the dialog, then ask again.';

/** 回転の後、画面（スクショ）が新しい向きに変わるのを待つ回数と間隔（ホストは画面が回る前に応答する）。 */
/**
 * 回転の後、画面（スクショ）が新しい向きになったかを見る決まり。スクショは1枚 0.5〜0.9 秒かかる（iOS 27、1206x2622）ので、
 * 回転の動き（iOS で 0.3〜0.4 秒）を待ってから最大3枚、次の1枚が {@link ROTATE_BUDGET_MS} に収まる間だけ見る（前面のアプリが回らない向きでは
 * 必ず見終えるまで待つことになるため）。
 */
const ROTATE_FIRST_WAIT_MS = 500;
const ROTATE_MAX_SHOTS = 3;
const ROTATE_SETTLE_INTERVAL_MS = 250;
const ROTATE_BUDGET_MS = 2_000;
/**
 * アプリを起動した直後は、スクショも回転も遅い（Safari を起動した直後の landscape-left で、1 回の呼び出しが 4.7 秒
 * かかり、2 秒では回り切る前に見るのをやめていた。paracode-196 の確認。2026-11-28 の iPhone 17・iOS 27.2 では、起動の
 * 1.5 秒後に回すとスクショは 1 枚 2〜5 秒かかり、横になったのは 6.4 秒後）。起動からこの時間の間は、待つ上限と枚数を増やす。
 */
const ROTATE_AFTER_LAUNCH_WINDOW_MS = 20_000;
const ROTATE_AFTER_LAUNCH_BUDGET_MS = 8_000;
const ROTATE_AFTER_LAUNCH_MAX_SHOTS = 6;
/** ピンチの指を動かす回数と間隔。 */
const PINCH_STEPS = 12;
const PINCH_STEP_INTERVAL_MS = 16;
const LONG_PRESS_DEFAULT_SECONDS = 1;
const LONG_PRESS_MAX_SECONDS = 10;
const SWIPE_MIN_SECONDS = 0.05;
const SWIPE_MAX_SECONDS = 10;

const REQUEST_DEVICE_TOOL: IParadisMcpToolDefinition = {
	name: 'mobile_request_device',
	description: `Ask the user to attach a mobile device (iOS simulator or Android emulator on this computer) to this terminal pane. Para Code shows the user an approval dialog and attaches the device only if they approve. Call mobile_list_devices first and pass the id or the exact name of a device. You cannot request a device that another terminal pane is using (usedByAnotherPane). The device is added to the ones this pane already has (up to ${PARADIS_MOBILE_MAX_DEVICES_PER_PANE}; ask for one device per call) and becomes the pane's current device, the one mobile tools use when you omit "device". When the pane already has ${PARADIS_MOBILE_MAX_DEVICES_PER_PANE}, the dialog asks the user which one to detach. If the user declines, do not ask for the same device again straight away: Para Code turns down further requests from this pane for that device for a few minutes.`,
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
};

const RELEASE_DEVICE_TOOL: IParadisMcpToolDefinition = {
	name: 'mobile_release_device',
	description: 'Detach a mobile device from this terminal pane when you no longer need it. The device keeps running; you only give up access to it, and getting it back needs the user\'s approval again (mobile_request_device). If it was the current device, the one attached last among the remaining devices becomes current.',
	inputSchema: {
		type: 'object',
		properties: {
			device: { type: 'string', description: 'The id or the exact name of a device attached to this terminal pane (attachedDevices in mobile_list_devices).' },
		},
		required: ['device'],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** 割り当てた端末を操作する道具。どれも任意の引数 `device` を受ける（下で足す）。 */
const DEVICE_TOOLS: readonly IParadisMcpToolDefinition[] = [
	{
		name: 'mobile_rotate',
		description: 'Rotate the mobile device attached to this terminal pane. Returns the new screen size in points: every coordinate you pass to input tools afterwards must use this new size. If the result says "confirmed": false, Para Code could not see the screen turn in time: take mobile_screenshot before you use coordinates.',
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
				duration: { type: 'number', description: 'Seconds. long_press: how long to hold (default 1, at most 10). swipe: how long the movement takes (default 0.4; much faster swipes may not register).' },
				scale: { type: 'number', description: 'pinch only: between 0.2 and 5. 2 doubles the distance between the fingers, 0.5 halves it.' },
			},
			required: ['kind'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	},
	{
		name: 'mobile_install_app',
		description: 'Install an app you built onto the mobile device attached to this terminal pane. The user approves every install in a Para Code dialog, so call this only once the build is ready. path must be an absolute path on this computer: a .app bundle (or an .ipa) for an iOS simulator, an .apk for an Android emulator. An app that is already installed is replaced and keeps its data. Returns the bundle id when Para Code can read it, so you can pass it to mobile_launch_app.',
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
		description: `Grant one permission to one app installed on the mobile device attached to this terminal pane, so you can reach a screen that needs it without answering the system prompt. Only apps the user installed on that device can be given permissions, never the system's own apps. iOS simulator permissions: ${paradisMobilePermissionNames('ios').join(', ')}. Android emulator permissions: ${paradisMobilePermissionNames('android').join(', ')} (runtime permissions only).`,
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

export const PARADIS_MOBILE_DEVICE_OPS_TOOLS: readonly IParadisMcpToolDefinition[] = [REQUEST_DEVICE_TOOL, ...DEVICE_TOOLS.map(paradisWithMobileDeviceArgument), RELEASE_DEVICE_TOOL];

const TOOL_NAMES: ReadonlySet<string> = new Set(PARADIS_MOBILE_DEVICE_OPS_TOOLS.map(tool => tool.name));

/**
 * mobile_* の道具の決まり（MCP のサーバーの説明と `para help mobile` に出る）。複数の端末を割り当てたときの取り違えを防ぐ。
 */
export const PARADIS_MOBILE_INSTRUCTIONS = `Mobile tools (mobile_*) act on the iOS simulators and Android emulators the user attached to this terminal pane (up to ${PARADIS_MOBILE_MAX_DEVICES_PER_PANE}). When more than one is attached, pass device (an id or exact name from attachedDevices in mobile_list_devices) on every call; without it a tool acts on the device attached last. Every result names the device it acted on: check it. Tell each subagent which device is its own.`;

/**
 * 接続元を確かめるツール（端末の割り当て・アプリの操作）。`unverified` は断る。SSH の接続先（`tunnel`）は
 * {@link SSH_ALLOWED_TOOLS} だけ受ける。
 * ここに無いツール（回転・ジェスチャー）は画面の操作なので、既存の mobile_tap などと同じくトークンだけで動く。
 */
const CALLER_CHECKED_TOOLS: ReadonlySet<string> = new Set(['mobile_request_device', 'mobile_install_app', 'mobile_launch_app', 'mobile_grant_permission']);

/** SSH の接続先のペインからも受けるツール。端末の要求は必ず Mac の窓の承認ダイアログを通る。 */
const SSH_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['mobile_request_device']);

type IToolResult = IParadisMobileToolResult;

/** 割り当てられた端末を、コマンドを打てる形まで解いたもの。 */
interface IResolvedDevice {
	readonly device: IParadisMobileDevice;
	readonly platform: ParadisMobilePlatform;
	/** 形を確かめた UDID / シリアル。 */
	readonly nativeId: string;
	/**
	 * 台帳に残っている id。起動前の AVD で割り当てた Android は、起動すると一覧の id（`device.id`）が serial に
	 * 替わるので、台帳と比べるとき・覚えた画面の大きさを引くときは、こちらを使う。
	 */
	readonly attachedId: string;
}

export class ParadisMobileDeviceOpsToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'mobile';

	constructor(
		private readonly _ledger: IParadisMobileDeviceLedger,
		private readonly _host: IParadisMobileHostRequester,
		private readonly _commands: ParadisMobileDeviceCommands,
		private readonly _logService: ILogService | undefined,
		private readonly _sleep: ParadisMobileSleep = realSleep,
		private readonly _now: () => number = Date.now,
	) { }

	/**
	 * 端末ごとに覚えた画面の大きさ（スクショから出したもの）。スクショは重いので、取り直すのは回転したとき・
	 * アプリを起動したとき・覚えた値が無いときだけ。ジェスチャーは覚えた値を使い、範囲の外と判定したときだけ
	 * 断る前に一度取り直す（利用者が手で回した・画面が変わった場合に備えて）。
	 */
	private readonly _screenSizes = new Map<string, IParadisScreen>();
	/** 端末の id → アプリを起動した時刻（回転を待つ上限を延ばすため）。 */
	private readonly _launchedAt = new Map<string, number>();

	/** インストール（写し・承認・インストール）の最中のペイン。写しを並べて作らせない。 */
	private readonly _installsInFlight = new Set<string>();

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_MOBILE_DEVICE_OPS_TOOLS;
	}

	instructions(): string {
		return PARADIS_MOBILE_INSTRUCTIONS;
	}

	/** 覚えた画面の大きさを捨てる（mobile_fold で開閉した後。simulator/node/paradisSimulatorFoldTool.ts）。 */
	forgetScreenSize(deviceId: string): void {
		this._screenSizes.delete(deviceId);
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!TOOL_NAMES.has(name)) {
			return undefined;
		}
		const record = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
		try {
			if (CALLER_CHECKED_TOOLS.has(name)) {
				// 端末を割り当てる・アプリを入れる操作は、トークンだけでなく接続元のプロセスを確かめる
				const caller: ParadisMcpCallerKind = context ? await context.classifyCaller() : 'unverified';
				if (caller === 'unverified') {
					return errorResult(CALLER_UNVERIFIED_MESSAGE);
				}
				if (caller === 'tunnel' && !SSH_ALLOWED_TOOLS.has(name)) {
					return errorResult(SSH_REFUSED_MESSAGE);
				}
			}
			if (name === 'mobile_request_device') {
				return await this._requestDevice(paneToken, record, context!, signal);
			}
			if (name === 'mobile_release_device') {
				return await this._releaseDevice(paneToken, record, signal);
			}
			// ここから先は割り当てた端末が要る。`device` はそのペインの割り当ての中だけで引く（省いたら今の端末）。
			// 返事には、成功でも失敗でも、操作した端末の名前と id を入れる
			const target = await this._ledger.resolveTarget(paneToken, record.device, signal);
			try {
				return paradisStampMobileDevice(await this._callDeviceTool(paneToken, target.attachment, name, record, context, signal), target);
			} catch (error) {
				return paradisStampMobileDevice(errorResult(toMessage(error)), target);
			}
		} catch (error) {
			return errorResult(toMessage(error));
		}
	}

	private async _callDeviceTool(paneToken: string, attachment: IParadisMobileAttachment, name: string, record: Record<string, unknown>, context: IParadisMcpToolCallContext | undefined, signal?: AbortSignal): Promise<IToolResult> {
		switch (name) {
			case 'mobile_rotate':
				return this._rotate(attachment, record, signal);
			case 'mobile_gesture':
				return this._gesture(attachment, record, signal);
			case 'mobile_install_app':
				return this._install(paneToken, attachment, record, context!, signal);
			case 'mobile_launch_app':
				return this._launch(attachment, record, signal);
			case 'mobile_grant_permission':
				return this._grant(attachment, record, signal);
		}
		return errorResult(`Unhandled mobile tool: ${name}`);
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
		const mine = this._ledger.listPaneAttachments(paneToken);
		const describeMine = (attachments: readonly IParadisMobileAttachment[]) => attachments.map((attachment, index) => ({ id: attachment.deviceId, name: attachment.deviceName, current: index === attachments.length - 1 }));
		// 起動前の AVD で割り当てた端末を、起動後の id で頼み直しても、同じ端末として扱う（二重に割り当てない）
		if (mine.some(attachment => attachment.deviceId === device.id || paradisFindMobileDevice(devices, attachment.deviceId) === device)) {
			return jsonResult({ attached: true, alreadyAttached: true, device: describeDevice(device), attachedDevices: describeMine(mine) });
		}
		if (paradisDeviceHeldByAnotherPane(paneToken, device, devices, this._ledger.listAttachments())) {
			return errorResult(`${device.name} is being used by another terminal pane, so it cannot be requested. Pick a device that no other pane is using, or ask the user.`);
		}

		// 要求は「足す」。上限のときだけ、外す端末を利用者が承認の画面で選ぶ
		const full = mine.length >= PARADIS_MOBILE_MAX_DEVICES_PER_PANE;
		const prompt: IParadisMobileDeviceRequestPrompt = {
			deviceId: device.id,
			deviceName: device.name,
			...(device.runtime ? { runtime: device.runtime } : {}),
			...(reason ? { reason } : {}),
			attachedDevices: mine.map(attachment => ({ id: attachment.deviceId, name: attachment.deviceName })),
			...(full ? { mustRelease: true } : {}),
		};
		const askedAt = Date.now();
		const call = await context.callOwningWindow<unknown>({
			channelName: PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
			method: PARADIS_MOBILE_DEVICE_REQUEST_METHOD,
			args: [paneToken, prompt],
			failureLabel: 'mobile_request_device',
			failureMessage: 'Para Code could not show the approval dialog in its window. Retry once; if it keeps failing, ask the user to attach the device from Para Code.',
			timeoutMs: PARADIS_MOBILE_APPROVAL_TIMEOUT_MS,
			timeoutMessage: REQUEST_TIMEOUT_MESSAGE,
		}, signal);
		if (!call.ok) {
			return errorResult(call.error);
		}
		const answer = paradisParseMobileDeviceRequestAnswer(call.value);
		if (answer?.outcome !== 'approved') {
			// 画面を出さずに返る経路（paneUnresolved・recentlyDenied・busy）も含めて、承認されなかった結果を残す
			this._logService?.info(`[paradis-mobile-canvas] a device request was not approved: outcome=${answer?.outcome ?? 'malformed'}, elapsedMs=${Date.now() - askedAt}`);
			return refusal(answer?.outcome, 'The user declined to attach this device. Do not ask for it again for now, and do not switch to another device to ask again: Para Code turns down requests from this pane for this device for a few minutes, and for any device for a few seconds. Browser pages are not affected.', 'The user declined a request from this pane a short while ago (for this device in the last few minutes, or for any device in the last few seconds), so Para Code turned this one down without asking. Do not switch to another device to ask again; wait, or ask the user in the conversation.');
		}
		// 承認を待つ間に別のペインへ渡っていたら割り当てない（ほかのペインの端末は奪わない）。上限と、利用者が選んだ
		// 「外す端末」も、台帳が書き込む直前に確かめる（外すのと足すのは一度に行う）
		const result = await this._ledger.attachIfFree(paneToken, device.id, answer.stateKey, signal, answer.releaseDeviceId);
		if (!result || result.refused === 'heldByAnotherPane') {
			return errorResult(`${device.name} was given to another terminal pane (or disappeared) while the user was answering, so it was not attached.`);
		}
		if (result.refused !== undefined) {
			return errorResult(result.refused === 'full'
				? `This terminal pane already has ${PARADIS_MOBILE_MAX_DEVICES_PER_PANE} devices attached, so ${device.name} was not attached. Detach one you no longer need with mobile_release_device, then ask again.`
				: `The device the user chose to detach is no longer attached to this pane, so ${device.name} was not attached. Ask again.`);
		}
		this._logService?.info(`[paradis-mobile-canvas] the user approved attaching ${result.attachment.deviceName} to a terminal pane`);
		const now = this._ledger.listPaneAttachments(paneToken);
		return jsonResult({
			attached: true,
			approved: true,
			device: describeDevice(device),
			...(result.released ? { released: { id: result.released.deviceId, name: result.released.deviceName } } : {}),
			attachedDevices: describeMine(now),
			// 今の端末は、割り当ての一覧の最後（承認を待つ間に利用者が同じ端末を渡し、その後に別の端末も渡していると、この端末とは限らない）
			...(now.length > 1 ? { note: `${now[now.length - 1].deviceName} is the current device of this pane: mobile tools act on it when you omit "device". Pass "device" to use one of the others.` } : {}),
		});
	}

	/** エージェントが、自分のペインの端末を手放す。外すだけなので承認は取らない（取り戻すには、また承認が要る）。 */
	private async _releaseDevice(paneToken: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		if (typeof args.device !== 'string' || !args.device.trim()) {
			return errorResult('"device" must be the id or the exact name of a device attached to this terminal pane. Call mobile_list_devices to see them (attachedDevices).');
		}
		const target = await this._ledger.resolveTarget(paneToken, args.device, signal);
		this._ledger.detach(paneToken, target.attachment.deviceId);
		this._screenSizes.delete(target.attachment.deviceId);
		const remaining = this._ledger.listPaneAttachments(paneToken);
		this._logService?.info(`[paradis-mobile-canvas] an agent released a device from its terminal pane (${remaining.length} left)`);
		return jsonResult({
			released: { id: target.attachment.deviceId, name: target.attachment.deviceName },
			attachedDevices: remaining.map((attachment, index) => ({ id: attachment.deviceId, name: attachment.deviceName, current: index === remaining.length - 1 })),
		});
	}

	// --- 画面の入力（端末の口） ---

	private async _rotate(attachment: IParadisMobileAttachment, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const orientation = paradisNormalizeOrientation(args.orientation);
		if (!orientation) {
			return errorResult('"orientation" must be one of portrait, portrait-upside-down, landscape-left, landscape-right.');
		}
		const id = encodeURIComponent(attachment.deviceId);
		await this._host.request('POST', `/api/v1/devices/${id}/input/rotate`, { orientation }, signal);
		// ホストは画面が回る前に応答するので、スクショの縦横が新しい向きになるまで少し待つ。
		// 前面のアプリがその向きに回らないこと（縦しか無いアプリ、上下逆さに回らない iPhone）もあるので、
		// 返すのは端末の向きではなく、実際の画面（スクショ）の大きさ。見た大きさは次のジェスチャー用に覚える
		const started = this._now();
		const launchedAt = this._launchedAt.get(attachment.deviceId);
		const afterLaunch = launchedAt !== undefined && started - launchedAt < ROTATE_AFTER_LAUNCH_WINDOW_MS;
		const budget = afterLaunch ? ROTATE_AFTER_LAUNCH_BUDGET_MS : ROTATE_BUDGET_MS;
		const maxShots = afterLaunch ? ROTATE_AFTER_LAUNCH_MAX_SHOTS : ROTATE_MAX_SHOTS;
		let screen: IParadisScreen | undefined;
		await this._sleep(ROTATE_FIRST_WAIT_MS, signal);
		for (let shot = 0; shot < maxShots && !signal?.aborted; shot++) {
			const shotStarted = this._now();
			screen = await this._screen(attachment.deviceId, signal, true);
			if (screen && orientationSettled(orientation, screen)) {
				return jsonResult({ orientation, screen: describeScreen(screen) });
			}
			// 次の1枚が締め切りを越えるなら見るのをやめる
			const shotTook = this._now() - shotStarted;
			if (this._now() - started + ROTATE_SETTLE_INTERVAL_MS + shotTook > budget) {
				break;
			}
			await this._sleep(ROTATE_SETTLE_INTERVAL_MS, signal);
		}
		// 見ている間に新しい向きにならなかった。回らないアプリのこともあるが、まだ回っている途中のこともある（起動の直後など）
		// ので「回らなかった」とは言い切らない。最後に見た大きさは覚えず、次の操作で測り直す
		this._screenSizes.delete(attachment.deviceId);
		return jsonResult({
			orientation,
			confirmed: false,
			lastSeenScreen: screen ? describeScreen(screen) : null,
			note: `The device was turned, but Para Code could not confirm within ${Math.round((this._now() - started) / 100) / 10} s that the screen changed to ${orientation}: the app on screen may still be turning (it is slow right after an app starts), or it may not support this orientation. Take mobile_screenshot to see which way the screen is before you use coordinates. Input tools measure the screen again on their next call.`,
		});
	}

	/**
	 * 入力の座標に使う画面の大きさ。スクショの画素数を `scale` で割って出す（mobile_tap と同じ基準）。
	 * スクショを取れないときだけ `/display`（端末の向き）で代える。
	 */
	private async _screen(deviceId: string, signal?: AbortSignal, fresh = false): Promise<IParadisScreen | undefined> {
		const remembered = fresh ? undefined : this._screenSizes.get(deviceId);
		if (remembered) {
			return remembered;
		}
		const measured = await this._measureScreen(encodeURIComponent(deviceId), signal);
		if (measured?.fromScreenshot) {
			this._screenSizes.set(deviceId, measured);
		}
		return measured;
	}

	private async _measureScreen(encodedId: string, signal?: AbortSignal): Promise<IParadisScreen | undefined> {
		const display = paradisParseDisplaySize(await this._host.request('GET', `/api/v1/devices/${encodedId}/display`, undefined, signal).catch(() => undefined));
		const png = display?.scale !== undefined
			? await this._host.requestBinary(`/api/v1/devices/${encodedId}/screenshot`, signal).then(paradisPngSize, () => undefined)
			: undefined;
		if (png && display?.scale !== undefined) {
			return { ...paradisScreenSizeFromScreenshot(png, display.scale), scale: display.scale, fromScreenshot: true };
		}
		return display ? { width: display.width, height: display.height, scale: display.scale, fromScreenshot: false } : undefined;
	}

	private async _gesture(attachment: IParadisMobileAttachment, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const kind = args.kind;
		if (kind !== 'swipe' && kind !== 'long_press' && kind !== 'pinch') {
			return errorResult('"kind" must be one of swipe, long_press, pinch.');
		}
		const id = encodeURIComponent(attachment.deviceId);
		let size = await this._screen(attachment.deviceId, signal);
		const point = optionalPoint(args);
		if (point && size && isOutside(point, size)) {
			// 覚えた大きさが古いかもしれない（利用者が手で回した・画面が変わった）。断る前に一度だけ取り直す
			size = await this._screen(attachment.deviceId, signal, true);
		}
		if (point && size && isOutside(point, size)) {
			return errorResult(`(${point.x}, ${point.y}) is outside the screen, which is ${size!.width}x${size!.height} points (the same size as the screenshot divided by its scale).`);
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
			const requested = optionalNumber(args, 'duration');
			const duration = clamp(requested ?? PARADIS_MOBILE_SWIPE_DEFAULT_SECONDS, SWIPE_MIN_SECONDS, SWIPE_MAX_SECONDS);
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
		// 記録は要求を送る前に付ける（ホストが受け付けたのに応答だけ失敗した指も、必ず上げるため。
		// 下ろしていない指への「上げる」は余分に送っても害が無い）
		const send = async (fingerId: number, point: IParadisPoint, phase: 'down' | 'move') => {
			down.set(fingerId, point);
			await touch(fingerId, point, phase);
		};
		try {
			const [first0, first1] = frames[0];
			await send(0, first0, 'down');
			await send(1, first1, 'down');
			for (let index = 1; index < frames.length; index++) {
				if (signal?.aborted) {
					break;
				}
				await this._sleep(PINCH_STEP_INTERVAL_MS, signal);
				const [point0, point1] = frames[index];
				await send(0, point0, 'move');
				await send(1, point1, 'move');
			}
		} catch (error) {
			if (signal?.aborted) {
				throw new Error('The gesture was cancelled.');
			}
			throw new Error(`The two-finger gesture failed (${toMessage(error)}). This device may not accept two-finger input from Para Code.`);
		} finally {
			// 取り消しで抜けたときも、ここで指を上げる
			for (const [fingerId, point] of down) {
				try {
					// 取り消し後も指は上げたいので、ここでは signal を渡さない
					await this._host.request('POST', `/api/v1/devices/${encodedId}/input/touch`, { x: point.x, y: point.y, phase: 'up', fingerId });
				} catch (error) {
					this._logService?.warn('[paradis-mobile-canvas] could not lift a finger after a gesture', error);
				}
			}
		}
		if (signal?.aborted) {
			throw new Error('The gesture was cancelled.');
		}
	}

	// --- アプリ（simctl / adb） ---

	private async _install(paneToken: string, attachment: IParadisMobileAttachment, args: Record<string, unknown>, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<IToolResult> {
		// 同じペインのインストールは1つずつ（断られる呼び出しを並べて、写しを同時にいくつも作らせない）
		if (this._installsInFlight.has(paneToken)) {
			return errorResult('Another install from this pane is still in progress or waiting for the user\'s answer.');
		}
		this._installsInFlight.add(paneToken);
		try {
			return await this._installExclusive(paneToken, attachment, args, context, signal);
		} finally {
			this._installsInFlight.delete(paneToken);
		}
	}

	private async _installExclusive(paneToken: string, attachment: IParadisMobileAttachment, args: Record<string, unknown>, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<IToolResult> {
		const resolved = await this._resolve(attachment, signal);
		const target = await this._commands.resolveInstallTarget(resolved.platform, args.path);
		// 写す前に、今頼んでもダイアログを出さずに断られる状態（3 分の自動の断り・答え待ち）でないかを確かめる。
		// 判定は承認のときにもう一度行う
		const precheck = await context.callOwningWindow<unknown>({
			channelName: PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
			method: PARADIS_MOBILE_INSTALL_PRECHECK_METHOD,
			args: [paneToken, { deviceId: resolved.device.id, deviceName: resolved.device.name }],
			failureLabel: 'mobile_install_app',
			failureMessage: 'Para Code could not reach its window to ask about the install. Retry once; if it keeps failing, ask the user to install the app.',
		}, signal);
		if (!precheck.ok) {
			return errorResult(precheck.error);
		}
		const state = paradisParseMobileApprovalPrecheck(precheck.value);
		if (state !== 'clear') {
			return refusal(state, INSTALL_DENIED_MESSAGE, INSTALL_RECENTLY_DENIED_MESSAGE);
		}
		// 承認の前に Para Code だけが書ける一時フォルダへ写し、ダイアログには写しの中身を出して、写しを入れる。
		// 元のパスは承認の後にも中身や行き先を差し替えられるので、元のパスからは入れない
		const staged = await this._commands.stageInstall(target, signal);
		try {
			// 入れたアプリは Para Code の権限で動き、エージェントのサンドボックスの外に出られるので、毎回利用者に聞く
			const prompt: IParadisMobileInstallPrompt = {
				deviceId: resolved.device.id,
				deviceName: resolved.device.name,
				path: target.path,
				...(staged.appId ? { appId: staged.appId } : {}),
				...(staged.appName ? { appName: staged.appName } : {}),
			};
			const call = await context.callOwningWindow<unknown>({
				channelName: PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
				method: PARADIS_MOBILE_INSTALL_APPROVAL_METHOD,
				args: [paneToken, prompt],
				failureLabel: 'mobile_install_app',
				failureMessage: 'Para Code could not show the install approval dialog in its window. Retry once; if it keeps failing, ask the user to install the app.',
				timeoutMs: PARADIS_MOBILE_APPROVAL_TIMEOUT_MS,
				timeoutMessage: REQUEST_TIMEOUT_MESSAGE,
			}, signal);
			if (!call.ok) {
				return errorResult(call.error);
			}
			const answer = paradisParseMobileDeviceRequestAnswer(call.value);
			if (answer?.outcome !== 'approved') {
				return refusal(answer?.outcome, INSTALL_DENIED_MESSAGE, INSTALL_RECENTLY_DENIED_MESSAGE);
			}
			// 承認を待つ間にその端末が外されていたら入れない（もう渡していない端末へ入れないように）
			if (!this._ledger.listPaneAttachments(paneToken).some(entry => entry.deviceId === resolved.attachedId)) {
				return errorResult('The device was detached from this pane while the user was answering, so nothing was installed.');
			}
			await this._commands.install(resolved.platform, resolved.nativeId, staged, signal);
			this._logService?.info(`[paradis-mobile-canvas] installed an app on ${resolved.device.name}`);
			return jsonResult({
				installed: true,
				path: target.path,
				note: 'Para Code installed a copy it made of this path before asking the user; later changes to the path are not included.',
				...(staged.appId ? { appId: staged.appId } : {}),
			});
		} finally {
			await staged.dispose().catch(error => this._logService?.warn('[paradis-mobile-canvas] could not remove the staged install copy', error));
		}
	}

	private async _launch(attachment: IParadisMobileAttachment, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const resolved = await this._resolve(attachment, signal);
		const appId = requireAppId(resolved.platform, args.appId);
		await this._commands.launch(resolved.platform, resolved.nativeId, appId, args.relaunch === true, signal);
		// 前面のアプリが変わると画面の向きも変わりうるので、覚えた大きさは捨てる（次のジェスチャーで取り直す）
		// 台帳の id と一覧の今の id の両方（同じ端末を、起動前の id で持つペインと起動後の id で持つペインがありうる）
		this._screenSizes.delete(resolved.attachedId);
		this._screenSizes.delete(resolved.device.id);
		// 起動の直後は回転も遅いので、しばらくは回転を待つ上限を延ばす
		const launchedAt = this._now();
		this._launchedAt.set(resolved.attachedId, launchedAt);
		this._launchedAt.set(resolved.device.id, launchedAt);
		return textResult(`Launched ${appId} on ${resolved.device.name}.`);
	}

	private async _grant(attachment: IParadisMobileAttachment, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const resolved = await this._resolve(attachment, signal);
		const appId = requireAppId(resolved.platform, args.appId);
		const permission = paradisResolveMobilePermission(resolved.platform, args.permission);
		if (!permission) {
			return errorResult(`"permission" must be one of: ${paradisMobilePermissionNames(resolved.platform).join(', ')}.`);
		}
		// 付けるのは、その端末に利用者が入れたそのアプリだけ。OS のアプリかどうかは名前ではなく端末に聞く。
		// 入っていない ID へ前もって付けておくこともしない
		const kind = await this._commands.appKind(resolved.platform, resolved.nativeId, appId, signal);
		if (kind === 'missing') {
			return errorResult(`${appId} is not installed on ${resolved.device.name}. Install it with mobile_install_app first.`);
		}
		if (kind === 'system') {
			return errorResult(`${appId} is part of the operating system. Para Code only grants permissions to apps the user installed.`);
		}
		await this._commands.grantPermission(resolved.platform, resolved.nativeId, appId, permission, signal);
		this._logService?.info(`[paradis-mobile-canvas] granted a permission on ${resolved.device.name}`);
		return textResult(`Granted ${permission} to ${appId} on ${resolved.device.name}.${resolved.platform === 'ios' ? ' iOS may have stopped the app if it was running.' : ''}`);
	}

	/**
	 * そのペインに割り当てられた端末を、コマンド（simctl / adb）を打てる形まで解く。
	 * 起動中で、端末の種類と番号（UDID / シリアル）が分かる必要がある。
	 */
	private async _resolve(attachment: IParadisMobileAttachment, signal: AbortSignal | undefined): Promise<IResolvedDevice> {
		// 起動前の AVD で割り当てた Android は、起動すると id が serial に替わる（同じ端末として引く）
		const device = paradisFindMobileDevice(await this._ledger.listDevices(signal), attachment.deviceId);
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
		return { device, platform, nativeId: device.udid, attachedId: attachment.deviceId };
	}
}

/** 画面（スクショ）の縦横が、頼んだ向きに合っているか。上下逆さは縦と区別できないので縦として見る。 */
function orientationSettled(target: ParadisMobileOrientation, screen: IParadisScreen): boolean {
	return target.startsWith('landscape') ? screen.width > screen.height : screen.height > screen.width;
}

/**
 * 点が画面の外か。スクショから大きさが分かったときはその大きさで見る。端末の向きからの推定は画面とずれうるので、
 * そのときは縦横どちらの向きでも入る正方形で見る（ホストに任せる寄り）。
 */
function isOutside(point: IParadisPoint, screen: IParadisScreen): boolean {
	const side = Math.max(screen.width, screen.height);
	return !paradisIsInsideScreen(point, screen.fromScreenshot ? screen : { width: side, height: side });
}

function describeScreen(screen: IParadisScreen): object {
	return { pointWidth: screen.width, pointHeight: screen.height, scale: screen.scale, ...(screen.fromScreenshot ? {} : { note: 'Estimated from the device orientation because no screenshot was available; take a screenshot to confirm.' }) };
}

/** 承認されなかったときの返事。拒否と自動の断りの文だけ呼び出し側が決める。 */
function refusal(outcome: ParadisMobileDeviceRequestOutcome | undefined, denied: string, recentlyDenied: string): IToolResult {
	switch (outcome) {
		case 'denied':
			return jsonResult({ approved: false, message: denied });
		case 'recentlyDenied':
			return errorResult(recentlyDenied);
		case 'busy':
			return errorResult('Another request from this pane is still waiting for the user\'s answer.');
		case 'paneUnresolved':
			return errorResult('Para Code could not find this terminal pane in its window (it may be restoring, or it was closed). Retry in a few seconds.');
		case 'unanswered':
			return jsonResult({ approved: false, message: REQUEST_UNANSWERED_MESSAGE });
		case 'cancelled':
			return jsonResult({ approved: false, message: REQUEST_CANCELLED_MESSAGE });
		case 'timedOut':
		default:
			// 時間切れ・形の違う応答は、どれも承認として扱わない
			return jsonResult({ approved: false, timedOut: true, message: REQUEST_TIMEOUT_MESSAGE });
	}
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
