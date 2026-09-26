/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナル単体の文字サイズ（Q41 B / TM21）の状態。
//
// 文字サイズは upstream では `terminal.integrated.fontSize` 1つで全ターミナル共通。ここでは
// ターミナルごとに「設定値からの差分（px）」を持ち、xtermTerminal.ts の `getFont()` の
// PARA-PATCH 1か所で差分を足す。upstream がフォントを当て直す経路（設定変更時の `_resize`、
// 行数/列数の計算）はすべて `getFont()` を通るので、設定の文字サイズを変えてもこの差分は保たれる。
//
// キーは XtermTerminal のオブジェクトそのもの（WeakMap）。ターミナルが破棄されれば差分も消える。
// 操作（⌘= / ⌘− / テンキーの ⌘0）は terminalFontZoom/browser/paradisTerminalFontZoom.contribution.ts が持つ。

import type { ITerminalFont } from '../../../../workbench/contrib/terminal/common/terminal.js';
import type { IXtermCore } from '../../../../workbench/contrib/terminal/browser/xterm-private.js';

/** upstream の `clampTerminalFontSize`（terminal.zoom.contribution.ts）と同じ範囲。 */
export const PARADIS_TERMINAL_FONT_SIZE_MIN = 6;
export const PARADIS_TERMINAL_FONT_SIZE_MAX = 100;

const zoomByTerminal = new WeakMap<object, number>();

/** そのターミナルの文字サイズの差分（px）。未設定なら 0。 */
export function paradisGetTerminalFontZoom(terminal: object): number {
	return zoomByTerminal.get(terminal) ?? 0;
}

/** そのターミナルの文字サイズの差分（px）を記録する。0 なら消す。 */
export function paradisSetTerminalFontZoom(terminal: object, delta: number): void {
	if (!Number.isFinite(delta) || delta === 0) {
		zoomByTerminal.delete(terminal);
	} else {
		zoomByTerminal.set(terminal, Math.round(delta));
	}
}

/** 設定の文字サイズに差分を足し、upstream と同じ範囲に収める。 */
export function paradisZoomedFontSize(baseFontSize: number, delta: number): number {
	return Math.max(PARADIS_TERMINAL_FONT_SIZE_MIN, Math.min(PARADIS_TERMINAL_FONT_SIZE_MAX, baseFontSize + delta));
}

/**
 * `ITerminalConfigurationService.getFont()` の結果にそのターミナルの差分を足す。
 *
 * 文字の幅・高さは、描画済みなら xterm の実測（= すでに差分込みの文字サイズで描いた結果）なのでそのまま使う。
 * 描画前は upstream が設定の文字サイズで測った値なので、文字サイズの比で拡大・縮小する。
 */
export function paradisZoomTerminalFont(terminal: object, font: ITerminalFont, core: Pick<IXtermCore, '_renderService'> | undefined): ITerminalFont {
	const delta = paradisGetTerminalFontZoom(terminal);
	if (delta === 0) {
		return font;
	}
	const fontSize = paradisZoomedFontSize(font.fontSize, delta);
	if (fontSize === font.fontSize) {
		return font;
	}
	const cell = core?._renderService?._renderer.value ? core._renderService.dimensions.css.cell : undefined;
	const measuredByRenderer = !!cell?.width && !!cell?.height;
	if (measuredByRenderer || font.charWidth === undefined || font.charHeight === undefined) {
		return { ...font, fontSize };
	}
	const ratio = fontSize / font.fontSize;
	return { ...font, fontSize, charWidth: font.charWidth * ratio, charHeight: font.charHeight * ratio };
}
