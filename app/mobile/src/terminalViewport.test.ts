// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	TERMINAL_FONT_SIZE_DEFAULT,
	TERMINAL_VIEWPORT_MIN_COLS,
	clampTerminalFontSize,
	terminalGridFor,
	terminalViewportEquals,
} from './terminalViewport.js';

/** Menlo の実測値（100px時）。WebView が実際に測って渡してくる値と同じ桁。 */
const MENLO = { charWidth100: 60.205, lineHeight100: 120 };

/** iPhone 15 Pro のターミナル表示領域（本文369pt − 内側padding 10pt、高さ520pt − 10pt）。 */
const IPHONE = { width: 359, height: 510 };

describe('terminalGridFor', () => {
	test('既定サイズのiPhoneで、読める桁数・行数になる', () => {
		expect(terminalGridFor(IPHONE.width, IPHONE.height, TERMINAL_FONT_SIZE_DEFAULT, MENLO)).toEqual({ cols: 59, rows: 42 });
	});

	test('文字を大きくすると桁数・行数が減る', () => {
		expect(terminalGridFor(IPHONE.width, IPHONE.height, 14, MENLO)).toEqual({ cols: 42, rows: 30 });
	});

	test('はみ出さないよう端数は切り捨てる', () => {
		// 10pt で 1文字 = 10px / 1行 = 10px になる metrics。25.5文字ぶんの幅では 26桁目は入らない。
		expect(terminalGridFor(255, 305, 10, { charWidth100: 100, lineHeight100: 100 })).toEqual({ cols: 25, rows: 30 });
	});

	test('極端に狭くても下限で止める（PTYを壊さない）', () => {
		expect(terminalGridFor(20, 20, 20, MENLO)).toEqual({ cols: TERMINAL_VIEWPORT_MIN_COLS, rows: 5 });
	});

	test('寸法が測れていないうちは申告しない', () => {
		expect(terminalGridFor(0, 510, 10, MENLO)).toBeUndefined();
		expect(terminalGridFor(359, 510, 10, { charWidth100: 0, lineHeight100: 120 })).toBeUndefined();
	});
});

describe('clampTerminalFontSize', () => {
	test('範囲外・壊れた保存値を既定または境界へ丸める', () => {
		expect([clampTerminalFontSize(3), clampTerminalFontSize(99), clampTerminalFontSize(10.4), clampTerminalFontSize(Number.NaN)])
			.toEqual([6, 20, 10, TERMINAL_FONT_SIZE_DEFAULT]);
	});
});

describe('terminalViewportEquals', () => {
	test('値が同じなら等しい（再送を抑えるため）', () => {
		expect([
			terminalViewportEquals({ cols: 59, rows: 42 }, { cols: 59, rows: 42 }),
			terminalViewportEquals({ cols: 59, rows: 42 }, { cols: 59, rows: 41 }),
			terminalViewportEquals(undefined, undefined),
			terminalViewportEquals({ cols: 59, rows: 42 }, undefined),
		]).toEqual([true, false, true, false]);
	});
});
