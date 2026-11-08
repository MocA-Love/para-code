/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// iOS のシミュレータについて、端末の口（`/api/v1/devices/...` の道。もとは Mobile Canvas ホストの REST の形）に、
// serve-sim と simctl で答える（q.html Q585 の ③、案A）。mobile_* の 17 本のツール（paradisDeviceLedger.ts・
// paradisSimulatorDeviceOps.ts）の端末への要求が、振り分け（paradisSimulatorDeviceRouter.ts）でこちらへ回る。
//
// 端末の id と項目は Mobile Canvas の iOS の端末と同じ形（`ios:core-simulator:<udid>`、platform は `ios`、state は
// `booted` のように小文字。2026-11-08 に Mac の mobile_list_devices で確かめた）。
// 座標の単位は今と同じポイント。serve-sim の HID は画面に対する 0〜1 を受けるので、アクセシビリティの木の画面の
// 大きさ（ポイント）で割り、映像が回っていなければそのまま、回っていれば（生の映像が縦のまま横向きのとき）
// 端末の向きへ戻して送る（paradisSimulatorInput.ts の向きの扱い）。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, PARADIS_SIMULATOR_DEVICE_ID_PREFIX, PARADIS_SIMULATOR_ORIENTATIONS, ParadisSimulatorOrientation, paradisResolveSimulatorButton, paradisSimulatorButtonNames, paradisSimulatorUdidOfDeviceId } from '../common/paradisSimulator.js';
import { paradisFindSimulatorAx, paradisMarkTypedSimulatorField, paradisNormalizeSimulatorAx, paradisPickSimulatorAxTarget, paradisSimulatorFieldValues, IParadisSimulatorAxSnapshot } from '../common/paradisSimulatorAx.js';
import { paradisPngSize } from '../common/paradisMobileDeviceOps.js';
import { paradisSimulatorButtonFrame, paradisSimulatorKeyFrame, paradisSimulatorMultiTouchFrame, paradisSimulatorRotateFrame, paradisSimulatorTouchFrame } from '../common/paradisSimulatorFrames.js';
import { paradisSimulatorDisplayGeometry, paradisSimulatorDuoPanel, paradisSimulatorKeystrokes, paradisSimulatorRawPoint } from '../common/paradisSimulatorInput.js';
import { ParadisServeSimBackend } from './paradisServeSimBackend.js';

export const PARADIS_SERVE_SIM_DEVICE_PREFIX = PARADIS_SIMULATOR_DEVICE_ID_PREFIX;

/** `ios:core-simulator:<udid>` の udid。形が違えば undefined。 */
export const paradisServeSimUdidOf = paradisSimulatorUdidOfDeviceId;

/** simctl を呼ぶ口。`input` は stdin へ書く。`binary` なら stdout を bytes で返す。 */
export type ParadisServeSimSimctl = (args: readonly string[], options: { readonly timeoutMs: number; readonly input?: string; readonly binary?: boolean }) => Promise<string | Uint8Array>;

const realSimctl: ParadisServeSimSimctl = (args, options) => new Promise((resolve, reject) => {
	const child = execFile('xcrun', ['simctl', ...args], { timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: options.binary ? 'buffer' : 'utf8' }, (error, stdout, stderr) => {
		if (error) {
			reject(new Error(`xcrun simctl ${args[0]} failed: ${String(stderr).trim() || error.message}`));
		} else {
			resolve(options.binary ? new Uint8Array(stdout as unknown as Buffer) : String(stdout));
		}
	});
	if (options.input !== undefined) {
		child.stdin?.end(options.input);
	}
});

/**
 * スクリーンショット（PNG）を取る。simctl は専用の一時フォルダのファイルへ書かせ、読んだら消す
 * （serve-sim 自身もファイルへ書く。標準出力への書き出しには頼らない）。
 */
export type ParadisServeSimScreenshot = (udid: string) => Promise<Uint8Array>;

function realScreenshot(simctl: ParadisServeSimSimctl): ParadisServeSimScreenshot {
	return async udid => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-simulator-shot-'));
		try {
			const file = join(dir, 'screen.png');
			await simctl(['io', udid, 'screenshot', '--type=png', file], { timeoutMs: 30_000 });
			return new Uint8Array(await fs.readFile(file));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	};
}

export type ParadisServeSimSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: ParadisServeSimSleep = (ms, signal) => new Promise<void>(resolve => {
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener('abort', () => {
		clearTimeout(timer);
		resolve();
	}, { once: true });
});

