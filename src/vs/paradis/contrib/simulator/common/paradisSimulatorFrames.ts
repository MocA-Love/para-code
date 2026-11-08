/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// serve-sim 0.1.49 と話すときの形（純関数）。
//
//  - 入力: `/helper/<udid>/ws` へ送るフレーム。先頭の 1 バイトが種類で、残りが JSON
//    （serve-sim の `device-session.ts` の `handleHidMessage`）。座標は画面の 0〜1。
//  - 映像: `/helper/<udid>/stream.mjpeg` の `multipart/x-mixed-replace; boundary=frame`。
//    1 枚ごとに `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: <n>\r\n\r\n<JPEG>\r\n`。
//  - 入力の WebSocket で届くもの: 0x82 は画面の大きさと向き、0x0e は開閉の受け取りの返事。

import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, PARADIS_SIMULATOR_ORIENTATIONS, PARADIS_SIMULATOR_POSES, ParadisSimulatorButton, ParadisSimulatorDeviceState, ParadisSimulatorFold, ParadisSimulatorOrientation, paradisResolveSimulatorButton, paradisSimulatorButtonNames } from './paradisSimulator.js';

/** 入力のフレームの種類（先頭の 1 バイト）。 */
export const enum ParadisSimulatorFrameTag {
	Touch = 0x03,
	Button = 0x04,
	MultiTouch = 0x05,
	Key = 0x06,
	Rotate = 0x07,
	Fold = 0x0e,
	/** ホストから届く、画面の大きさと向き。 */
	Config = 0x82,
}

export type ParadisSimulatorTouchPhase = 'begin' | 'move' | 'end';

function frame(tag: ParadisSimulatorFrameTag, body: object): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(body));
	const bytes = new Uint8Array(json.length + 1);
	bytes[0] = tag;
	bytes.set(json, 1);
	return bytes;
}

function clampUnit(value: number): number {
	if (!Number.isFinite(value)) {
		throw new Error(`Touch coordinate must be a finite number: ${value}`);
	}
	return Math.min(1, Math.max(0, value));
}

/** タッチ（タッチ 3）。`x`・`y` は画面の幅・高さに対する 0〜1。 */
export function paradisSimulatorTouchFrame(phase: ParadisSimulatorTouchPhase, x: number, y: number, edge = 0): Uint8Array {
	if (!Number.isInteger(edge) || edge < 0 || edge > 4) {
		throw new Error(`Invalid touch edge: ${edge}`);
	}
	return frame(ParadisSimulatorFrameTag.Touch, edge ? { type: phase, x: clampUnit(x), y: clampUnit(y), edge } : { type: phase, x: clampUnit(x), y: clampUnit(y) });
}

/** 2 本指のタッチ（ピンチ）。座標はどちらも画面に対する 0〜1。 */
export function paradisSimulatorMultiTouchFrame(phase: ParadisSimulatorTouchPhase, x1: number, y1: number, x2: number, y2: number): Uint8Array {
	return frame(ParadisSimulatorFrameTag.MultiTouch, { type: phase, x1: clampUnit(x1), y1: clampUnit(y1), x2: clampUnit(x2), y2: clampUnit(y2) });
}

/** キー（キー 6）。`usage` は HID の keyboard page の usage。 */
export function paradisSimulatorKeyFrame(type: 'down' | 'up', usage: number): Uint8Array {
	if (!Number.isInteger(usage) || usage < 0 || usage > 0xffff) {
		throw new Error(`Invalid HID usage: ${usage}`);
	}
	return frame(ParadisSimulatorFrameTag.Key, { type, usage });
}

/** ボタン（ボタン 4）。音量は HID の page/usage で押して離す。 */
export function paradisSimulatorButtonFrame(button: ParadisSimulatorButton): Uint8Array {
	return button.kind === 'named'
		? frame(ParadisSimulatorFrameTag.Button, { button: button.name })
		: frame(ParadisSimulatorFrameTag.Button, { button: button.name, page: button.page, usage: button.usage, phase: 'press' });
}

/** 回転（回転 7）。 */
export function paradisSimulatorRotateFrame(orientation: ParadisSimulatorOrientation): Uint8Array {
	return frame(ParadisSimulatorFrameTag.Rotate, { orientation });
}

/** 開閉（開閉 14）。角度は 0〜180 の範囲の外を断る。 */
export function paradisSimulatorFoldFrame(fold: ParadisSimulatorFold): Uint8Array {
	if (fold.kind === 'pose') {
		return frame(ParadisSimulatorFrameTag.Fold, { pose: fold.pose });
	}
	if (!Number.isFinite(fold.hinge) || fold.hinge < 0 || fold.hinge > 180) {
		throw new Error(`Hinge angle must be between 0 and 180 degrees: ${fold.hinge}`);
	}
	return frame(ParadisSimulatorFrameTag.Fold, { hinge: fold.hinge });
}

