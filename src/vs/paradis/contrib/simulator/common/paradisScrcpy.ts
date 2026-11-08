/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// scrcpy-server v5.0.1（Apache-2.0, Copyright (C) 2018 Genymobile, (C) 2018-2026 Romain Vimont）と話す形の純関数
// （q.html Q585 の ⑥b）。scrcpy の通信の形は版ごとに変わる（doc/develop.md）ので、同梱した server の版と必ず合わせる。
//
//  - 映像のソケット: 最初の 64 バイトが端末の名前（最初に開いたソケットだけ）、続けて codec の id（u32）、
//    それから「セッションの包み」（12 バイト。先頭のビットが 1、幅と高さ）と「メディアの包み」（12 バイトの頭: 先頭の
//    ビットが 0、config・key frame の印と PTS、大きさ（u32）。続けて H.264 の Annex B のデータ）
//  - 操作のソケット: 先頭の 1 バイトが種類（app/src/control_msg.c の sc_control_msg_serialize と同じ並び）

import { VSBuffer } from '../../../../base/common/buffer.js';

/** 同梱する scrcpy-server の版（`build/paradis/simulator/vendorScrcpy.ts` と合わせる）。 */
export const PARADIS_SCRCPY_VERSION = '5.0.1';

/** 端末に置く場所（scrcpy の既定と同じ）。 */
export const PARADIS_SCRCPY_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';

const DEVICE_NAME_LENGTH = 64;
const CODEC_H264 = 0x68323634;

/** 31 ビットの乱数を 8 桁の 16 進にした scid（同じ端末で複数の server を区別する）。 */
export function paradisScrcpyScid(random: number): string {
	return (Math.floor(random * 0x7fffffff) & 0x7fffffff).toString(16).padStart(8, '0');
}