/** 画面の大きさ（Mobile Canvas の `/display` と同じ形。向きは `landscape-left` のように `-` でつなぐ）。 */
interface IServeSimDisplay {
	readonly pointWidth: number;
	readonly pointHeight: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
	readonly scale: number;
	readonly orientation: string;
}

/** 測ったときの serve-sim の映像の大きさと向き。これが変わったら（どこから回されても）測り直す。 */
interface IMeasuredDisplay {
	readonly display: IServeSimDisplay;
	readonly measuredWith: string;
}

function configKey(config: IParadisSimulatorScreenConfig): string {
	return `${config.width}x${config.height}:${config.orientation}`;
}

const TAP_SECONDS = 0.05;
const SWIPE_STEP_MS = 16;
const LOG_LIMIT = 500;
/** HID の usage: Left Shift・Left GUI（Command）・V。 */
const USAGE_SHIFT = 0xe1;
const USAGE_COMMAND = 0xe3;
const USAGE_V = 0x19;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireNumber(body: Record<string, unknown>, name: string): number {
	const value = body[name];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`"${name}" must be a number.`);
	}
	return value;
}

function hyphenOrientation(orientation: string): string {
	return orientation.replace(/_/g, '-');
}

export class ParadisServeSimDeviceHost {

	/** 端末ごとに最後に測った画面の大きさ（一覧の `display` に載せる。回転・開閉で捨てる）。 */
	private readonly _displays = new Map<string, IMeasuredDisplay>();
	/** mobile_type_text の前の欄の値（次の GET /ui で、値が変わった欄に focused を付ける）。 */
	private readonly _typedFields = new Map<string, Map<string, string>>();
	private readonly _screenshot: ParadisServeSimScreenshot;
	/** 2 本指の入力の、指ごとの今の位置（Mobile Canvas の `input/touch` は 1 本ずつ来る）。 */
	private readonly _fingers = new Map<string, Map<number, { x: number; y: number }>>();

	constructor(
		private readonly _backend: ParadisServeSimBackend,
		private readonly _logService: ILogService,
		private readonly _simctl: ParadisServeSimSimctl = realSimctl,
		private readonly _sleep: ParadisServeSimSleep = realSleep,
		screenshot?: ParadisServeSimScreenshot,
	) {
		this._screenshot = screenshot ?? realScreenshot(this._simctl);
	}

	/** この端末の id をこちらで受け持つか。 */
	owns(deviceId: string): boolean {
		return paradisServeSimUdidOf(deviceId) !== undefined;
	}

	/** 画面の大きさの覚えを捨てる（開閉のあと）。 */
	forgetDisplay(deviceId: string): void {
		this._displays.delete(deviceId);
	}

	/** Mobile Canvas の一覧と同じ形の、iOS のシミュレータの一覧。 */
	async listDevices(): Promise<unknown[]> {
		const devices = await this._backend.listDevices();
		return devices.map(device => this._describe(device));
	}

	private _describe(device: IParadisSimulatorDevice): Record<string, unknown> {
		const id = `${PARADIS_SERVE_SIM_DEVICE_PREFIX}${device.udid}`;
		const display = this._displays.get(id)?.display;
		return {
			id,
			udid: device.udid,
			name: device.name,
			platform: 'ios',
			runtimeName: device.runtime,
			state: device.state.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
			...(display ? { display } : {}),
		};
	}

	async request(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
		const { deviceId, udid, rest, query } = this._parse(path);
		const args = record(body);
		switch (`${method} ${rest}`) {
			case 'GET ':
				return this._describeOne(deviceId, udid);
			case 'GET /display':
				return this._display(deviceId, udid, true);
			case 'GET /ui': {
				const snapshot = await this._snapshot(udid);
				const before = this._typedFields.get(udid);
				this._typedFields.delete(udid);
				return before ? paradisMarkTypedSimulatorField(snapshot, before) : snapshot;
			}
			case 'POST /ui/find':
				return paradisFindSimulatorAx(await this._snapshot(udid), this._query(args));
			case 'POST /ui/tap':
				return this._uiTap(deviceId, udid, args, signal);
			case 'POST /input/tap':
				await this._tap(deviceId, udid, requireNumber(args, 'x'), requireNumber(args, 'y'), typeof args.duration === 'number' ? args.duration : TAP_SECONDS, signal);
				return undefined;
			case 'POST /input/swipe':
				await this._swipe(deviceId, udid, args, signal);
				return undefined;
			case 'POST /input/text':
				return this._typeText(udid, typeof args.text === 'string' ? args.text : '');
			case 'POST /input/button':
				return this._pressButton(udid, args.button);
			case 'POST /input/rotate':
				return this._rotate(deviceId, udid, args.orientation);
			case 'POST /input/touch':
				return this._touch(deviceId, udid, args);
			case 'GET /log':
				return this._readLog(udid, query);
			default:
				throw new Error(`The new iOS simulator does not support ${method} ${rest || '/'} yet.`);
		}
	}

