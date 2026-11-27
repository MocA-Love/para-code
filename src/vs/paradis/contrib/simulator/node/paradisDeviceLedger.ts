/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイル端末⇔ターミナルペインのアタッチ台帳と、エージェントCLI向けMCPツールの実装。
//
// 設計の要点（ブラウザページ共有 ParadisAgentBrowserService と同じ思想）:
//
//   1. 操作系ツールが触れるのは、**そのペインに割り当てた端末だけ**。1 つのペインに 10 台まで割り当てられ、
//      任意の引数 `device`（id か名前）はその中から 1 台を選ぶためだけに使う。`device` は端末の一覧からは引かず、
//      ペインの割り当ての中だけで引くので、「他ペインの端末IDを推測して叩く」ことはできない
//      （決まりと帳面は simulator/common/paradisMobileAttachmentBook.ts）。省いたら、最後に割り当てた端末に当てる。
//   2. アタッチはユーザーの操作（アタッチUI、またはエージェントの要求を承認ダイアログで認める）でのみ行う。
//      エージェントは要求できるだけで、自分で割り当てを変えられない（要求は paradisMobileDeviceOpsToolProvider.ts）。
//   3. アタッチはターミナルが終わったら自動で外れる。スペースを切り替えても維持する
//      （ターミナルとエージェントは生き続けるので、端末だけ取り上げると作業途中の相手が壊れる）。
//
// 台帳を ParadisAgentBrowserService へ相乗りさせず別サービスにしているのは、あちらの
// `_authorityFaulted` が一度立つとレンダラ操作が全滅する作りで、モバイル側の不調が
// ブラウザ共有を道連れにしてしまうため。

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisMobileAttachment, IParadisMobileCanvasSnapshot, IParadisMobileDevice, IParadisMobileDisplay, paradisFindMobileDevice } from '../common/paradisMobileCanvas.js';
import { IParadisMobileToolResult, IParadisMobileTarget, PARADIS_MOBILE_MAX_DEVICES_PER_PANE, ParadisMobileAttachResult, ParadisMobileAttachmentBook, paradisStampMobileDevice, paradisWithMobileDeviceArgument } from '../common/paradisMobileAttachmentBook.js';
import { PARADIS_MOBILE_SWIPE_DEFAULT_SECONDS, paradisCheckTypedText, paradisDeviceHeldByAnotherPane } from '../common/paradisMobileDeviceOps.js';
import { PARADIS_SIMULATOR_DEVICE_ID_PREFIX } from '../common/paradisSimulator.js';
import { IParadisMobileDeviceLedger, IParadisMobileHostRequester } from './paradisSimulatorDeviceOps.js';

/** MCPツールが返す標準形。`isError` を立てるとエージェント側で失敗として扱われる。 */
type IToolResult = IParadisMobileToolResult;

