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
//   1. 端末を指すIDを **エージェントに一切渡さない**。操作系ツールは deviceId 引数を持たず、
//      サーバー側がそのペインにアタッチされている端末を注入する。これにより「他ペインの端末IDを
//      推測して叩く」という攻撃面が原理的に消える（引数を検証して弾く方式より強い）。
//   2. アタッチはユーザーの操作（アタッチUI）でのみ行う。エージェントは自分に何が割り当てられて
//      いるかを読めるだけで、割り当てを変えられない。
//   3. アタッチはスペース（ワークスペース）に紐づく。別スペースのペインからは見えず、
//      スペースが畳まれたら解除される。
//
// 台帳を ParadisAgentBrowserService へ相乗りさせず別サービスにしているのは、あちらの
// `_authorityFaulted` が一度立つとレンダラ操作が全滅する作りで、モバイル側の不調が
// ブラウザ共有を道連れにしてしまうため。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisMobileAttachment, IParadisMobileCanvasSnapshot, IParadisMobileDevice } from '../common/paradisMobileCanvas.js';
import { ParadisMobileCanvasHostClient, ParadisMobileCanvasUnavailableError } from './paradisMobileCanvasHostClient.js';

/** MCPツールが返す標準形。`isError` を立てるとエージェント側で失敗として扱われる。 */
interface IToolResult {
	content: { type: 'text'; text: string }[] | { type: 'image'; data: string; mimeType: string }[];
	isError?: boolean;
	structuredContent?: unknown;
}