/** `adb -s <serial> shell` に渡す server の起動の引数。 */
export function paradisScrcpyServerArgs(scid: string, options: { readonly maxSize: number; readonly maxFps: number }): string[] {
	return [
		`CLASSPATH=${PARADIS_SCRCPY_DEVICE_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', PARADIS_SCRCPY_VERSION,
		`scid=${scid}`, 'log_level=info', 'audio=false', 'video_codec=h264', `max_size=${Math.max(0, Math.round(options.maxSize))}`, `max_fps=${Math.max(1, Math.round(options.maxFps))}`,
		'tunnel_forward=false', 'cleanup=true', 'clipboard_autosync=false', 'power_on=true',
	];
}

/** 映像のソケットから読んだもの。 */
export type ParadisScrcpyVideoEvent =
	| { readonly kind: 'device'; readonly name: string }
	| { readonly kind: 'session'; readonly width: number; readonly height: number }
	| { readonly kind: 'config'; readonly data: Uint8Array }
	| { readonly kind: 'frame'; readonly data: Uint8Array; readonly key: boolean; readonly pts: number };

/** 1 つのメディアの包みの上限（壊れた流れで大きな塊を確保しないため）。 */
const MAX_PACKET_BYTES = 16 * 1024 * 1024;

/**
 * 映像のソケットの流れを読む。`push` に届いた分を渡すと、揃った分のできごとを返す。形が違えば投げる
 * （codec が H.264 でない、包みが大きすぎる）。
 */
export class ParadisScrcpyVideoParser {

	private _buffer = new Uint8Array(0);
	private _state: 'device' | 'codec' | 'packets';

	constructor(expectDeviceName: boolean) {
		this._state = expectDeviceName ? 'device' : 'codec';
	}

	push(chunk: Uint8Array): ParadisScrcpyVideoEvent[] {
		const merged = new Uint8Array(this._buffer.length + chunk.length);
		merged.set(this._buffer, 0);
		merged.set(chunk, this._buffer.length);
		this._buffer = merged;
		const events: ParadisScrcpyVideoEvent[] = [];
		for (; ;) {
			const view = new DataView(this._buffer.buffer, this._buffer.byteOffset, this._buffer.byteLength);
			if (this._state === 'device') {
				if (this._buffer.length < DEVICE_NAME_LENGTH) {
					return events;
				}
				const bytes = this._buffer.subarray(0, DEVICE_NAME_LENGTH);
				const end = bytes.indexOf(0);
				events.push({ kind: 'device', name: new TextDecoder().decode(bytes.subarray(0, end === -1 ? DEVICE_NAME_LENGTH : end)) });
				this._consume(DEVICE_NAME_LENGTH);
				this._state = 'codec';
				continue;
			}
			if (this._state === 'codec') {
				if (this._buffer.length < 4) {
					return events;
				}
				const codec = view.getUint32(0);
				if (codec !== CODEC_H264) {
					throw new Error(`scrcpy sent an unexpected video codec 0x${codec.toString(16)}`);
				}
				this._consume(4);
				this._state = 'packets';
				continue;
			}
			if (this._buffer.length < 12) {
				return events;
			}
			const first = view.getUint32(0);
			if (first & 0x80000000) {
				events.push({ kind: 'session', width: view.getUint32(4), height: view.getUint32(8) });
				this._consume(12);
				continue;
			}
			const size = view.getUint32(8);
			if (size > MAX_PACKET_BYTES) {
				throw new Error(`scrcpy sent a video packet of ${size} bytes`);
			}
			if (this._buffer.length < 12 + size) {
				return events;
			}
			const config = (first & 0x40000000) !== 0;
			const key = (first & 0x20000000) !== 0;
			// PTS は下の 61 ビット（マイクロ秒）。上の 32 ビットのうち 29 ビットと下の 32 ビットを合わせる
			const pts = (first & 0x1fffffff) * 0x100000000 + view.getUint32(4);
			const data = this._buffer.slice(12, 12 + size);
			events.push(config ? { kind: 'config', data } : { kind: 'frame', data, key, pts });
			this._consume(12 + size);
		}
	}

	private _consume(length: number): void {
		this._buffer = this._buffer.slice(length);
	}
}

// --- 操作 ---

const enum ParadisScrcpyControlType {
	InjectKeycode = 0,
	InjectText = 1,
	InjectTouch = 2,
	BackOrScreenOn = 4,
	GetClipboard = 8,
	SetClipboard = 9,
	ResetVideo = 17,
}

/** Android の MotionEvent の action。 */
export const enum ParadisScrcpyTouchAction {
	Down = 0,
	Up = 1,
	Move = 2,
}

/**
 * タッチ（指 1 本ぶん）。`x`・`y` は映像の画素で、`width`・`height` は今の映像の大きさ（server は大きさが今の映像と
 * 違うタッチを捨てる）。2 本指は `pointerId` を変えて送る（server が POINTER_DOWN などに直す）。
 */
export function paradisScrcpyTouch(action: ParadisScrcpyTouchAction, pointerId: number, x: number, y: number, width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(32);
	const view = new DataView(bytes.buffer);
	bytes[0] = ParadisScrcpyControlType.InjectTouch;
	bytes[1] = action;
	view.setBigUint64(2, BigInt(pointerId));
	view.setInt32(10, Math.round(Math.min(width - 1, Math.max(0, x))));
	view.setInt32(14, Math.round(Math.min(height - 1, Math.max(0, y))));
	view.setUint16(18, width);
	view.setUint16(20, height);
	// 押す強さ 1.0（u16 の固定小数）。離すときは 0
	view.setUint16(22, action === ParadisScrcpyTouchAction.Up ? 0 : 0xffff);
	view.setInt32(24, 0);
	view.setInt32(28, 0);
	return bytes;
}

/** キー（Android の keycode）。`down` で押す、`false` で離す。 */
export function paradisScrcpyKeycode(down: boolean, keycode: number, metaState = 0): Uint8Array {
	const bytes = new Uint8Array(14);
	const view = new DataView(bytes.buffer);
	bytes[0] = ParadisScrcpyControlType.InjectKeycode;
	bytes[1] = down ? 0 : 1;
	view.setInt32(2, keycode);
	view.setInt32(6, 0);
	view.setInt32(10, metaState);
	return bytes;
}

const MAX_TEXT_BYTES = 300;

/** 文字を打つ（scrcpy の INJECT_TEXT。300 バイトまで。それより長ければ呼ぶ側で分ける）。 */
export function paradisScrcpyText(text: string): Uint8Array {
	const utf8 = new TextEncoder().encode(text);
	if (utf8.length > MAX_TEXT_BYTES) {
		throw new Error('scrcpy text messages are limited to 300 bytes');
	}
	const bytes = new Uint8Array(5 + utf8.length);
	bytes[0] = ParadisScrcpyControlType.InjectText;
	new DataView(bytes.buffer).setUint32(1, utf8.length);
	bytes.set(utf8, 5);
	return bytes;
}

/**
 * 端末のクリップボードに写して貼る（日本語など、キーで打てない文字を入れるため）。`sequence` は 0 なら返事を求めない。
 */
export function paradisScrcpySetClipboard(text: string, paste: boolean, sequence = 0): Uint8Array {
	const utf8 = new TextEncoder().encode(text);
	if (utf8.length > (1 << 18) - 14) {
		throw new Error('The text is too long for the device clipboard');
	}
	const bytes = new Uint8Array(14 + utf8.length);
	const view = new DataView(bytes.buffer);
	bytes[0] = ParadisScrcpyControlType.SetClipboard;
	view.setBigUint64(1, BigInt(sequence));
	bytes[9] = paste ? 1 : 0;
	view.setUint32(10, utf8.length);
	bytes.set(utf8, 14);
	return bytes;
}

/** 端末のクリップボードの中身を求める（返事は操作のソケットに `clipboard` で届く。空なら返事は来ない）。 */
export function paradisScrcpyGetClipboard(): Uint8Array {
	// copy_key は NONE（コピーやカットのキーは押さない）
	return new Uint8Array([ParadisScrcpyControlType.GetClipboard, 0]);
}

/** 端末から操作のソケットに届くもの。 */
export type ParadisScrcpyDeviceMessage =
	| { readonly kind: 'clipboard'; readonly text: string }
	| { readonly kind: 'ackClipboard'; readonly sequence: bigint }
	| { readonly kind: 'uhidOutput' };

/** 1 つの知らせの上限（クリップボードの上限と同じ 256KiB）。 */
const MAX_DEVICE_MESSAGE_BYTES = 1 << 18;

/** 操作のソケットに端末から届く流れを読む（scrcpy の app/src/device_msg.c と同じ並び）。形が違えば投げる。 */
export class ParadisScrcpyDeviceMessageParser {

	private _buffer = new Uint8Array(0);

	push(chunk: Uint8Array): ParadisScrcpyDeviceMessage[] {
		const merged = new Uint8Array(this._buffer.length + chunk.length);
		merged.set(this._buffer, 0);
		merged.set(chunk, this._buffer.length);
		this._buffer = merged;
		const messages: ParadisScrcpyDeviceMessage[] = [];
		for (; ;) {
			if (this._buffer.length < 1) {
				return messages;
			}
			const view = new DataView(this._buffer.buffer, this._buffer.byteOffset, this._buffer.byteLength);
			switch (this._buffer[0]) {
				case 0: {
					if (this._buffer.length < 5) {
						return messages;
					}
					const length = view.getUint32(1);
					if (length > MAX_DEVICE_MESSAGE_BYTES) {
						throw new Error(`scrcpy sent a clipboard of ${length} bytes`);
					}
					if (this._buffer.length < 5 + length) {
						return messages;
					}
					messages.push({ kind: 'clipboard', text: new TextDecoder().decode(this._buffer.subarray(5, 5 + length)) });
					this._buffer = this._buffer.slice(5 + length);
					break;
				}
				case 1:
					if (this._buffer.length < 9) {
						return messages;
					}
					messages.push({ kind: 'ackClipboard', sequence: view.getBigUint64(1) });
					this._buffer = this._buffer.slice(9);
					break;
				case 2: {
					if (this._buffer.length < 5) {
						return messages;
					}
					const size = view.getUint16(3);
					if (this._buffer.length < 5 + size) {
						return messages;
					}
					messages.push({ kind: 'uhidOutput' });
					this._buffer = this._buffer.slice(5 + size);
					break;
				}
				default:
					throw new Error(`scrcpy sent an unknown device message ${this._buffer[0]}`);
			}
		}
	}
}

/** エージェントの指の pointer の id の最初（人の指は 0。エージェントの指 n は この値 + n にして重ねない）。 */
export const PARADIS_SCRCPY_AGENT_POINTER_BASE = 100;

/** 次の key frame を求める（映像の復号が崩れたとき）。 */
export function paradisScrcpyResetVideo(): Uint8Array {
	return new Uint8Array([ParadisScrcpyControlType.ResetVideo]);
}

/**
 * H.264 の Annex B のデータから SPS を探し、WebCodecs の codec の文字列（`avc1.PPCCLL`）を作る。見つからなければ undefined。
 */
export function paradisH264CodecString(annexB: Uint8Array): string | undefined {
	for (let i = 0; i + 4 < annexB.length; i++) {
		const startCode3 = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
		if (!startCode3) {
			continue;
		}
		const header = annexB[i + 3];
		if ((header & 0x1f) === 7 && i + 6 < annexB.length) {
			const hex = (value: number) => value.toString(16).padStart(2, '0');
			return `avc1.${hex(annexB[i + 4])}${hex(annexB[i + 5])}${hex(annexB[i + 6])}`;
		}
	}
	return undefined;
}

/** ペインのキー（`KeyboardEvent.code`）→ Android の keycode（文字は INJECT_TEXT で送るので、ここは文字でないキー）。 */
const ANDROID_KEYCODE_BY_CODE: { readonly [code: string]: number } = {
	Enter: 66, NumpadEnter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111,
	ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, PageUp: 92, PageDown: 93,
};

export function paradisAndroidKeycodeForCode(code: string): number | undefined {
	return Object.prototype.hasOwnProperty.call(ANDROID_KEYCODE_BY_CODE, code) ? ANDROID_KEYCODE_BY_CODE[code] : undefined;
}

/** ペインの人の入力（チャネルで送る形。座標は映像に対する 0〜1）。 */
export type ParadisAndroidInput =
	| { readonly kind: 'touch'; readonly phase: 'begin' | 'move' | 'end'; readonly x: number; readonly y: number }
	| { readonly kind: 'key'; readonly down: boolean; readonly code: string; readonly key: string }
	| { readonly kind: 'button'; readonly button: string };

/**
 * ペインの入力を確かめて scrcpy の操作のメッセージにする。`size` は今の映像の大きさ。送るものが無ければ空。
 * 形が違えば投げる（renderer から来る値は信用しない）。`keycodeOfButton` は adb と同じボタンの対応表。
 */
export function paradisAndroidInputMessages(input: unknown, size: { readonly width: number; readonly height: number }, keycodeOfButton: (button: string) => number | undefined): Uint8Array[] {
	const record = input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
	switch (record?.kind) {
		case 'touch': {
			const action = record.phase === 'begin' ? ParadisScrcpyTouchAction.Down : record.phase === 'move' ? ParadisScrcpyTouchAction.Move : record.phase === 'end' ? ParadisScrcpyTouchAction.Up : undefined;
			if (action === undefined || typeof record.x !== 'number' || typeof record.y !== 'number' || !Number.isFinite(record.x) || !Number.isFinite(record.y)) {
				break;
			}
			const x = Math.min(1, Math.max(0, record.x)) * size.width;
			const y = Math.min(1, Math.max(0, record.y)) * size.height;
			return [paradisScrcpyTouch(action, 0, x, y, size.width, size.height)];
		}
		case 'key': {
			if (typeof record.down !== 'boolean' || typeof record.code !== 'string' || typeof record.key !== 'string') {
				break;
			}
			const keycode = paradisAndroidKeycodeForCode(record.code);
			if (keycode !== undefined) {
				return [paradisScrcpyKeycode(record.down, keycode)];
			}
			// 文字のキーは押したときに文字として送る（配列や IME の違いを端末側に任せない）
			return record.down && [...record.key].length === 1 ? [paradisScrcpyText(record.key)] : [];
		}
		case 'button': {
			const keycode = typeof record.button === 'string' ? keycodeOfButton(record.button) : undefined;
			if (keycode === undefined) {
				throw new Error(`Unknown button "${String(record.button)}"`);
			}
			return [paradisScrcpyKeycode(true, keycode), paradisScrcpyKeycode(false, keycode)];
		}
	}
	throw new Error(`Invalid Android input: ${JSON.stringify(input)?.slice(0, 200)}`);
}

/** チャネルの `androidVideo` のイベントで届くもの（H.264 の Annex B の包み）。 */
export type ParadisAndroidVideoWire =
	| { readonly serial: string; readonly kind: 'size'; readonly width: number; readonly height: number }
	| { readonly serial: string; readonly kind: 'config'; readonly data: VSBuffer }
	| { readonly serial: string; readonly kind: 'frame'; readonly data: VSBuffer; readonly key: boolean; readonly pts: number }
	| { readonly serial: string; readonly kind: 'ended'; readonly reason?: string };