	async requestBinary(path: string): Promise<Uint8Array> {
		const { udid, rest } = this._parse(path);
		if (rest !== '/screenshot') {
			throw new Error(`The new iOS simulator does not support GET ${rest} as binary.`);
		}
		const png = await this._screenshot(udid);
		// mobile_screenshot はこの後の一覧から画面の大きさを読むので、ここで測っておく（同じ 1 枚から scale を出す）
		await this._display(this._parse(path).deviceId, udid, true, png).catch(error => this._logService.trace('[paradis-simulator] could not measure the screen after a screenshot', error));
		return png;
	}

	private _parse(path: string): { deviceId: string; udid: string; rest: string; query: URLSearchParams } {
		const queryIndex = path.indexOf('?');
		const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
		const match = /^\/api\/v1\/devices\/(?<id>[^/]+)(?<rest>(?:\/[a-z]+)*)$/.exec(pathname);
		const deviceId = match?.groups ? decodeURIComponent(match.groups.id) : '';
		const udid = paradisServeSimUdidOf(deviceId);
		if (!match?.groups || !udid) {
			throw new Error(`Not a path of the new iOS simulator: ${pathname}`);
		}
		return { deviceId, udid, rest: match.groups.rest, query: new URLSearchParams(queryIndex === -1 ? '' : path.slice(queryIndex + 1)) };
	}

	private async _describeOne(deviceId: string, udid: string): Promise<unknown> {
		const device = (await this._backend.listDevices()).find(candidate => candidate.udid === udid);
		if (!device) {
			throw new Error(`Unknown mobile device: ${deviceId}`);
		}
		if (device.state !== 'Booted') {
			return this._describe(device);
		}
		// 折りたたみの端末なら、開き具合と映している画面も返す（mobile_fold の前に様子が分かるように）
		const config = await this._backend.getScreenConfig(udid).catch(() => undefined);
		const display = await this._display(deviceId, udid, false).catch(() => undefined);
		const foldable = config?.hingeDegrees !== undefined;
		return {
			...this._describe(device),
			...(display ? { display } : {}),
			foldable,
			...(foldable ? { hingeDegrees: config!.hingeDegrees, activeDisplay: paradisSimulatorDuoPanel(config!) } : {}),
		};
	}

	/**
	 * 画面の大きさ。ポイントはアクセシビリティの木の画面、画素は simctl のスクリーンショット（mobile_screenshot が返す
	 * 画像と同じもの）。`scale` は長い辺どうしの比を整数に丸めたもの（mobile_gesture などはスクリーンショットの画素を
	 * この値で割ってポイントにするので、画像と合っていなければならない。serve-sim の映像は小さく流れることがあるので使わない）。
	 * 覚えた値は、serve-sim の映像の大きさか向きが変わったら（ペインや Simulator.app で回したときも）測り直す。
	 */
	private async _display(deviceId: string, udid: string, fresh: boolean, screenshot?: Uint8Array): Promise<IServeSimDisplay> {
		const config = await this._backend.getScreenConfig(udid);
		const remembered = fresh ? undefined : this._displays.get(deviceId);
		if (remembered && remembered.measuredWith === configKey(config)) {
			return remembered.display;
		}
		const [snapshot, png] = await Promise.all([this._snapshot(udid), screenshot ?? this._screenshot(udid)]);
		const pixels = paradisPngSize(png);
		const pointWidth = snapshot.screen.width;
		const pointHeight = snapshot.screen.height;
		if (pointWidth <= 0 || pointHeight <= 0 || !pixels) {
			throw new Error('The simulator did not report its screen size yet. Try again in a moment.');
		}
		const scale = Math.max(1, Math.round(Math.max(pixels.width, pixels.height) / Math.max(pointWidth, pointHeight)));
		const display: IServeSimDisplay = {
			pointWidth,
			pointHeight,
			pixelWidth: pixels.width,
			pixelHeight: pixels.height,
			scale,
			orientation: hyphenOrientation(config.orientation),
		};
		this._displays.set(deviceId, { display, measuredWith: configKey(config) });
		return display;
	}

