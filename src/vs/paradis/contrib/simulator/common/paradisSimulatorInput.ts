/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのエディタのペインで、人の入力を serve-sim の形に直すための純関数。
//
// 向きの扱い（映像の回し方・画面の上の位置から端末の向きの座標への直し方・下端のホームのジェスチャーの印）は、
// serve-sim 0.1.49 の `src/client/simulator/orientation.ts`（Apache-2.0, Copyright 2026 Evan Bacon）の
// `streamDisplayGeometry`・`rawPointForDisplayPoint`・`rawEdgeForDisplayEdge`・`homeIndicatorEdge` に合わせて書き直した。
// serve-sim の MJPEG は端末の向きのまま流れてくる（横に回しても、生の映像が縦のままのことがある）ので、
// 表示は CSS で回し、入力は回した分を戻して送る。

import { ParadisSimulatorOrientation } from './paradisSimulator.js';

export interface IParadisSimulatorSize {
	readonly width: number;
	readonly height: number;
}

/**
 * 映像（`frame` の画素数）を、縦横の比を保ったまま `area` に収まる一番大きな大きさにする（CSS の px）。
 * 大きさが分からないときは 0。
 */
export function paradisSimulatorFitSize(area: IParadisSimulatorSize, frame: IParadisSimulatorSize): IParadisSimulatorSize {
	if (area.width <= 0 || area.height <= 0 || frame.width <= 0 || frame.height <= 0) {
		return { width: 0, height: 0 };
	}
	const scale = Math.min(area.width / frame.width, area.height / frame.height);
	return { width: Math.floor(frame.width * scale), height: Math.floor(frame.height * scale) };
}

/**
 * 画面の上の位置（`clientX`・`clientY`）を、映像の矩形に対する 0〜1 に直す。矩形の外は端に寄せる
 * （ドラッグで映像の外へ出ても、端で動き続けるように）。矩形の大きさが 0 なら undefined。
 */
export function paradisSimulatorPointFromClient(rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }, clientX: number, clientY: number): { readonly x: number; readonly y: number } | undefined {
	if (rect.width <= 0 || rect.height <= 0) {
		return undefined;
	}
	const clamp = (value: number) => Math.min(1, Math.max(0, value));
	return { x: clamp((clientX - rect.left) / rect.width), y: clamp((clientY - rect.top) / rect.height) };
}

/** 「回転」のボタンで次に向ける向き（右回り）。知らない向きなら縦。 */
export function paradisSimulatorNextOrientation(current: string | undefined): ParadisSimulatorOrientation {
	switch (current) {
		case 'portrait':
			return 'landscape_right';
		case 'landscape_right':
			return 'portrait_upside_down';
		case 'portrait_upside_down':
			return 'landscape_left';
		case 'landscape_left':
			return 'portrait';
		default:
			return 'portrait';
	}
}

/** `KeyboardEvent.code` → HID の keyboard page（0x07）の usage。 */
const HID_USAGE_BY_CODE: { readonly [code: string]: number } = (() => {
	const table: { [code: string]: number } = {};
	for (let i = 0; i < 26; i++) {
		table[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
	}
	for (let i = 1; i <= 9; i++) {
		table[`Digit${i}`] = 0x1e + i - 1;
	}
	table.Digit0 = 0x27;
	Object.assign(table, {
		Enter: 0x28, NumpadEnter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
		Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
		Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
		CapsLock: 0x39, Delete: 0x4c, Home: 0x4a, End: 0x4d, PageUp: 0x4b, PageDown: 0x4e,
		ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
		IntlBackslash: 0x64, IntlRo: 0x87, IntlYen: 0x89,
		ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
		ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
	});
	return table;
})();

/** キーの物理的な位置（`KeyboardEvent.code`）の HID の usage。対応が無ければ undefined。 */
export function paradisSimulatorHidUsage(code: string): number | undefined {
	return Object.prototype.hasOwnProperty.call(HID_USAGE_BY_CODE, code) ? HID_USAGE_BY_CODE[code] : undefined;
}

/**
 * そのキーの操作をシミュレータへ送るか。Command・Control を押しながらの操作は Para Code の
 * ショートカット（タブを閉じる・コマンドパレットなど）に残し、送らない。IME の変換中も送らない。
 */
export function paradisSimulatorShouldSendKey(event: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly isComposing: boolean; readonly code: string }): boolean {
	if (event.metaKey || event.ctrlKey || event.isComposing) {
		return false;
	}
	return paradisSimulatorHidUsage(event.code) !== undefined;
}

/** 映している画面の大きさと向き（serve-sim の config）。 */
export interface IParadisSimulatorOrientedSize extends IParadisSimulatorSize {
	readonly orientation?: string;
}

/** 映像の表示の仕方。 */
export interface IParadisSimulatorDisplayGeometry {
	/** 表示する大きさ（横向きなら幅が長い方）。 */
	readonly display: IParadisSimulatorSize;
	/** 映像を CSS で回す角度（0・90・-90・180）。 */
	readonly rotationDegrees: number;
	/** 入力を端末の向きへ戻すときの向き。回していなければ undefined。 */
	readonly inputOrientation: ParadisSimulatorOrientation | undefined;
}

function rotationForOrientation(orientation: string | undefined): number {
	switch (orientation) {
		case 'landscape_left': return 90;
		case 'landscape_right': return -90;
		case 'portrait_upside_down': return 180;
		default: return 0;
	}
}

/**
 * 生の映像の大きさ（`frame`）と端末の向きから、表示の仕方を決める。180° と、横向きなのに生の映像が縦のときだけ
 * CSS で回す（生の映像がもう横なら回さない）。
 */
