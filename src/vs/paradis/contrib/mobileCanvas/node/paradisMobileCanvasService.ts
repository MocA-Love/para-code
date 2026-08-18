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
//   3. アタッチはターミナルが終わったら自動で外れる。スペースを切り替えても維持する
//      （ターミナルとエージェントは生き続けるので、端末だけ取り上げると作業途中の相手が壊れる）。
//
// 台帳を ParadisAgentBrowserService へ相乗りさせず別サービスにしているのは、あちらの
// `_authorityFaulted` が一度立つとレンダラ操作が全滅する作りで、モバイル側の不調が
// ブラウザ共有を道連れにしてしまうため。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisMobileAttachment, IParadisMobileCanvasSnapshot, IParadisMobileDevice, IParadisMobileDisplay } from '../common/paradisMobileCanvas.js';
import { ParadisMobileCanvasHostClient, ParadisMobileCanvasUnavailableError } from './paradisMobileCanvasHostClient.js';

/** MCPツールが返す標準形。`isError` を立てるとエージェント側で失敗として扱われる。 */
interface IToolResult {
	content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
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
				duration: { type: 'number', description: 'Gesture duration in seconds. Defaults to a natural swipe.' },
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
	 * ペインへ端末をアタッチする。同じペインの既存のアタッチは置き換える。
	 *
	 * 対応は「1ペインにつき1台」だけを守り、**1台の端末を複数のペインへ同時にアタッチするのは許す**。
	 * ツールが端末IDを取らない以上ペイン側は一意である必要があるが、逆向き（同じ端末を複数の
	 * エージェントで見る／触る）は実際に有用な使い方で、禁じる理由がないため。
	 *
	 * @param stateKey ペインが属するスペースの識別子。スペース管理下でなければ `undefined`。
	 */
	async attach(paneToken: string, deviceId: string, stateKey: string | undefined, signal?: AbortSignal): Promise<IParadisMobileAttachment> {
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
				// 画像だけ返すと「見えた座標」でタップして必ず外す。ピクセルとポイントの
				// 対応をその場で添えて、変換を忘れられないようにする。
				const display = (await this._listDevices(signal)).find(candidate => candidate.id === attachment.deviceId)?.display;
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
					duration: optionalNumber(args, 'duration'),
				};
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/swipe`, body, signal);
				return textResult(`Swiped ${attachment.deviceName} from (${body.startX}, ${body.startY}) to (${body.endX}, ${body.endY}).`);
			}
			case 'mobile_type_text': {
				const text = requireString(args, 'text');
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/text`, { text }, signal);
				// IMEが打った文字を別物へ変換していることがある（英字を打ったつもりでかなになる等）。
				// 呼び出し側がもう1往復しなくても気づけるよう、入力欄の実際の値を読み返して返す。
				const focused = await this._readFocusedValue(id, signal);
				if (focused === undefined) {
					return textResult(`Typed ${text.length} characters into ${attachment.deviceName}. Could not read the field back to confirm what it now contains.`);
				}
				return jsonResult({
					typed: text,
					fieldValue: focused.value,
					fieldLabel: focused.label,
					matchesWhatWasTyped: focused.value === text,
				});
			}
			case 'mobile_press_button': {
				const button = requireString(args, 'button');
				await this._hostClient.request('POST', `/api/v1/devices/${id}/input/button`, { button }, signal);
				return textResult(`Pressed "${button}" on ${attachment.deviceName}.`);
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

	/**
	 * いまフォーカスされている入力欄の値を読む。アクセシビリティツリーを1回取って
	 * `focused` の要素を探すだけで、専用のAPIは無い。
	 */
	private async _readFocusedValue(encodedDeviceId: string, signal?: AbortSignal): Promise<{ value: string; label: string | undefined } | undefined> {
		try {
			const snapshot = await this._hostClient.request('GET', `/api/v1/devices/${encodedDeviceId}/ui`, undefined, signal);
			const root = (snapshot as { root?: unknown } | undefined)?.root;
			const focused = findFocusedElement(root);
			if (!focused) {
				return undefined;
			}
			return {
				value: typeof focused['value'] === 'string' ? focused['value'] : '',
				label: typeof focused['label'] === 'string' ? focused['label'] : undefined,
			};
		} catch {
			// 読み返しはおまけ。取れなくても入力自体は済んでいるので失敗させない。
			return undefined;
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
		// ホストが返すのは `runtimeName`（例: iOS 26.5）と `osVersion`。`runtime` という項目は無い。
		runtime: firstString(record['runtimeName'], record['osVersion']),
		display: normalizeDisplay(record['display']),
		state,
		// ホストは iOS を `Booted`、Android を `device` のように別表記で返すため、
		// 「起動中か」の判定はここで1箇所に寄せる。
		isRunning: /^(booted|running|device|online)$/i.test(state),
	};
}

/** 端末の画面寸法。入力はポイント、スクリーンショットはピクセルなので両方を保持する。 */
/** MCPの引数から、ホストの UiQuery へそのまま渡せる形を作る。 */
function buildUiQuery(args: Record<string, unknown>): { text?: string; identifier?: string; role?: string; exact: boolean; interactableOnly: boolean; limit: number } {
	return {
		text: typeof args['text'] === 'string' && args['text'] ? args['text'] : undefined,
		identifier: typeof args['identifier'] === 'string' && args['identifier'] ? args['identifier'] : undefined,
		role: typeof args['role'] === 'string' && args['role'] ? args['role'] : undefined,
		exact: args['exact'] === true,
		interactableOnly: args['interactableOnly'] === true,
		limit: 20,
	};
}

/** アクセシビリティツリーを深さ優先でたどって、最初に見つかった focused な要素を返す。 */
function findFocusedElement(node: unknown): Record<string, unknown> | undefined {
	if (!node || typeof node !== 'object') {
		return undefined;
	}
	const record = node as Record<string, unknown>;
	if (record['focused'] === true) {
		return record;
	}
	const children = record['children'];
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
		orientation: typeof record['orientation'] === 'string' ? record['orientation'] : undefined,
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