	private async _snapshot(udid: string): Promise<IParadisSimulatorAxSnapshot> {
		return paradisNormalizeSimulatorAx(await this._backend.getAccessibilityTree(udid));
	}

	private _query(args: Record<string, unknown>) {
		return {
			text: typeof args.text === 'string' && args.text ? args.text : undefined,
			identifier: typeof args.identifier === 'string' && args.identifier ? args.identifier : undefined,
			role: typeof args.role === 'string' && args.role ? args.role : undefined,
			exact: args.exact === true,
			interactableOnly: args.interactableOnly === true,
			limit: typeof args.limit === 'number' ? args.limit : 20,
		};
	}

	private async _uiTap(deviceId: string, udid: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const found = paradisFindSimulatorAx(await this._snapshot(udid), { ...this._query(args), limit: 200 });
		const target = paradisPickSimulatorAxTarget(found.matches);
		if (!target) {
			throw new Error('No element on the screen matched. Call mobile_ui_find or mobile_ui_snapshot to see what is there.');
		}
		await this._tap(deviceId, udid, target.center.x, target.center.y, TAP_SECONDS, signal);
		return { tapped: target, candidates: found.total, ambiguous: found.total > 1 };
	}

	/** ポイント → HID の 0〜1（端末の向き）。 */
	private async _normalize(deviceId: string, udid: string, x: number, y: number): Promise<{ x: number; y: number }> {
		const display = await this._display(deviceId, udid, false);
		const config = await this._backend.getScreenConfig(udid);
		const geometry = paradisSimulatorDisplayGeometry(config);
		return paradisSimulatorRawPoint(geometry.inputOrientation, x / display.pointWidth, y / display.pointHeight);
	}

	private async _tap(deviceId: string, udid: string, x: number, y: number, seconds: number, signal?: AbortSignal): Promise<void> {
		const point = await this._normalize(deviceId, udid, x, y);
		await this._backend.send(udid, paradisSimulatorTouchFrame('begin', point.x, point.y));
		try {
			await this._sleep(Math.max(0, Math.min(10, seconds)) * 1000, signal);
		} finally {
			await this._backend.send(udid, paradisSimulatorTouchFrame('end', point.x, point.y));
		}
	}

	private async _swipe(deviceId: string, udid: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		const start = await this._normalize(deviceId, udid, requireNumber(args, 'startX'), requireNumber(args, 'startY'));
		const end = await this._normalize(deviceId, udid, requireNumber(args, 'endX'), requireNumber(args, 'endY'));
		const seconds = typeof args.duration === 'number' && args.duration > 0 ? Math.min(10, args.duration) : 0.4;
		const steps = Math.max(2, Math.round(seconds * 1000 / SWIPE_STEP_MS));
		await this._backend.send(udid, paradisSimulatorTouchFrame('begin', start.x, start.y));
		let last = start;
		try {
			for (let step = 1; step <= steps && !signal?.aborted; step++) {
				await this._sleep(SWIPE_STEP_MS, signal);
				last = { x: start.x + (end.x - start.x) * step / steps, y: start.y + (end.y - start.y) * step / steps };
				await this._backend.send(udid, paradisSimulatorTouchFrame('move', last.x, last.y));
			}
		} finally {
			await this._backend.send(udid, paradisSimulatorTouchFrame('end', last.x, last.y));
		}
	}

	/**
	 * 文字を入れる。US 配列のキーで打てる文字だけなら HID のキーで打つ。日本語などが混じれば、シミュレータの
	 * クリップボードへ写して Command+V で貼る（ソフトウェアキーボードの IME を通さないので、打った文字のまま入る）。
	 */
	private async _typeText(udid: string, text: string): Promise<unknown> {
		if (!text) {
			throw new Error('"text" must be a non-empty string.');
		}
		// 打つ前の欄の値を覚えておき、次の GET /ui（mobile_type_text の読み返し）で値が変わった欄を入力中とみなす
		const before = await this._snapshot(udid).then(paradisSimulatorFieldValues, () => undefined);
		if (before) {
			this._typedFields.set(udid, before);
		}
		const strokes = paradisSimulatorKeystrokes(text);
		if (strokes) {
			for (const stroke of strokes) {
				if (stroke.shift) {
					await this._backend.send(udid, paradisSimulatorKeyFrame('down', USAGE_SHIFT));
				}
				await this._backend.send(udid, paradisSimulatorKeyFrame('down', stroke.usage));
				await this._backend.send(udid, paradisSimulatorKeyFrame('up', stroke.usage));
				if (stroke.shift) {
					await this._backend.send(udid, paradisSimulatorKeyFrame('up', USAGE_SHIFT));
				}
			}
			return { method: 'keys' };
		}
		await this._simctl(['pbcopy', udid], { timeoutMs: 10_000, input: text });
		await this._backend.send(udid, paradisSimulatorKeyFrame('down', USAGE_COMMAND));
		await this._backend.send(udid, paradisSimulatorKeyFrame('down', USAGE_V));
		await this._backend.send(udid, paradisSimulatorKeyFrame('up', USAGE_V));
		await this._backend.send(udid, paradisSimulatorKeyFrame('up', USAGE_COMMAND));
		return { method: 'paste' };
	}

