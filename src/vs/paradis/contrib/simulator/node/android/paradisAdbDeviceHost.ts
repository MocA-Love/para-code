/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android のエミュレータ・実機について、Mobile Canvas ホストの REST（`/api/v1/devices/...`）と同じ道に、利用者の
// adb で答える（q.html Q585 の ⑥a）。mobile_* の 17 本のツールは今のまま（iOS の paradisServeSimDeviceHost.ts と同じ
// 差し込み方）。adb は同梱しない（Android SDK の利用規約 3.4）。見つからなければ一覧に入れ方の説明を返す。
//
// 端末の id: 動いている端末は `android:serial:<serial>`、起動していない AVD は `android:avd:<name>`
// （【要確認】Mobile Canvas の Android の id と同じ形か。Mac で確かめる）。AVD の id を割り当てたペインは、
// そのエミュレータが起動したら、その serial へ回す（`adb -s <serial> emu avd name` で見分ける）。
// 座標の単位はポイント（画素 ÷ density/160）。adb の input は画素を受けるので掛け直して送る。
// 2 本指のピンチは adb の input ではできないので断る（⑥b で scrcpy の control に替える）。

import { execFile, spawn } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from '../../../../../base/common/path.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { paradisAdbCandidates } from '../../../mobileCanvas/node/paradisMobileDeviceCommands.js';
import { IParadisSimulatorAxSnapshot, paradisFindSimulatorAx, paradisPickSimulatorAxTarget } from '../../common/paradisSimulatorAx.js';
import { IParadisAdbDevice, PARADIS_ANDROID_AVD_PREFIX, PARADIS_ANDROID_SERIAL_PREFIX, paradisAdbInputText, paradisAndroidAvdOf, paradisAndroidButtonNames, paradisAndroidKeycode, paradisAndroidOrientationName, paradisAndroidRotation, paradisAndroidSerialOf, paradisFilterLogcat, paradisNormalizeUiautomator, paradisParseAdbDevices, paradisParseAvdList, paradisParseSurfaceOrientation, paradisParseWmDensity, paradisParseWmSize } from '../../common/paradisAndroid.js';

/** adb・emulator を呼ぶ口（テストで差し替える）。`binary` なら stdout を bytes で返す。 */
export type ParadisAdbExec = (file: string, args: readonly string[], options: { readonly timeoutMs: number; readonly binary?: boolean }) => Promise<string | Uint8Array>;