/**
 * チャネルから来た入力を確かめてフレームにする。形が違えば投げる（renderer から来る値は信用しない）。
 */
export function paradisSimulatorInputFrame(input: unknown): Uint8Array {
	if (!input || typeof input !== 'object') {
		throw new Error('Simulator input must be an object');
	}
	const record = input as Record<string, unknown>;
	switch (record.kind) {
		case 'touch':
			if ((record.phase !== 'begin' && record.phase !== 'move' && record.phase !== 'end') || typeof record.x !== 'number' || typeof record.y !== 'number' || (record.edge !== undefined && typeof record.edge !== 'number')) {
				break;
			}
			return paradisSimulatorTouchFrame(record.phase, record.x, record.y, record.edge);
		case 'key':
			if ((record.type !== 'down' && record.type !== 'up') || typeof record.usage !== 'number') {
				break;
			}
			return paradisSimulatorKeyFrame(record.type, record.usage);
		case 'button': {
			const button = typeof record.button === 'string' ? paradisResolveSimulatorButton(record.button) : undefined;
			if (!button) {
				throw new Error(`Unknown button "${String(record.button)}". Known buttons: ${paradisSimulatorButtonNames().join(', ')}`);
			}
			return paradisSimulatorButtonFrame(button);
		}
		case 'rotate':
			if (typeof record.orientation !== 'string' || !(PARADIS_SIMULATOR_ORIENTATIONS as readonly string[]).includes(record.orientation)) {
				break;
			}
			return paradisSimulatorRotateFrame(record.orientation as ParadisSimulatorOrientation);
	}
	throw new Error(`Invalid simulator input: ${JSON.stringify(input).slice(0, 200)}`);
}

/** チャネルから来た開閉の要求を確かめる。姿勢の名前か角度のどちらか 1 つだけを受ける。 */
export function paradisParseSimulatorFold(value: unknown): ParadisSimulatorFold {
	const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const hasPose = record.pose !== undefined;
	const hasHinge = record.hinge !== undefined;
	if (hasPose === hasHinge) {
		throw new Error('Pass exactly one of "pose" or "hinge"');
	}
	if (hasPose) {
		const pose = PARADIS_SIMULATOR_POSES.find(candidate => candidate.id === record.pose);
		if (!pose) {
			throw new Error(`Unknown pose "${String(record.pose)}". Known poses: ${PARADIS_SIMULATOR_POSES.map(candidate => candidate.id).join(', ')}`);
		}
		return { kind: 'pose', pose: pose.id };
	}
	if (typeof record.hinge !== 'number' || !Number.isFinite(record.hinge) || record.hinge < 0 || record.hinge > 180) {
		throw new Error('"hinge" must be a number between 0 and 180');
	}
	return { kind: 'hinge', hinge: record.hinge };
}

/** ホストから届いたフレーム。知らない種類は undefined。 */
export type ParadisSimulatorHostMessage =
	| { readonly kind: 'config'; readonly config: IParadisSimulatorScreenConfig }
	| { readonly kind: 'foldAck'; readonly ok: boolean };

export function paradisParseSimulatorHostMessage(data: Uint8Array): ParadisSimulatorHostMessage | undefined {
	if (data.length < 2) {
		return undefined;
	}
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(data.subarray(1)));
	} catch {
		return undefined;
	}
	if (!body || typeof body !== 'object') {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	if (data[0] === ParadisSimulatorFrameTag.Config) {
		const config = paradisParseSimulatorScreenConfig(record);
		return config ? { kind: 'config', config } : undefined;
	}
	if (data[0] === ParadisSimulatorFrameTag.Fold) {
		return { kind: 'foldAck', ok: record.ok === true };
	}
	return undefined;
}

/** `/config` の JSON（または 0x82 の中身）を読む。形が違えば undefined。 */
export function paradisParseSimulatorScreenConfig(value: unknown): IParadisSimulatorScreenConfig | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.width !== 'number' || typeof record.height !== 'number' || typeof record.orientation !== 'string') {
		return undefined;
	}
	return typeof record.hingeDegrees === 'number'
		? { width: record.width, height: record.height, orientation: record.orientation, hingeDegrees: record.hingeDegrees }
		: { width: record.width, height: record.height, orientation: record.orientation };
}

// --- MJPEG ---

/** 1 枚の上限。これを超える Content-Length は壊れた流れとみなす。 */
const MJPEG_MAX_PART_BYTES = 32 * 1024 * 1024;
/** 頭（`--frame` から空行まで）の上限。 */
const MJPEG_MAX_HEADER_BYTES = 4 * 1024;

const CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a];