export function paradisSimulatorDisplayGeometry(frame: IParadisSimulatorOrientedSize): IParadisSimulatorDisplayGeometry {
	const rotation = rotationForOrientation(frame.orientation);
	const sideways = Math.abs(rotation) === 90;
	const rawLandscape = frame.width > frame.height;
	const needsRotation = rotation === 180 || (sideways && !rawLandscape);
	const landscape = sideways || rawLandscape;
	const long = Math.max(frame.width, frame.height);
	const short = Math.min(frame.width, frame.height);
	return {
		display: landscape ? { width: long, height: short } : { width: short, height: long },
		rotationDegrees: needsRotation ? rotation : 0,
		inputOrientation: needsRotation ? frame.orientation as ParadisSimulatorOrientation : undefined,
	};
}

/** 表示の上の 0〜1 の位置を、端末の向き（生の映像）の 0〜1 へ戻す。 */
export function paradisSimulatorRawPoint(orientation: ParadisSimulatorOrientation | undefined, x: number, y: number): { readonly x: number; readonly y: number } {
	switch (orientation) {
		case 'landscape_left': return { x: y, y: 1 - x };
		case 'landscape_right': return { x: 1 - y, y: x };
		case 'portrait_upside_down': return { x: 1 - x, y: 1 - y };
		default: return { x, y };
	}
}

/** HID のタッチの端の印（serve-sim と同じ値）。 */
export const enum ParadisSimulatorTouchEdge {
	None = 0,
	Left = 1,
	Top = 2,
	Bottom = 3,
	Right = 4,
}

/** 下端のこの割合より下で始まったドラッグを、ホームへ戻るジェスチャーとして印を付ける（serve-sim と同じ）。 */
const HOME_INDICATOR_BAND = 0.93;

/**
 * 表示の上で `y` から始まったタッチに付ける端の印（端末の向きへ戻した値）。下端の帯の外なら None。
 */
export function paradisSimulatorTouchEdge(orientation: ParadisSimulatorOrientation | undefined, displayY: number): ParadisSimulatorTouchEdge {
	if (displayY < HOME_INDICATOR_BAND) {
		return ParadisSimulatorTouchEdge.None;
	}
	switch (orientation) {
		case 'landscape_left': return ParadisSimulatorTouchEdge.Right;
		case 'landscape_right': return ParadisSimulatorTouchEdge.Left;
		case 'portrait_upside_down': return ParadisSimulatorTouchEdge.Top;
		default: return ParadisSimulatorTouchEdge.Bottom;
	}
}

/**
 * 映像が途切れたときに読み直すまでの待ち（回目ごと）。これを使い切ったら止めて「再試行」のボタンを出す
 * （端末が起動中のまま映像だけ出ないときに、止める・始めるを繰り返さないように）。
 */
export const PARADIS_SIMULATOR_STALL_RETRY_DELAYS_MS: readonly number[] = [5000, 10_000, 20_000, 40_000];

/** `attempt` 回目（0 から）の途切れのあと、読み直すまでの待ち。使い切っていれば undefined（止める）。 */
export function paradisSimulatorStallRetryDelay(attempt: number): number | undefined {
	return PARADIS_SIMULATOR_STALL_RETRY_DELAYS_MS[attempt];
}

/** 1 文字ぶんのキーの押し方（US 配列）。 */
export interface IParadisSimulatorKeystroke {
	readonly usage: number;
	readonly shift: boolean;
}

const SHIFTED_DIGITS = ')!@#$%^&*(';
const SYMBOL_KEYS: { readonly [char: string]: readonly [code: string, shift: boolean] } = {
	' ': ['Space', false], '\n': ['Enter', false], '\t': ['Tab', false],
	'-': ['Minus', false], '_': ['Minus', true], '=': ['Equal', false], '+': ['Equal', true],
	'[': ['BracketLeft', false], '{': ['BracketLeft', true], ']': ['BracketRight', false], '}': ['BracketRight', true],
	'\\': ['Backslash', false], '|': ['Backslash', true], ';': ['Semicolon', false], ':': ['Semicolon', true],
	'\'': ['Quote', false], '"': ['Quote', true], '`': ['Backquote', false], '~': ['Backquote', true],
	',': ['Comma', false], '<': ['Comma', true], '.': ['Period', false], '>': ['Period', true],
	'/': ['Slash', false], '?': ['Slash', true],
};

/**
 * 文字列を、HID のキーで打てる押し方の並びにする（シミュレータのハードウェアキーボードは US 配列）。
 * キーで打てない文字（日本語など）が 1 つでもあれば undefined（呼び出し側は貼り付けで入れる）。
 */
export function paradisSimulatorKeystrokes(input: string): IParadisSimulatorKeystroke[] | undefined {
	const strokes: IParadisSimulatorKeystroke[] = [];
	for (const char of input) {
		let code: string | undefined;
		let shift = false;
		if (/^[a-z]$/.test(char)) {
			code = `Key${char.toUpperCase()}`;
		} else if (/^[A-Z]$/.test(char)) {
			code = `Key${char}`;
			shift = true;
		} else if (/^[0-9]$/.test(char)) {
			code = `Digit${char}`;
		} else if (SHIFTED_DIGITS.includes(char)) {
			code = `Digit${SHIFTED_DIGITS.indexOf(char)}`;
			shift = true;
		} else if (Object.prototype.hasOwnProperty.call(SYMBOL_KEYS, char)) {
			[code, shift] = SYMBOL_KEYS[char];
		}
		const usage = code ? paradisSimulatorHidUsage(code) : undefined;
		if (usage === undefined) {
			return undefined;
		}
		strokes.push({ usage, shift });
	}
	return strokes;
}
