/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android のエミュレータ・実機を adb で操作するための純関数（q.html Q585 の ⑥a）。adb の出力を読む・
// 入力の引数を組み立てる。adb は同梱しない（利用者の Android SDK のものを使う。Android SDK の利用規約 3.4）。

import { IParadisSimulatorAxNode, IParadisSimulatorAxSnapshot, ParadisSimulatorAxRole } from './paradisSimulatorAx.js';

/** mobile_* のツールでの Android の端末の id の頭（【要確認】Mobile Canvas の Android の id と同じ形か。Mac で確かめる）。 */
export const PARADIS_ANDROID_SERIAL_PREFIX = 'android:serial:';
/** 起動していない AVD（Android Virtual Device）の id の頭。要求を承認すると起動する。 */
export const PARADIS_ANDROID_AVD_PREFIX = 'android:avd:';

const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;
const AVD_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function paradisAndroidSerialOf(deviceId: string): string | undefined {
	const serial = deviceId.startsWith(PARADIS_ANDROID_SERIAL_PREFIX) ? deviceId.slice(PARADIS_ANDROID_SERIAL_PREFIX.length) : undefined;
	return serial && SERIAL.test(serial) && !serial.startsWith('-') ? serial : undefined;
}

export function paradisAndroidAvdOf(deviceId: string): string | undefined {
	const name = deviceId.startsWith(PARADIS_ANDROID_AVD_PREFIX) ? deviceId.slice(PARADIS_ANDROID_AVD_PREFIX.length) : undefined;
	return name && AVD_NAME.test(name) && !name.startsWith('-') ? name : undefined;
}

/** `adb devices -l` の 1 台。 */
export interface IParadisAdbDevice {
	readonly serial: string;
	/** `device`・`offline`・`unauthorized` など。 */
	readonly state: string;
	readonly model?: string;
}

export function paradisParseAdbDevices(stdout: string): IParadisAdbDevice[] {
	const devices: IParadisAdbDevice[] = [];
	for (const line of stdout.split('\n')) {
		const match = /^(?<serial>\S+)\s+(?<state>device|offline|unauthorized|authorizing|recovery|sideload|bootloader|no permissions)\b(?<rest>.*)$/.exec(line.trim());
		if (!match?.groups || !SERIAL.test(match.groups.serial) || match.groups.serial.startsWith('-')) {
			continue;
		}
		const model = /\bmodel:(?<model>\S+)/.exec(match.groups.rest)?.groups?.model;
		devices.push({ serial: match.groups.serial, state: match.groups.state, ...(model ? { model: model.replace(/_/g, ' ') } : {}) });
	}
	return devices;
}

/** `emulator -list-avds` の AVD の名前。 */
export function paradisParseAvdList(stdout: string): string[] {
	return stdout.split('\n').map(line => line.trim()).filter(line => AVD_NAME.test(line));
}

/** `wm size` の画素数（Override があればそちら）。 */
export function paradisParseWmSize(stdout: string): { readonly width: number; readonly height: number } | undefined {
	const pick = (label: string) => new RegExp(`${label} size:\\s*(?<w>\\d+)x(?<h>\\d+)`).exec(stdout)?.groups;
	const size = pick('Override') ?? pick('Physical');
	return size ? { width: Number(size.w), height: Number(size.h) } : undefined;
}

/** `wm density` の dpi（Override があればそちら）。 */
export function paradisParseWmDensity(stdout: string): number | undefined {
	const pick = (label: string) => new RegExp(`${label} density:\\s*(?<d>\\d+)`).exec(stdout)?.groups?.d;
	const density = Number(pick('Override') ?? pick('Physical'));
	return density > 0 ? density : undefined;
}

/** `dumpsys input` の `SurfaceOrientation`（0〜3。90° 刻みに左回り）。 */
export function paradisParseSurfaceOrientation(stdout: string): number {
	const value = Number(/SurfaceOrientation:\s*(?<o>\d)/.exec(stdout)?.groups?.o ?? 0);
	return value >= 0 && value <= 3 ? value : 0;
}