const TOOLS: IParadisMcpToolDefinition[] = [
	{
		name: 'mobile_list_devices',
		description: 'List the local iOS simulators and Android emulators known to Para Code, and show which one (if any) is attached to this terminal pane. Use this to tell the user what is available; you cannot attach a device yourself, the user does that from Para Code.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'mobile_get_attached_device',
		description: 'Get the mobile device attached to this terminal pane, including the native UDID/serial you need for deploy commands (for example "xcrun simctl install <udid> App.app" or "adb -s <serial> install app.apk"). Returns an error if the user has not attached a device to this pane yet.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'mobile_screenshot',
		description: 'Take a PNG screenshot of the mobile device attached to this terminal pane and return it as an image. Use this to see what is currently on screen before deciding where to tap.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'mobile_ui_snapshot',
		description: 'Get the accessibility tree of the screen currently shown on the mobile device attached to this terminal pane. Prefer this over a screenshot when you need element labels, identifiers, or exact coordinates to tap.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'mobile_tap',
		description: 'Tap the mobile device attached to this terminal pane at a point, in the device\'s own screen coordinates (get them from mobile_ui_snapshot).',
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
		description: 'Swipe or drag on the mobile device attached to this terminal pane, in the device\'s own screen coordinates. Use this to scroll a list or dismiss a sheet.',
		inputSchema: {
			type: 'object',
			properties: {
				startX: { type: 'number' },
				startY: { type: 'number' },
				endX: { type: 'number' },
				endY: { type: 'number' },
				duration: { type: 'number', description: 'Gesture duration in seconds. Defaults to a natural swipe.' },
			},
			required: ['startX', 'startY', 'endX', 'endY'],
			additionalProperties: false,
		},
	},
	{
		name: 'mobile_type_text',
		description: 'Type text into the focused field of the mobile device attached to this terminal pane. Tap the field first so it has focus.',
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

export class ParadisMobileCanvasService extends Disposable implements IParadisMcpToolProvider {

	/** ペイントークン → アタッチ内容。1ペインにつき同時に1台まで。 */
	private readonly _attachments = new Map<string, IParadisMobileAttachment>();

	constructor(
		private readonly _hostClient: ParadisMobileCanvasHostClient,
		private readonly _logService: ILogService,
	) {
		super();
	}

	// --- アタッチ台帳（renderer のアタッチUIから IPC 経由で操作される） ---

	/**
	 * 端末一覧と現在のアタッチ状況をまとめて返す。ホストが使えない場合も
	 * 例外にせず `unavailableReason` を載せて返し、UIが理由を出せるようにする。
	 */
	async getSnapshot(signal?: AbortSignal): Promise<IParadisMobileCanvasSnapshot> {
		const attachments = [...this._attachments.values()];
		try {
			return { devices: await this._listDevices(signal), attachments };
		} catch (error) {
			return { devices: [], attachments, unavailableReason: toMessage(error) };
		}
	}

	/**
	 * ペインへ端末をアタッチする。同じペインの既存のアタッチは置き換える（1ペイン1台）。
	 * 同じ端末が別のペインにアタッチされている場合は拒否する（取り合いを起こさないため）。
	 *
	 * @param stateKey ペインが属するスペースの識別子。スペース管理下でなければ `undefined`。
	 */
	async attach(paneToken: string, deviceId: string, stateKey: string | undefined, signal?: AbortSignal): Promise<IParadisMobileAttachment> {
		for (const existing of this._attachments.values()) {
			if (existing.deviceId === deviceId && existing.paneToken !== paneToken) {
				throw new Error(`${existing.deviceName} is already attached to another terminal pane.`);
			}
		}
		const device = (await this._listDevices(signal)).find(candidate => candidate.id === deviceId);
		if (!device) {
			throw new Error(`Unknown mobile device: ${deviceId}`);
		}
		const attachment: IParadisMobileAttachment = {
			paneToken,
			deviceId: device.id,
			deviceName: device.name,
			stateKey,
			attachedAt: Date.now(),
		};
		this._attachments.set(paneToken, attachment);
		this._logService.info(`[paradis-mobile-canvas] attached ${device.name} to a terminal pane`);
		return attachment;
	}

	/** ペインのアタッチを解除する。アタッチが無ければ何もしない。 */
	detach(paneToken: string): void {
		if (this._attachments.delete(paneToken)) {
			this._logService.info('[paradis-mobile-canvas] detached a terminal pane');
		}
	}

	/**
	 * スペースが畳まれた／破棄されたときに、そのスペースに属するアタッチを一括解除する。
	 * ブラウザページ共有がスペース切替でバインドを retire するのと同じ考え方。
	 */
	releaseScope(stateKey: string): void {
		for (const [token, attachment] of [...this._attachments]) {
			if (attachment.stateKey === stateKey) {
				this._attachments.delete(token);
			}
		}
	}

	/** 現在のアタッチ一覧（UIの表示用）。 */
	listAttachments(): readonly IParadisMobileAttachment[] {
		return [...this._attachments.values()];
	}

	// --- MCPツールプロバイダ ---

	listTools(): readonly IParadisMcpToolDefinition[] {
		return TOOLS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal): Promise<unknown | undefined> {
		if (!TOOLS.some(tool => tool.name === name)) {
			return undefined;
		}
		const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
		try {
			return await this._callTool(paneToken, name, record, signal);
		} catch (error) {
			if (error instanceof ParadisMobileCanvasUnavailableError) {
				return errorResult(`${toMessage(error)} Mobile Canvas needs Xcode for iOS simulators, or the Android SDK (emulator/adb on PATH) for Android emulators.`);
			}
			return errorResult(toMessage(error));
		}
	}

	private async _callTool(paneToken: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		if (name === 'mobile_list_devices') {
			const devices = await this._listDevices(signal);
			const attached = this._attachments.get(paneToken);
			return jsonResult({
				devices: devices.map(device => ({ ...device, attachedToThisPane: device.id === attached?.deviceId })),
				attachedToThisPane: attached ? { deviceId: attached.deviceId, name: attached.deviceName } : null,
				hint: attached
					? undefined
					: 'No device is attached to this terminal pane. Ask the user to attach one from Para Code (the "Mobile Devices" tab of the sharing dialog); you cannot attach it yourself.',
			});
		}

		// ここから先はアタッチされた端末が要る。deviceId は引数から取らず、必ず台帳から解決する。
		const attachment = this._requireAttachment(paneToken);
		const id = encodeURIComponent(attachment.deviceId);

		switch (name) {
			case 'mobile_get_attached_device': {
				const device = await this._hostClient.request('GET', `/api/v1/devices/${id}`, undefined, signal);
				return jsonResult(device);
			}
			case 'mobile_screenshot': {
				const png = await this._hostClient.requestBinary(`/api/v1/devices/${id}/screenshot`, signal);
				return {
					content: [{ type: 'image', data: encodeBase64(png), mimeType: 'image/png' }],
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
					duration: optionalNumber(args, 'duration'),
				};
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/swipe`, body, signal);
				return textResult(`Swiped ${attachment.deviceName} from (${body.startX}, ${body.startY}) to (${body.endX}, ${body.endY}).`);
			}
			case 'mobile_type_text': {
				const text = requireString(args, 'text');
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/text`, { text }, signal);
				return textResult(`Typed ${text.length} characters into ${attachment.deviceName}.`);
			}
			case 'mobile_press_button': {
				const button = requireString(args, 'button');
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/button`, { button }, signal);
				return textResult(`Pressed "${button}" on ${attachment.deviceName}.`);
			}
			case 'mobile_read_log': {
				const seconds = Math.max(1, Math.round(optionalNumber(args, 'seconds') ?? 60));
				const query = new URLSearchParams({ seconds: String(seconds), limit: '500' });
				const text = typeof args['text'] === 'string' ? args['text'] : undefined;
				const bundleId = typeof args['bundleId'] === 'string' ? args['bundleId'] : undefined;
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

	private _requireAttachment(paneToken: string): IParadisMobileAttachment {
		const attachment = this._attachments.get(paneToken);
		if (!attachment) {
			throw new Error('No mobile device is attached to this terminal pane. Ask the user to attach one from Para Code (the "Mobile Devices" tab of the sharing dialog), then try again.');
		}
		return attachment;
	}

	private async _listDevices(signal?: AbortSignal): Promise<IParadisMobileDevice[]> {
		const raw = await this._hostClient.request('GET', '/api/v1/devices', undefined, signal);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.map(entry => normalizeDevice(entry)).filter((device): device is IParadisMobileDevice => !!device);
	}
}

function normalizeDevice(raw: unknown): IParadisMobileDevice | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const id = record['id'];
	if (typeof id !== 'string' || !id) {
		return undefined;
	}
	const state = typeof record['state'] === 'string' ? record['state'] : '';
	return {
		id,
		udid: typeof record['udid'] === 'string' ? record['udid'] : undefined,
		name: typeof record['name'] === 'string' ? record['name'] : id,
		platform: typeof record['platform'] === 'string' ? record['platform'] : '',
		runtime: typeof record['runtime'] === 'string' ? record['runtime'] : undefined,
		state,
		// ホストは iOS を `Booted`、Android を `device` のように別表記で返すため、
		// 「起動中か」の判定はここで1箇所に寄せる。
		isRunning: /^(booted|running|device|online)$/i.test(state),
	};
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
