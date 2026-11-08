/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのエディタのペインで、人の入力を serve-sim の形に直すための純関数。

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