/** mobile_rotate の向き → Android の `user_rotation`（0〜3）。 */
export function paradisAndroidRotation(orientation: string): number | undefined {
	switch (orientation) {
		case 'portrait': return 0;
		case 'landscape-left': return 1;
		case 'portrait-upside-down': return 2;
		case 'landscape-right': return 3;
		default: return undefined;
	}
}

/** Android の向き（0〜3）→ mobile_* の向きの名前。 */
export function paradisAndroidOrientationName(rotation: number): string {
	return ['portrait', 'landscape-left', 'portrait-upside-down', 'landscape-right'][rotation] ?? 'portrait';
}

const KEYCODES: { readonly [name: string]: number } = {
	home: 3, back: 4, menu: 82, app_switcher: 187, power: 26, lock: 26, side_button: 26,
	volume_up: 24, volume_down: 25, enter: 66, search: 84,
};

/** mobile_press_button のボタンの名前 → Android の keycode。大文字・`-`・camelCase（`volumeUp`）も受ける。 */
export function paradisAndroidKeycode(raw: string): number | undefined {
	const name = raw.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
	const alias = name === 'appswitcher' || name === 'recents' || name === 'multitask' ? 'app_switcher' : name;
	return Object.prototype.hasOwnProperty.call(KEYCODES, alias) ? KEYCODES[alias] : undefined;
}

export function paradisAndroidButtonNames(): string[] {
	return Object.keys(KEYCODES);
}

/**
 * `adb shell input text` へ渡す文字列（端末のシェルが解くので、空白は `%s`、記号は `\` で逃がす）。
 * ASCII の印字できる文字だけを受ける。それ以外が混じれば undefined（adb の input では打てない）。
 */
export function paradisAdbInputText(text: string): string | undefined {
	if (!/^[\x20-\x7e]+$/.test(text)) {
		return undefined;
	}
	return text.replace(/[\\'"`$&|;<>()*?!#~{}[\]^]/g, char => `\\${char}`).replace(/ /g, '%s');
}

function decodeXml(value: string): string {
	return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#(?<code>\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&');
}

function attributes(tag: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const match of tag.matchAll(/(?<name>[\w-]+)="(?<value>[^"]*)"/g)) {
		result.set(match.groups!.name, decodeXml(match.groups!.value));
	}
	return result;
}

const ROLE_BY_CLASS: readonly [RegExp, ParadisSimulatorAxRole][] = [
	[/EditText|AutoCompleteTextView|SearchView/, 'field'],
	[/Switch|ToggleButton/, 'switch'],
	[/CheckBox|RadioButton|CheckedTextView/, 'checkbox'],
	[/SeekBar|RatingBar|ProgressBar/, 'slider'],
	[/Button|ImageButton|FloatingActionButton|Chip/, 'button'],
	[/ImageView/, 'image'],
	[/TextView/, 'text'],
	[/RecyclerView|ListView|GridView|ScrollView|ViewPager/, 'list'],
	[/TabWidget|TabLayout|BottomNavigationView/, 'tab'],
	[/Layout|ViewGroup|FrameLayout|View$/, 'container'],
];

function roleOf(className: string, clickable: boolean): ParadisSimulatorAxRole {
	for (const [pattern, role] of ROLE_BY_CLASS) {
		if (pattern.test(className)) {
			// 押せる入れ物（リストの行など）はセルとして扱う
			return role === 'container' && clickable ? 'cell' : role;
		}
	}
	return clickable ? 'button' : 'other';
}

const MAX_NODES = 500;

/**
 * `uiautomator dump` の XML を、iOS と同じ形の木（ポイント）にする。`scale` は画素 ÷ ポイント（density / 160）。
 * 要素は 500 個まで。
 */