const LIST_DEVICES_TOOL: IParadisMcpToolDefinition = {
	name: 'mobile_list_devices',
	description: `List the local iOS simulators and Android emulators known to Para Code, and show which ones are attached to this terminal pane (attachedDevices; a pane can hold up to ${PARADIS_MOBILE_MAX_DEVICES_PER_PANE}). The one marked current is used by every mobile tool when you omit "device". To use a device that is not attached yet, call mobile_request_device: the user approves it in Para Code.`,
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** 割り当てた端末を操作する道具。どれも任意の引数 `device` を受ける（下で足す）。 */
const DEVICE_TOOLS: IParadisMcpToolDefinition[] = [
	{
		name: 'mobile_get_attached_device',
		description: 'Get a mobile device attached to this terminal pane, including the native UDID/serial you need for deploy commands (for example "xcrun simctl install <udid> App.app" or "adb -s <serial> install app.apk"), and the list of every device attached to this pane (attachedDevices). Returns an error if the user has not attached a device to this pane yet.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'mobile_screenshot',
		description: 'Take a PNG screenshot of the mobile device attached to this terminal pane. Returns the image plus the screen geometry. IMPORTANT: the image is in PIXELS but every input tool (mobile_tap, mobile_swipe) takes POINTS, and pixels = points x scale, so coordinates read off this image must be divided by the scale before you tap. Prefer mobile_ui_tap, which needs no coordinates at all.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'mobile_ui_snapshot',
		description: 'Get the accessibility tree of the screen currently shown on the mobile device attached to this terminal pane. Prefer this over a screenshot when you need element labels, identifiers, or exact coordinates to tap.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'mobile_tap',
		description: 'Tap the mobile device attached to this terminal pane at a point, in POINTS (not screenshot pixels). Prefer mobile_ui_tap when you can name the element: it needs no coordinates and reports what it actually hit. Use this when you must tap a specific spot.',
		inputSchema: {
			type: 'object',
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
		name: 'mobile_swipe',
		description: 'Swipe or drag on the mobile device attached to this terminal pane, in POINTS (not screenshot pixels). Use this to scroll a list or dismiss a sheet.',
		inputSchema: {
			type: 'object',
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
		name: 'mobile_type_text',
		description: 'Type text into the focused field of the mobile device attached to this terminal pane. Tap the field first so it has focus. Returns the value the field actually ended up with, so you can see straight away when an IME rewrote what you typed.',
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string' } },
			required: ['text'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_press_button',
		description: 'Press a hardware button on the mobile device attached to this terminal pane, such as home, back, or the app switcher.',
		inputSchema: {
			type: 'object',
			properties: { button: { type: 'string', description: 'Button name, for example "home", "back", "power", "volumeUp".' } },
			required: ['button'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_ui_find',
		description: 'Find elements on the screen of the mobile device attached to this terminal pane by text, accessibility identifier, or role. Returns each match with the centre point you can pass straight to mobile_tap. Cheaper and easier to read than mobile_ui_snapshot when you already know what you are looking for.',
		inputSchema: {
			type: 'object',
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
		name: 'mobile_ui_tap',
		description: 'Tap an element on the mobile device attached to this terminal pane by naming it (text, accessibility identifier, or role) instead of computing coordinates. Returns the element that was actually hit and how many candidates matched, so you can tell a precise hit from an ambiguous one without taking another screenshot. This is the preferred way to tap.',
		inputSchema: {
			type: 'object',
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
		name: 'mobile_read_log',
		description: 'Read recent log output from the mobile device attached to this terminal pane. Use this to see a crash or an error your app printed after you drove it through a flow.',
		inputSchema: {
			type: 'object',
			properties: {
				seconds: { type: 'number', description: 'How far back to read, in seconds. Defaults to 60.' },
				text: { type: 'string', description: 'Only return lines containing this text.' },
				bundleId: { type: 'string', description: 'Only return lines from this app bundle id / package name.' },
			},
			additionalProperties: false,
		},
	},
];

const TOOLS: IParadisMcpToolDefinition[] = [LIST_DEVICES_TOOL, ...DEVICE_TOOLS.map(paradisWithMobileDeviceArgument)];

/** アタッチがアイドル扱いになるまでの時間。ウィンドウを閉じたペインの幽霊行を掃除するためのもの。 */
const PARADIS_MOBILE_ATTACHMENT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
/** アイドルアタッチの掃除周期。 */
const PARADIS_MOBILE_ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export class ParadisMobileCanvasService extends Disposable implements IParadisMcpToolProvider, IParadisMobileDeviceLedger {

	/**
	 * ペイン → 割り当てた端末（1 ペインに 10 台まで）。最終利用時刻は端末ごとに持ち、MCPツール経由の実利用でのみ
	 * 進める（snapshot/list のUI表示では進めない: 表示しているだけで使っていない割り当ては掃除対象にする）。
	 */
	private readonly _book = new ParadisMobileAttachmentBook();

	constructor(
		// シミュレータの作り直し（③）で、iOS を serve-sim へ回す振り分け（simulator/node/paradisMobileHostRouter.ts）も受ける
		private readonly _hostClient: IParadisMobileHostRequester,
		private readonly _logService: ILogService,
	) {
		super();
		// アタッチ台帳の定期掃除。renderer 側は「自分のウィンドウで実際に消えたトークン」しか
		// detach しないため、ウィンドウごと閉じられたペインのエントリは誰にも解除されず
		// shared process 寿命分残る（UIには「別のペインが使用中」の幽霊行として映る）。
		// 実利用（MCPツール呼び出し）がないまま TTL を過ぎたエントリを自前で落とす。
		const sweepTimer = setInterval(() => this._sweepIdleAttachments(), PARADIS_MOBILE_ATTACHMENT_SWEEP_INTERVAL_MS);
		// 掃除だけで shared process を起こし続けないようにする（mobileRelayService と同じ手当て。
		// キャストは dom/node の setInterval 型衝突を避けるため。Electron のテストランナーは renderer で動き、
		// setInterval が数値を返すので、unref が無ければ何もしない）。
		(sweepTimer as unknown as Partial<NodeJS.Timeout>).unref?.();
		this._register({ dispose: () => clearInterval(sweepTimer) });
	}

	private _sweepIdleAttachments(): void {
		for (const dropped of this._book.sweep(Date.now() - PARADIS_MOBILE_ATTACHMENT_IDLE_TTL_MS)) {
			this._logService.info(`[paradis-mobile-canvas] dropped an idle attachment (idle since ${new Date(dropped.lastActiveAt).toISOString()})`);
		}
	}

	// --- アタッチ台帳（renderer のアタッチUIから IPC 経由で操作される） ---

	/**
	 * 端末一覧と現在のアタッチ状況をまとめて返す。ホストが使えない場合も
	 * 例外にせず `unavailableReason` を載せて返し、UIが理由を出せるようにする。
	 */
	async getSnapshot(signal?: AbortSignal): Promise<IParadisMobileCanvasSnapshot> {
		try {
			const devices = await this._listDevices(signal);
			const notice = this._listNotice?.();
			return { devices, attachments: this._book.list(), ...(notice ? { notice } : {}) };
		} catch (error) {
			return { devices: [], attachments: this._book.list(), unavailableReason: toMessage(error) };
		}
	}

	/**
	 * ペインへ端末を足す（利用者が共有ダイアログから渡すとき）。1 つのペインに 10 台まで。既に持っている端末なら
	 * そのまま返す。足した端末が、そのペインの今の端末（`device` を省いた道具が当たる端末）になる。
	 *
	 * **1台の端末を複数のペインへ同時にアタッチするのは許す**（同じ端末を複数のエージェントで見る／触るのは
	 * 実際に有用な使い方で、禁じる理由がないため）。エージェントの要求（{@link attachIfFree}）では断る。
	 *
	 * @param stateKey ペインが属するスペースの識別子。スペース管理下でなければ `undefined`。
	 */
	async attach(paneToken: string, deviceId: string, stateKey: string | undefined, signal?: AbortSignal): Promise<IParadisMobileAttachment> {
		const devices = await this._listDevices(signal);
		const device = devices.find(candidate => candidate.id === deviceId);
		if (!device) {
			throw new Error(`Unknown mobile device: ${deviceId}`);
		}
		const result = this._book.attach(paneToken, device, devices, stateKey, Date.now());
		if (result.refused !== undefined) {
			throw new Error(`This terminal pane already has ${PARADIS_MOBILE_MAX_DEVICES_PER_PANE} devices attached. Detach one first.`);
		}
		if (result.added) {
			this._logService.info(`[paradis-mobile-canvas] attached ${device.name} to a terminal pane (${this._book.listPane(paneToken).length} attached)`);
		}
		return result.attachment;
	}

	/**
	 * エージェントの要求を利用者が承認したときの割り当て。端末一覧を待ち終えた後、書き込む直前に
	 * 同期的に「ほかのペインが使っていないか」「上限を超えないか」を確かめる（確かめてから書き込むまでの間に
	 * await を挟まない。別のウィンドウの2つのペインが同じ端末をほぼ同時に承認されても、二重に割り当てないように）。
	 * `releaseDeviceId` は、上限のときに利用者が選んだ「外す端末」。外すのと足すのを一度に行う。
	 * @returns 割り当てたもの。端末が無いときは undefined、断ったときはその理由
	 */
	async attachIfFree(paneToken: string, deviceId: string, stateKey: string | undefined, signal?: AbortSignal, releaseDeviceId?: string): Promise<ParadisMobileAttachResult | undefined> {
		const devices = await this._listDevices(signal);
		const device = devices.find(candidate => candidate.id === deviceId);
		if (!device) {
			return undefined;
		}
		const result = this._book.attach(paneToken, device, devices, stateKey, Date.now(), { onlyIfFree: true, ...(releaseDeviceId !== undefined ? { releaseDeviceId } : {}) });
		if (result.refused === undefined && result.added) {
			this._logService.info(`[paradis-mobile-canvas] attached ${device.name} to a terminal pane after the user approved the request (${this._book.listPane(paneToken).length} attached${result.released ? ', one detached to make room' : ''})`);
		}
		return result;
	}

	/**
	 * ペインのアタッチを解除する。`deviceId`（台帳の id）を省くと、そのペインの全部を外す（ターミナルを閉じたとき）。
	 * アタッチが無ければ何もしない。
	 */
	detach(paneToken: string, deviceId?: string): readonly IParadisMobileAttachment[] {
		const removed = this._book.detach(paneToken, deviceId);
		if (removed.length) {
			this._logService.info(`[paradis-mobile-canvas] detached ${removed.length} device(s) from a terminal pane`);
		}
		return removed;
	}

	/** 現在のアタッチ一覧（UIの表示用）。各ペインの今の端末に `current` が付く。 */
	listAttachments(): readonly IParadisMobileAttachment[] {
		return this._book.list();
	}

	/** そのペインのアタッチ（割り当てた順。最後が今の端末）。 */
	listPaneAttachments(paneToken: string): readonly IParadisMobileAttachment[] {
		return this._book.listPane(paneToken);
	}

	/**
	 * 道具が操作する端末。`device`（道具の引数）はそのペインの割り当ての中だけで引き、省いたら今の端末。
	 * MCP ツールからの利用として、その端末の最終利用時刻を進める。決まらなければ、エージェントに返す文で throw する。
	 */
	resolveTarget(paneToken: string, device: unknown, signal?: AbortSignal): Promise<IParadisMobileTarget> {
		return this._book.resolve(paneToken, device, () => this._listDevices(signal), Date.now());
	}

	listDevices(signal?: AbortSignal): Promise<IParadisMobileDevice[]> {
		return this._listDevices(signal);
	}

	private _listNotice: (() => string | undefined) | undefined;

	/**
	 * 一覧に添える知らせを返す関数を渡す（シミュレータの作り直し ⑥a: adb が無いので Android を出せないときの入れ方の説明）。
	 * mobile_list_devices の結果と、共有ダイアログの端末の一覧に出す。
	 */
	setListNotice(notice: () => string | undefined): void {
		this._listNotice = notice;
	}

	/** このサービスと寿命をそろえる後始末（別のプロバイダの登録など）を預かる。 */
	own(disposable: IDisposable): void {
		this._register(disposable);
	}

	// --- MCPツールプロバイダ ---

	listTools(): readonly IParadisMcpToolDefinition[] {
		return TOOLS;
	}

	// ここのツール（画面の読み取りと入力）はトークンだけで動かす。利用者がその端末をそのペインへ渡した後の
	// 画面の操作なので、接続元の確認は掛けない（tmux・WSL・採用した Codex app-server では確認を通らず、
	// 使えなくなるため）。確認を掛けるのは paradisMobileDeviceOpsToolProvider.ts の要求・アプリの操作だけ。
	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal): Promise<unknown | undefined> {
		if (!TOOLS.some(tool => tool.name === name)) {
			return undefined;
		}
		const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
		try {
			return await this._callTool(paneToken, name, record, signal);
		} catch (error) {
			return errorResult(toMessage(error));
		}
	}

	private async _callTool(paneToken: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		if (name === 'mobile_list_devices') {
			const devices = await this._listDevices(signal);
			const attached = this._book.listPane(paneToken);
			const current = attached[attached.length - 1];
			const notice = this._listNotice?.();
			// 起動前の AVD で割り当てた端末は、起動すると id が serial に替わる。同じ端末として印を付ける
			const attachedDevices = new Set(attached.map(attachment => paradisFindMobileDevice(devices, attachment.deviceId)));
			const currentDevice = paradisFindMobileDevice(devices, current?.deviceId);
			this._book.touchPane(paneToken, Date.now());
			return jsonResult({
				// ほかのペインが使っている端末は mobile_request_device で要求できないので、選ぶ前に分かるようにする
				devices: devices.map(device => ({
					...device,
					attachedToThisPane: attachedDevices.has(device),
					...(attached.length > 1 ? { currentForThisPane: device === currentDevice } : {}),
					usedByAnotherPane: paradisDeviceHeldByAnotherPane(paneToken, device, devices, this.listAttachments()),
				})),
				// 今の端末（`device` を省いた道具が当たる端末。最後に割り当てたもの）。1 台だけのときは、その 1 台
				attachedToThisPane: current ? { deviceId: current.deviceId, name: current.deviceName } : null,
				// このペインに割り当てている端末の全部（割り当てた順）。道具の `device` にはこの id か name を渡す
				attachedDevices: attached.map(attachment => ({ id: attachment.deviceId, name: attachment.deviceName, current: attachment === current })),
				maxAttachedDevices: PARADIS_MOBILE_MAX_DEVICES_PER_PANE,
				hint: current
					? attached.length > 1 ? `${attached.length} devices are attached to this terminal pane. Pass "device" (an id or name from attachedDevices) to every mobile tool; without it they act on the current one, ${current.deviceName}.` : undefined
					: 'No device is attached to this terminal pane. Call mobile_request_device with the id or name of a device no other pane is using: the user approves it in Para Code. The user can also attach one from the "Mobile Devices" tab of the sharing dialog.',
				...(notice ? { notice } : {}),
			});
		}

		// ここから先は割り当てた端末が要る。`device` はそのペインの割り当ての中だけで引く（省いたら今の端末）。
		// 返事には、成功でも失敗でも、操作した端末の名前と id を入れる
		const target = await this.resolveTarget(paneToken, args.device, signal);
		try {
			return paradisStampMobileDevice(await this._callDeviceTool(paneToken, target.attachment, name, args, signal), target);
		} catch (error) {
			return paradisStampMobileDevice(errorResult(toMessage(error)), target);
		}
	}

	private async _callDeviceTool(paneToken: string, attachment: IParadisMobileAttachment, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const id = encodeURIComponent(attachment.deviceId);

		switch (name) {
			case 'mobile_get_attached_device': {
				const device = await this._hostClient.request('GET', `/api/v1/devices/${id}`, undefined, signal);
				// mobile_list_devices は OS の版を `runtime` で返す。ここでも同じ名前で読めるようにする（ホストの `runtimeName` も残す）
				const runtime = device && typeof device === 'object' ? firstString((device as Record<string, unknown>).runtimeName, (device as Record<string, unknown>).osVersion) : undefined;
				const attached = this._book.listPane(paneToken);
				const attachedDevices = attached.map((entry, index) => ({ id: entry.deviceId, name: entry.deviceName, current: index === attached.length - 1 }));
				return jsonResult(device && typeof device === 'object' && !Array.isArray(device) ? { ...device, ...(runtime !== undefined ? { runtime } : {}), attachedDevices } : device);
			}
			case 'mobile_screenshot': {
				const png = await this._hostClient.requestBinary(`/api/v1/devices/${id}/screenshot`, signal);
				// 画像だけ返すと「見えた座標」でタップして必ず外す。ピクセルとポイントの
				// 対応をその場で添えて、変換を忘れられないようにする。
				// 一覧に画面の大きさが無い端末（Android は一覧に載せない）は、端末に直接尋ねる
				const display = paradisFindMobileDevice(await this._listDevices(signal), attachment.deviceId)?.display
					?? normalizeDisplay(await this._hostClient.request('GET', `/api/v1/devices/${id}/display`, undefined, signal).catch(() => undefined));
				const geometry = display
					? `Screenshot is ${display.pixelWidth}x${display.pixelHeight} pixels. Input tools take points: the screen is ${display.pointWidth}x${display.pointHeight} points at scale ${display.scale} (points = pixels / ${display.scale}).`
					: 'Screen geometry is unavailable, so treat coordinates read off this image with care: input tools take points, not pixels.';
				return {
					content: [
						{ type: 'text', text: geometry },
						{ type: 'image', data: encodeBase64(png), mimeType: 'image/png' },
					],
					structuredContent: display,
				};
			}
			case 'mobile_ui_snapshot': {
				const snapshot = await this._hostClient.request('GET', `/api/v1/devices/${id}/ui`, undefined, signal);
				return jsonResult(snapshot);
			}
			case 'mobile_tap': {
				const body = { x: requireNumber(args, 'x'), y: requireNumber(args, 'y'), duration: optionalNumber(args, 'duration') };
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/tap`, body, signal);
				return textResult(`Tapped ${attachment.deviceName} at (${body.x}, ${body.y}).`);
			}
			case 'mobile_swipe': {
				const body = {
					startX: requireNumber(args, 'startX'),
					startY: requireNumber(args, 'startY'),
					endX: requireNumber(args, 'endX'),
					endY: requireNumber(args, 'endY'),
					// 省いたときにホストの既定（速すぎてページが送られない）に任せない。mobile_gesture と同じ値
					duration: optionalNumber(args, 'duration') ?? PARADIS_MOBILE_SWIPE_DEFAULT_SECONDS,
				};
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/swipe`, body, signal);
				return textResult(`Swiped ${attachment.deviceName} from (${body.startX}, ${body.startY}) to (${body.endX}, ${body.endY}).`);
			}
			case 'mobile_type_text': {
				const text = requireString(args, 'text');
				// 打つ前の欄の値（増えた部分だけを打った文字と比べるため）。iOS の木にはフォーカスの印が無く、打った後の木に
				// ホストが打つ前の値（valueBefore）を添えるので、ここでは読まない
				const before = attachment.deviceId.startsWith(PARADIS_SIMULATOR_DEVICE_ID_PREFIX) ? undefined : await this._readFocusedValue(id, signal);
				// 入れ方の知らせ（例: 端末のクリップボードを戻せなかった。シミュレータの作り直し ⑥b）があれば結果に添える
				const typedResponse = await this._hostClient.request('POST', `/api/v1/devices/${id}/input/text`, { text }, signal);
				const typedNote = typedResponse && typeof typedResponse === 'object' && typeof (typedResponse as { note?: unknown }).note === 'string' ? (typedResponse as { note: string }).note : undefined;
				// IMEが打った文字を別物へ変換していることがある（英字を打ったつもりでかなになる等）。
				// 呼び出し側がもう1往復しなくても気づけるよう、入力欄の実際の値を読み返して返す。
				const focused = await this._readFocusedValue(id, signal);
				if (focused === undefined) {
					return textResult(`Typed ${text.length} characters into ${attachment.deviceName}. Could not read the field back to confirm what it now contains.${typedNote ? ` ${typedNote}` : ''}`);
				}
				const valueBefore = focused.valueBefore ?? before?.value;
				const check = paradisCheckTypedText(text, valueBefore, focused.value);
				return jsonResult({
					typed: text,
					fieldValue: focused.value,
					...(valueBefore !== undefined ? { insertedText: check.inserted } : {}),
					fieldLabel: focused.label,
					matchesWhatWasTyped: check.matches,
					...(typedNote ? { note: typedNote } : {}),
					...(check.converted ? { converted: TYPED_TEXT_CONVERTED_NOTE } : {}),
				});
			}
			case 'mobile_press_button': {
				const button = requireString(args, 'button');
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/button`, { button }, signal);
				// ホームなどで画面が切り替わる間は、アクセシビリティの木が前のアプリのままのことがある（iOS で実測）
				return textResult(`Pressed "${button}" on ${attachment.deviceName}. If the screen changes, mobile_ui_snapshot may show the previous screen for a moment: read it again if it does.`);
			}
			case 'mobile_ui_find': {
				const result = await this._hostClient.request('POST', `/api/v1/devices/${id}/ui/find`, buildUiQuery(args), signal);
				return jsonResult(result);
			}
			case 'mobile_ui_tap': {
				const query = buildUiQuery(args);
				if (query.text === undefined && query.identifier === undefined && query.role === undefined) {
					throw new Error('Give at least one of "text", "identifier" or "role" so there is something to look for.');
				}
				const result = await this._hostClient.request('POST', `/api/v1/devices/${id}/ui/tap`, query, signal);
				return jsonResult(result);
			}
			case 'mobile_read_log': {
				const seconds = Math.max(1, Math.round(optionalNumber(args, 'seconds') ?? 60));
				const query = new URLSearchParams({ seconds: String(seconds), limit: '500' });
				const text = typeof args.text === 'string' ? args.text : undefined;
				const bundleId = typeof args.bundleId === 'string' ? args.bundleId : undefined;
				if (text) { query.set('text', text); }
				if (bundleId) { query.set('bundleId', bundleId); }
				const log = await this._hostClient.request('GET', `/api/v1/devices/${id}/log?${query.toString()}`, undefined, signal);
				return jsonResult(log);
			}
			default:
				// listTools と switch の取りこぼしを黙って握らないための保険。
				throw new Error(`Unhandled mobile tool: ${name}`);
		}
	}

	/**
	 * いまフォーカスされている入力欄の値を読む。アクセシビリティツリーを1回取って
	 * `focused` の要素を探すだけで、専用のAPIは無い。
	 */
	private async _readFocusedValue(encodedDeviceId: string, signal?: AbortSignal): Promise<{ value: string; label: string | undefined; valueBefore?: string } | undefined> {
		try {
			const snapshot = await this._hostClient.request('GET', `/api/v1/devices/${encodedDeviceId}/ui`, undefined, signal);
			const root = (snapshot as { root?: unknown } | undefined)?.root;
			const focused = findFocusedElement(root);
			if (!focused) {
				return undefined;
			}
			return {
				value: typeof focused.value === 'string' ? focused.value : '',
				label: typeof focused.label === 'string' ? focused.label : undefined,
				...(typeof focused.valueBefore === 'string' ? { valueBefore: focused.valueBefore } : {}),
			};
		} catch {
			// 読み返しはおまけ。取れなくても入力自体は済んでいるので失敗させない。
			return undefined;
		}
	}

	private async _listDevices(signal?: AbortSignal): Promise<IParadisMobileDevice[]> {
		const raw = await this._hostClient.request('GET', '/api/v1/devices', undefined, signal);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.map(entry => normalizeDevice(entry)).filter((device): device is IParadisMobileDevice => !!device);
	}
}

/** mobile_type_text の結果に添える知らせ（打った英数字が、端末のキーボードの言語で別の文字に変わった）。 */
const TYPED_TEXT_CONVERTED_NOTE = 'The field holds other characters than the ones typed: the keyboard language of the device (for example Japanese) converted the keys. Clear the field, ask the user to switch the device keyboard to English (or add an English keyboard in the device settings), then type again.';

function normalizeDevice(raw: unknown): IParadisMobileDevice | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const id = record.id;
	if (typeof id !== 'string' || !id) {
		return undefined;
	}
	const state = typeof record.state === 'string' ? record.state : '';
	return {
		id,
		udid: typeof record.udid === 'string' ? record.udid : undefined,
		name: typeof record.name === 'string' ? record.name : id,
		platform: typeof record.platform === 'string' ? record.platform : '',
		// ホストが返すのは `runtimeName`（例: iOS 26.5）と `osVersion`。`runtime` という項目は無い。
		runtime: firstString(record.runtimeName, record.osVersion),
		display: normalizeDisplay(record.display),
		state,
		// ホストは iOS を `Booted`、Android を `device` のように別表記で返すため、
		// 「起動中か」の判定はここで1箇所に寄せる。
		isRunning: /^(booted|running|device|online)$/i.test(state),
		...(typeof record.avdId === 'string' && record.avdId ? { avdId: record.avdId } : {}),
	};
}

/** MCPの引数から、ホストの UiQuery へそのまま渡せる形を作る。 */
function buildUiQuery(args: Record<string, unknown>): { text?: string; identifier?: string; role?: string; exact: boolean; interactableOnly: boolean; limit: number } {
	return {
		text: typeof args.text === 'string' && args.text ? args.text : undefined,
		identifier: typeof args.identifier === 'string' && args.identifier ? args.identifier : undefined,
		role: typeof args.role === 'string' && args.role ? args.role : undefined,
		exact: args.exact === true,
		interactableOnly: args.interactableOnly === true,
		limit: 20,
	};
}

/** アクセシビリティツリーを深さ優先でたどって、最初に見つかった focused な要素を返す。 */
function findFocusedElement(node: unknown): Record<string, unknown> | undefined {
	if (!node || typeof node !== 'object') {
		return undefined;
	}
	const record = node as Record<string, unknown>;
	if (record.focused === true) {
		return record;
	}
	const children = record.children;
	if (Array.isArray(children)) {
		for (const child of children) {
			const found = findFocusedElement(child);
			if (found) {
				return found;
			}
		}
	}
	return undefined;
}

/** 端末の画面寸法。入力はポイント、スクリーンショットはピクセルなので両方を保持する。 */
function normalizeDisplay(raw: unknown): IParadisMobileDisplay | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const num = (name: string): number | undefined => typeof record[name] === 'number' ? record[name] as number : undefined;
	const pointWidth = num('pointWidth');
	const pointHeight = num('pointHeight');
	if (pointWidth === undefined || pointHeight === undefined) {
		return undefined;
	}
	return {
		pixelWidth: num('pixelWidth') ?? 0,
		pixelHeight: num('pixelHeight') ?? 0,
		pointWidth,
		pointHeight,
		scale: num('scale') ?? 1,
		orientation: typeof record.orientation === 'string' ? record.orientation : undefined,
	};
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value) {
			return value;
		}
	}
	return undefined;
}

function jsonResult(value: unknown): IToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }], structuredContent: value };
}

function textResult(text: string): IToolResult {
	return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): IToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

function requireNumber(args: Record<string, unknown>, name: string): number {
	const value = args[name];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`"${name}" must be a number.`);
	}
	return value;
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

function requireString(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || !value) {
		throw new Error(`"${name}" must be a non-empty string.`);
	}
	return value;
}

function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