	private async _pressButton(udid: string, raw: unknown): Promise<unknown> {
		const button = typeof raw === 'string' ? paradisResolveSimulatorButton(raw) : undefined;
		if (!button) {
			throw new Error(`Unknown button "${String(raw)}" for an iOS simulator. Use one of: ${paradisSimulatorButtonNames().join(', ')}.`);
		}
		await this._backend.send(udid, paradisSimulatorButtonFrame(button));
		return undefined;
	}

	private async _rotate(deviceId: string, udid: string, raw: unknown): Promise<unknown> {
		const orientation = typeof raw === 'string' ? raw.replace(/-/g, '_') : '';
		if (!(PARADIS_SIMULATOR_ORIENTATIONS as readonly string[]).includes(orientation)) {
			throw new Error(`Unknown orientation "${String(raw)}".`);
		}
		await this._backend.send(udid, paradisSimulatorRotateFrame(orientation as ParadisSimulatorOrientation));
		this._displays.delete(deviceId);
		return undefined;
	}

	/**
	 * 1 本ずつ来る指の入力を、serve-sim の 2 本指のフレームにまとめる。指 0 の入力は位置を覚えるだけで、
	 * 指 1 の入力のときに 2 本ぶんを送る（ピンチは指 0 → 指 1 の順に下ろし・動かし・上げる）。
	 */
	private async _touch(deviceId: string, udid: string, args: Record<string, unknown>): Promise<unknown> {
		const fingerId = typeof args.fingerId === 'number' ? args.fingerId : 0;
		const phase = args.phase === 'down' ? 'begin' : args.phase === 'move' ? 'move' : args.phase === 'up' ? 'end' : undefined;
		if (!phase || (fingerId !== 0 && fingerId !== 1)) {
			throw new Error('The new iOS simulator takes touches from fingers 0 and 1 with phase down, move or up.');
		}
		const point = await this._normalize(deviceId, udid, requireNumber(args, 'x'), requireNumber(args, 'y'));
		let fingers = this._fingers.get(udid);
		if (!fingers) {
			fingers = new Map();
			this._fingers.set(udid, fingers);
		}
		fingers.set(fingerId, point);
		const first = fingers.get(0);
		if (fingerId === 1 && first) {
			await this._backend.send(udid, paradisSimulatorMultiTouchFrame(phase, first.x, first.y, point.x, point.y));
		}
		// 指 0 を先に上げても、指 1 を上げるまでは 2 本の最後の位置を覚えておく（上げたときに 2 本ぶんの end を送る）
		if (phase === 'end' && (fingerId === 1 || !fingers.has(1))) {
			this._fingers.delete(udid);
		}
		return undefined;
	}

	private async _readLog(udid: string, query: URLSearchParams): Promise<unknown> {
		const seconds = Math.max(1, Math.min(3600, Math.round(Number(query.get('seconds')) || 60)));
		const limit = Math.max(1, Math.min(LOG_LIMIT, Math.round(Number(query.get('limit')) || LOG_LIMIT)));
		const text = query.get('text') ?? undefined;
		const bundleId = query.get('bundleId') ?? undefined;
		const stdout = String(await this._simctl(['spawn', udid, 'log', 'show', '--last', `${seconds}s`, '--style', 'compact'], { timeoutMs: 60_000 }));
		const lines = stdout.split('\n').filter(line => line.trim() && (!text || line.includes(text)) && (!bundleId || line.includes(bundleId)));
		const kept = lines.slice(-limit);
		this._logService.trace(`[paradis-simulator] read ${kept.length} log lines`);
		return { seconds, lines: kept, truncated: lines.length > kept.length };
	}
}

/** 映している画面（外 cover / 内 inner）。折りたたみでなければ undefined。 */
export function paradisServeSimActiveDisplay(config: IParadisSimulatorScreenConfig): 'cover' | 'inner' | undefined {
	return paradisSimulatorDuoPanel(config);
}