const realExec: ParadisAdbExec = (file, args, options) => new Promise((resolve, reject) => {
	execFile(file, [...args], { timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: options.binary ? 'buffer' : 'utf8' }, (error, stdout, stderr) => {
		if (error) {
			const command = [file.split(/[\\/]/).pop(), ...args.filter(arg => arg !== '-s')].join(' ').slice(0, 120);
			reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`));
		} else {
			resolve(options.binary ? new Uint8Array(stdout as unknown as Buffer) : String(stdout));
		}
	});
});

/** 見つかった場所を確かめる口。 */
export type ParadisAdbFileExists = (path: string) => Promise<boolean>;

/** エミュレータを裏で起こす口（終わりを待たない）。 */
export type ParadisAdbLaunch = (file: string, args: readonly string[]) => void;

const realLaunch: ParadisAdbLaunch = (file, args) => {
	const child = spawn(file, [...args], { detached: true, stdio: 'ignore' });
	child.on('error', () => { /* 一覧に出ないことで分かる */ });
	child.unref();
};

export const PARADIS_ADB_NOT_FOUND = 'Para Code could not find adb. Install the Android SDK platform-tools (Android Studio installs them), or set ANDROID_HOME for Para Code, and try again.';

interface IAndroidDisplay {
	readonly pointWidth: number;
	readonly pointHeight: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
	readonly scale: number;
	readonly orientation: string;
}

export interface IParadisAdbDeviceHostOptions {
	readonly exec?: ParadisAdbExec;
	readonly exists: ParadisAdbFileExists;
	readonly launch?: ParadisAdbLaunch;
	readonly env?: { readonly [name: string]: string | undefined };
	readonly platform?: NodeJS.Platform;
	readonly home?: string;
	readonly now?: () => number;
}

/** 起動を頼んでから、起動しきって adb に出てくるまでを待つ時間（その間は 2 つ目を立てない）。 */
const AVD_BOOT_GRACE_MS = 3 * 60 * 1000;

export class ParadisAdbDeviceHost {

	private readonly _exec: ParadisAdbExec;
	private readonly _launch: ParadisAdbLaunch;
	private readonly _now: () => number;
	/** 起動を頼んだ AVD と、その時刻（起動の途中にもう一度頼まれても、2 つ目を立てないため）。 */
	private readonly _booting = new Map<string, number>();

	constructor(private readonly _options: IParadisAdbDeviceHostOptions, private readonly _logService: ILogService) {
		this._exec = _options.exec ?? realExec;
		this._launch = _options.launch ?? realLaunch;
		this._now = _options.now ?? Date.now;
	}

	/** この端末の id をこちらで受け持つか。 */
	owns(deviceId: string): boolean {
		return paradisAndroidSerialOf(deviceId) !== undefined || paradisAndroidAvdOf(deviceId) !== undefined;
	}

	/** 見つかった adb の絶対パス。見つからなければ投げる（覚えない: 後から SDK を入れても再起動なしで使えるように）。 */
	async adbPath(): Promise<string> {
		for (const candidate of paradisAdbCandidates(this._options.env ?? process.env, this._options.platform ?? process.platform, this._options.home ?? homedir())) {
			if (await this._options.exists(candidate)) {
				return candidate;
			}
		}
		throw new Error(PARADIS_ADB_NOT_FOUND);
	}

	private async _adb(args: readonly string[], timeoutMs = 20_000): Promise<string> {
		return String(await this._exec(await this.adbPath(), args, { timeoutMs }));
	}

	private async _shell(serial: string, command: readonly string[], timeoutMs = 20_000): Promise<string> {
		return this._adb(['-s', serial, 'shell', ...command], timeoutMs);
	}

	/** adb と同じ SDK の emulator。無ければ undefined。 */
	private async _emulatorPath(): Promise<string | undefined> {
		const adb = await this.adbPath();
		const executable = (this._options.platform ?? process.platform) === 'win32' ? 'emulator.exe' : 'emulator';
		const candidate = join(dirname(dirname(adb)), 'emulator', executable);
		return await this._options.exists(candidate) ? candidate : undefined;
	}

	/** 動いている端末と、起動していない AVD の一覧（Mobile Canvas の一覧と同じ形）。adb が無ければ投げる。 */
	async listDevices(): Promise<unknown[]> {
		const running = paradisParseAdbDevices(await this._adb(['devices', '-l'], 10_000));
		const described = await Promise.all(running.map(device => this._describeRunning(device)));
		const runningAvds = new Set(described.map(entry => entry.avd).filter((name): name is string => !!name));
		const emulator = await this._emulatorPath().catch(() => undefined);
		const avds = emulator ? paradisParseAvdList(String(await this._exec(emulator, ['-list-avds'], { timeoutMs: 10_000 }).catch(() => ''))) : [];
		const stopped = avds.filter(name => !runningAvds.has(name)).map(name => ({
			id: `${PARADIS_ANDROID_AVD_PREFIX}${name}`,
			name: name.replace(/_/g, ' '),
			platform: 'android',
			state: 'shutdown',
		}));
		return [...described.map(entry => entry.record), ...stopped];
	}

	private async _describeRunning(device: IParadisAdbDevice): Promise<{ record: Record<string, unknown>; avd?: string }> {
		const online = device.state === 'device';
		const [release, avd] = online
			? await Promise.all([
				this._shell(device.serial, ['getprop', 'ro.build.version.release'], 5000).then(value => value.trim(), () => ''),
				device.serial.startsWith('emulator-') ? this._adb(['-s', device.serial, 'emu', 'avd', 'name'], 5000).then(value => value.split('\n')[0].trim(), () => '') : Promise.resolve(''),
			])
			: ['', ''];
		return {
			record: {
				id: `${PARADIS_ANDROID_SERIAL_PREFIX}${device.serial}`,
				udid: device.serial,
				name: avd ? avd.replace(/_/g, ' ') : device.model ?? device.serial,
				platform: 'android',
				...(release ? { runtimeName: `Android ${release}` } : {}),
				state: device.state,
			},
			...(avd ? { avd } : {}),
		};
	}

	/** 端末の id から、今動いている serial。AVD の id なら、そのエミュレータが動いていればその serial。 */
	private async _serialOf(deviceId: string): Promise<string> {
		const serial = paradisAndroidSerialOf(deviceId);
		if (serial) {
			return serial;
		}
		const avd = paradisAndroidAvdOf(deviceId);
		if (!avd) {
			throw new Error(`Not an Android device id: ${deviceId}`);
		}
		for (const device of paradisParseAdbDevices(await this._adb(['devices', '-l'], 10_000))) {
			if (device.state === 'device' && device.serial.startsWith('emulator-')) {
				const name = await this._adb(['-s', device.serial, 'emu', 'avd', 'name'], 5000).then(value => value.split('\n')[0].trim(), () => '');
				if (name === avd) {
					return device.serial;
				}
			}
		}
		throw new Error(`The Android emulator "${avd}" is not running. Ask the user to start it (approving the request in Para Code starts it).`);
	}

	/**
	 * AVD を起動する（承認したとき。起動を待たない）。動いていれば何もしない。名前が `emulator -list-avds` に無ければ断る。
	 * 起動を頼んでから {@link AVD_BOOT_GRACE_MS} の間にもう一度頼まれても、2 つ目のエミュレータは立てない。
	 */
	async bootAvd(deviceId: string): Promise<void> {
		const avd = paradisAndroidAvdOf(deviceId);
		if (!avd) {
			return;
		}
		if (await this._serialOf(deviceId).then(() => true, () => false)) {
			return;
		}
		const startedAt = this._booting.get(avd);
		if (startedAt !== undefined && this._now() - startedAt < AVD_BOOT_GRACE_MS) {
			return;
		}
		const emulator = await this._emulatorPath();
		if (!emulator) {
			throw new Error('Para Code could not find the Android emulator next to adb (emulator/emulator in the Android SDK).');
		}
		const avds = paradisParseAvdList(String(await this._exec(emulator, ['-list-avds'], { timeoutMs: 10_000 })));
		if (!avds.includes(avd)) {
			throw new Error(`There is no Android Virtual Device named "${avd}". Create it in Android Studio, or pick one from mobile_list_devices.`);
		}
		this._booting.set(avd, this._now());
		this._launch(emulator, ['-avd', avd]);
		this._logService.info('[paradis-simulator] started an Android emulator');
	}

	async request(method: string, path: string, body: unknown): Promise<unknown> {
		const { deviceId, rest, query } = this._parse(path);
		const args = body && typeof body === 'object' ? body as Record<string, unknown> : {};
		if (method === 'GET' && rest === '') {
			const entry = (await this.listDevices()).find(candidate => (candidate as { id?: string }).id === deviceId);
			if (!entry) {
				throw new Error(`Unknown mobile device: ${deviceId}`);
			}
			const display = (entry as { state?: string }).state === 'device' ? await this._display(await this._serialOf(deviceId)).catch(() => undefined) : undefined;
			return { ...(entry as object), ...(display ? { display } : {}) };
		}
		const serial = await this._serialOf(deviceId);
		switch (`${method} ${rest}`) {
			case 'GET /display':
				return this._display(serial);
			case 'GET /ui':
				return this._snapshot(serial);
			case 'POST /ui/find':
				return paradisFindSimulatorAx(await this._snapshot(serial), this._query(args));
			case 'POST /ui/tap': {
				const found = paradisFindSimulatorAx(await this._snapshot(serial), { ...this._query(args), limit: 200 });
				const target = paradisPickSimulatorAxTarget(found.matches);
				if (!target) {
					throw new Error('No element on the screen matched. Call mobile_ui_find or mobile_ui_snapshot to see what is there.');
				}
				await this._tap(serial, target.center.x, target.center.y, undefined);
				return { tapped: target, candidates: found.total, ambiguous: found.total > 1 };
			}
			case 'POST /input/tap':
				await this._tap(serial, requireNumber(args, 'x'), requireNumber(args, 'y'), typeof args.duration === 'number' ? args.duration : undefined);
				return undefined;
			case 'POST /input/swipe': {
				const scale = (await this._display(serial)).scale;
				const seconds = typeof args.duration === 'number' && args.duration > 0 ? Math.min(10, args.duration) : 0.4;
				await this._shell(serial, ['input', 'swipe', ...[requireNumber(args, 'startX'), requireNumber(args, 'startY'), requireNumber(args, 'endX'), requireNumber(args, 'endY')].map(value => String(Math.round(value * scale))), String(Math.round(seconds * 1000))], 30_000);
				return undefined;
			}
			case 'POST /input/text': {
				const text = typeof args.text === 'string' ? args.text : '';
				const escaped = text ? paradisAdbInputText(text) : undefined;
				if (escaped === undefined) {
					throw new Error(text
						? 'This Android device can only be typed into with ASCII characters for now (adb input text). Type the rest from the device, or use English text.'
						: '"text" must be a non-empty string.');
				}
				await this._shell(serial, ['input', 'text', escaped], 30_000);
				return undefined;
			}
			case 'POST /input/button': {
				const keycode = typeof args.button === 'string' ? paradisAndroidKeycode(args.button) : undefined;
				if (keycode === undefined) {
					throw new Error(`Unknown button "${String(args.button)}" for an Android device. Use one of: ${paradisAndroidButtonNames().join(', ')}.`);
				}
				await this._shell(serial, ['input', 'keyevent', String(keycode)]);
				return undefined;
			}
			case 'POST /input/rotate': {
				const rotation = typeof args.orientation === 'string' ? paradisAndroidRotation(args.orientation) : undefined;
				if (rotation === undefined) {
					throw new Error(`Unknown orientation "${String(args.orientation)}".`);
				}
				await this._shell(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0']);
				await this._shell(serial, ['settings', 'put', 'system', 'user_rotation', String(rotation)]);
				return undefined;
			}
			case 'POST /input/touch':
				throw new Error('Two-finger gestures (pinch) are not available on Android in this version of Para Code.');
			case 'GET /log':
				return this._readLog(serial, query);
			default:
				throw new Error(`Android devices do not support ${method} ${rest || '/'} in Para Code yet.`);
		}
	}

	async requestBinary(path: string): Promise<Uint8Array> {
		const { deviceId, rest } = this._parse(path);
		if (rest !== '/screenshot') {
			throw new Error(`Android devices do not support GET ${rest} as binary.`);
		}
		const png = await this._exec(await this.adbPath(), ['-s', await this._serialOf(deviceId), 'exec-out', 'screencap', '-p'], { timeoutMs: 30_000, binary: true });
		return typeof png === 'string' ? new TextEncoder().encode(png) : png;
	}

	private _parse(path: string): { deviceId: string; rest: string; query: URLSearchParams } {
		const queryIndex = path.indexOf('?');
		const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
		const match = /^\/api\/v1\/devices\/(?<id>[^/]+)(?<rest>(?:\/[a-z]+)*)$/.exec(pathname);
		const deviceId = match?.groups ? decodeURIComponent(match.groups.id) : '';
		if (!match?.groups || !this.owns(deviceId)) {
			throw new Error(`Not a path of an Android device: ${pathname}`);
		}
		return { deviceId, rest: match.groups.rest, query: new URLSearchParams(queryIndex === -1 ? '' : path.slice(queryIndex + 1)) };
	}

	/** 画面の大きさ。ポイントは画素 ÷（density / 160）。横向きなら幅と高さを入れ替える。 */
	private async _display(serial: string): Promise<IAndroidDisplay> {
		const [size, density, input] = await Promise.all([
			this._shell(serial, ['wm', 'size']).then(paradisParseWmSize),
			this._shell(serial, ['wm', 'density']).then(paradisParseWmDensity),
			this._shell(serial, ['dumpsys', 'input']).then(paradisParseSurfaceOrientation, () => 0),
		]);
		if (!size || !density) {
			throw new Error('Para Code could not read the screen size of the Android device. Try again in a moment.');
		}
		const sideways = input === 1 || input === 3;
		const pixelWidth = sideways ? size.height : size.width;
		const pixelHeight = sideways ? size.width : size.height;
		const scale = density / 160;
		return {
			pointWidth: Math.round(pixelWidth / scale * 10) / 10,
			pointHeight: Math.round(pixelHeight / scale * 10) / 10,
			pixelWidth,
			pixelHeight,
			scale,
			orientation: paradisAndroidOrientationName(input),
		};
	}

	private async _snapshot(serial: string): Promise<IParadisSimulatorAxSnapshot> {
		const path = '/sdcard/paradis-ui-dump.xml';
		await this._shell(serial, ['uiautomator', 'dump', path], 30_000);
		const xml = await this._shell(serial, ['cat', path], 30_000);
		void this._shell(serial, ['rm', '-f', path]).catch(() => undefined);
		const scale = (await this._display(serial)).scale;
		return paradisNormalizeUiautomator(xml, scale);
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

	private async _tap(serial: string, x: number, y: number, seconds: number | undefined): Promise<void> {
		const scale = (await this._display(serial)).scale;
		const px = String(Math.round(x * scale));
		const py = String(Math.round(y * scale));
		if (seconds !== undefined && seconds >= 0.3) {
			// 長押しは、動かないスワイプで押している時間を指定する
			await this._shell(serial, ['input', 'swipe', px, py, px, py, String(Math.round(Math.min(10, seconds) * 1000))], 30_000);
		} else {
			await this._shell(serial, ['input', 'tap', px, py]);
		}
	}

	private async _readLog(serial: string, query: URLSearchParams): Promise<unknown> {
		const seconds = Math.max(1, Math.min(3600, Math.round(Number(query.get('seconds')) || 60)));
		const limit = Math.max(1, Math.min(500, Math.round(Number(query.get('limit')) || 500)));
		const text = query.get('text') ?? undefined;
		const bundleId = query.get('bundleId') ?? undefined;
		const now = Number((await this._shell(serial, ['date', '+%s'])).trim()) || Math.floor(Date.now() / 1000);
		const pids = bundleId && /^[A-Za-z0-9._]+$/.test(bundleId) ? (await this._shell(serial, ['pidof', bundleId]).catch(() => '')).trim().split(/\s+/).filter(Boolean) : [];
		const stdout = await this._adb(['-s', serial, 'logcat', '-d', '-v', 'epoch', '-t', '5000'], 60_000);
		const lines = paradisFilterLogcat(stdout, now - seconds, { text, bundleId, pids });
		const kept = lines.slice(-limit);
		return { seconds, lines: kept, truncated: lines.length > kept.length };
	}
}

function requireNumber(body: Record<string, unknown>, name: string): number {
	const value = body[name];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`"${name}" must be a number.`);
	}
	return value;
}