function indexOfSequence(haystack: Uint8Array, needle: readonly number[], from: number): number {
	outer: for (let i = from; i <= haystack.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				continue outer;
			}
		}
		return i;
	}
	return -1;
}

/**
 * MJPEG の流れを JPEG の 1 枚ずつに切る。`push` に届いた分を渡すと、揃った分の JPEG を返す。
 *
 * 境界は Content-Length で切る（JPEG の中身に境界の文字列が現れても切れないように）。
 * 頭が壊れていたら次の `--frame` まで読み飛ばす。
 */
export class ParadisMjpegSplitter {

	private _buffer = new Uint8Array(0);

	push(chunk: Uint8Array): Uint8Array[] {
		const merged = new Uint8Array(this._buffer.length + chunk.length);
		merged.set(this._buffer, 0);
		merged.set(chunk, this._buffer.length);
		this._buffer = merged;

		const frames: Uint8Array[] = [];
		for (; ;) {
			const start = this._indexOfBoundary(0);
			if (start === -1) {
				// 境界の途中かもしれない分だけ残す
				this._buffer = this._buffer.slice(Math.max(0, this._buffer.length - 8));
				return frames;
			}
			const headerEnd = indexOfSequence(this._buffer, CRLF_CRLF, start);
			if (headerEnd === -1) {
				if (this._buffer.length - start > MJPEG_MAX_HEADER_BYTES) {
					this._buffer = this._buffer.slice(start + 1);
					continue;
				}
				this._buffer = this._buffer.slice(start);
				return frames;
			}
			const header = new TextDecoder().decode(this._buffer.subarray(start, headerEnd));
			const lengthMatch = /content-length:\s*(?<length>\d+)/i.exec(header);
			const length = lengthMatch?.groups ? Number(lengthMatch.groups.length) : NaN;
			if (!Number.isSafeInteger(length) || length <= 0 || length > MJPEG_MAX_PART_BYTES) {
				this._buffer = this._buffer.slice(start + 1);
				continue;
			}
			const bodyStart = headerEnd + CRLF_CRLF.length;
			if (this._buffer.length < bodyStart + length) {
				this._buffer = this._buffer.slice(start);
				return frames;
			}
			frames.push(this._buffer.slice(bodyStart, bodyStart + length));
			this._buffer = this._buffer.slice(bodyStart + length);
		}
	}

	private _indexOfBoundary(from: number): number {
		// `--frame` + CRLF
		return indexOfSequence(this._buffer, [0x2d, 0x2d, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x0d, 0x0a], from);
	}
}

// --- simctl ---

function deviceState(value: unknown): ParadisSimulatorDeviceState {
	switch (value) {
		case 'Booted':
		case 'Shutdown':
		case 'Booting':
			return value;
		case 'Shutting Down':
			return 'ShuttingDown';
		default:
			return 'Unknown';
	}
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-27-1` → `iOS 27.1`。 */
export function paradisSimulatorRuntimeName(runtimeKey: string): string {
	const match = /SimRuntime\.(?<os>[A-Za-z]+)-(?<version>[0-9-]+)$/.exec(runtimeKey);
	if (!match?.groups) {
		return runtimeKey;
	}
	return `${match.groups.os} ${match.groups.version.replace(/-/g, '.')}`;
}

/**
 * `xcrun simctl list devices -j` の出力を読む。使えない端末（`isAvailable: false`）は落とす。
 * 並びは起動中を先に、同じなら名前の順。
 */
export function paradisParseSimctlDevices(stdout: string): IParadisSimulatorDevice[] {
	const parsed: unknown = JSON.parse(stdout);
	const devicesByRuntime = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).devices : undefined;
	if (!devicesByRuntime || typeof devicesByRuntime !== 'object') {
		throw new Error('simctl list devices returned no "devices" object');
	}
	const devices: IParadisSimulatorDevice[] = [];
	for (const [runtimeKey, list] of Object.entries(devicesByRuntime as Record<string, unknown>)) {
		if (!Array.isArray(list)) {
			continue;
		}
		for (const item of list) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const record = item as Record<string, unknown>;
			if (record.isAvailable === false || typeof record.udid !== 'string' || typeof record.name !== 'string') {
				continue;
			}
			devices.push({ udid: record.udid, name: record.name, runtime: paradisSimulatorRuntimeName(runtimeKey), state: deviceState(record.state) });
		}
	}
	return devices.sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted') || a.name.localeCompare(b.name) || a.runtime.localeCompare(b.runtime));
}

/**
 * Device Hub が入力を奪っているか（`simctl spawn <udid> notifyutil -g com.apple.coredevice.dtuhidd.active`
 * の出力。`<名前> 1` なら奪っている）。
 */
export function paradisDeviceHubActive(stdout: string): boolean {
	const last = stdout.trim().split(/\s+/).pop();
	return last === '1';
}