export function paradisNormalizeUiautomator(xml: string, scale: number): IParadisSimulatorAxSnapshot {
	const factor = scale > 0 ? scale : 1;
	interface IBuilding { node: { -readonly [K in keyof IParadisSimulatorAxNode]: IParadisSimulatorAxNode[K] }; children: IBuilding[] }
	const rootChildren: IBuilding[] = [];
	const stack: IBuilding[] = [];
	let count = 0;
	let screen = { width: 0, height: 0 };
	for (const match of xml.matchAll(/<(?<close>\/)?node\b(?<attrs>[^>]*?)(?<self>\/)?>/g)) {
		if (match.groups!.close) {
			stack.pop();
			continue;
		}
		if (count >= MAX_NODES) {
			if (!match.groups!.self) {
				stack.push({ node: undefined!, children: [] });
			}
			continue;
		}
		const attrs = attributes(match.groups!.attrs);
		const bounds = /\[(?<x1>-?\d+),(?<y1>-?\d+)\]\[(?<x2>-?\d+),(?<y2>-?\d+)\]/.exec(attrs.get('bounds') ?? '')?.groups;
		const frame = bounds
			? { x: Number(bounds.x1) / factor, y: Number(bounds.y1) / factor, width: (Number(bounds.x2) - Number(bounds.x1)) / factor, height: (Number(bounds.y2) - Number(bounds.y1)) / factor }
			: { x: 0, y: 0, width: 0, height: 0 };
		const className = attrs.get('class') ?? '';
		const clickable = attrs.get('clickable') === 'true' || attrs.get('long-clickable') === 'true';
		const role = roleOf(className, clickable);
		const text = attrs.get('text') ?? '';
		const description = attrs.get('content-desc') ?? '';
		const identifier = attrs.get('resource-id') ?? '';
		const node: IBuilding['node'] = {
			role,
			type: className.split('.').pop() ?? className,
			label: role === 'field' ? (description || attrs.get('hint') || '') : (text || description),
			value: role === 'field' ? text : '',
			enabled: attrs.get('enabled') !== 'false',
			frame,
			children: [],
			...(identifier ? { identifier } : {}),
			...(attrs.get('focused') === 'true' ? { focused: true as const } : {}),
		};
		count++;
		if (stack.length === 0 && screen.width === 0) {
			screen = { width: frame.width + frame.x, height: frame.height + frame.y };
		}
		const building: IBuilding = { node, children: [] };
		const parent = stack.length ? stack[stack.length - 1] : undefined;
		if (parent?.node) {
			parent.children.push(building);
		} else if (!parent) {
			rootChildren.push(building);
		}
		if (!match.groups!.self) {
			stack.push(building);
		}
	}
	const finish = (building: IBuilding): IParadisSimulatorAxNode => ({ ...building.node, children: building.children.map(finish) });
	const roots = rootChildren.map(finish);
	const root: IParadisSimulatorAxNode = roots.length === 1
		? roots[0]
		: { role: 'container', type: 'Screen', label: '', value: '', enabled: true, frame: { x: 0, y: 0, width: screen.width, height: screen.height }, children: roots };
	return { screen, root, count };
}

/**
 * `logcat -d -v epoch` の行のうち、`sinceEpochSeconds` より後のものを返す（text・パッケージ名・その pid で絞る）。
 */
export function paradisFilterLogcat(stdout: string, sinceEpochSeconds: number, filters: { readonly text?: string; readonly bundleId?: string; readonly pids?: readonly string[] }): string[] {
	const lines: string[] = [];
	for (const line of stdout.split('\n')) {
		const match = /^\s*(?<time>\d+\.\d+)\s+(?<pid>\d+)\s/.exec(line);
		if (!match?.groups || Number(match.groups.time) < sinceEpochSeconds) {
			continue;
		}
		if (filters.text && !line.includes(filters.text)) {
			continue;
		}
		if (filters.bundleId && !line.includes(filters.bundleId) && !(filters.pids ?? []).includes(match.groups.pid)) {
			continue;
		}
		lines.push(line.trimEnd());
	}
	return lines;
}
