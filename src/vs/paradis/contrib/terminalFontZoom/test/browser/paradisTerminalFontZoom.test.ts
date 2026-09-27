/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IXtermCore } from '../../../../../workbench/contrib/terminal/browser/xterm-private.js';
import { DEFAULT_COMMANDS_TO_SKIP_SHELL, ITerminalFont } from '../../../../../workbench/contrib/terminal/common/terminal.js';
import { paradisGetTerminalFontZoom, paradisSetTerminalFontZoom, paradisZoomTerminalFont } from '../../../terminalRenderer/browser/paradisTerminalFontZoom.js';
import { paradisNextTerminalFontZoom, paradisReadTerminalFontZoomMemory, paradisUpdateTerminalFontZoomMemory, ParadisTerminalFontZoomCommandId } from '../../browser/paradisTerminalFontZoom.contribution.js';

function core(rendered: boolean): Pick<IXtermCore, '_renderService'> {
	return {
		_renderService: {
			dimensions: { css: { cell: { width: 9, height: 18 } } },
			_renderer: { value: rendered ? {} : undefined },
		},
	};
}

suite('ParadisTerminalFontZoom', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const baseFont: ITerminalFont = { fontFamily: 'monospace', fontSize: 12, letterSpacing: 0, lineHeight: 1, charWidth: 7, charHeight: 14 };

	test('adds the per-terminal delta to the configured font, independently per terminal', () => {
		const zoomed = {};
		const untouched = {};
		paradisSetTerminalFontZoom(zoomed, 2);
		assert.deepStrictEqual({
			untouched: paradisZoomTerminalFont(untouched, baseFont, core(true)),
			rendered: paradisZoomTerminalFont(zoomed, baseFont, core(true)),
			// 描画前は設定の文字サイズで測った幅・高さなので、文字サイズの比で合わせる
			measured: paradisZoomTerminalFont(zoomed, baseFont, core(false)),
		}, {
			untouched: baseFont,
			rendered: { ...baseFont, fontSize: 14 },
			measured: { ...baseFont, fontSize: 14, charWidth: 7 * (14 / 12), charHeight: 14 * (14 / 12) },
		});
		paradisSetTerminalFontZoom(zoomed, 0);
		assert.strictEqual(paradisGetTerminalFontZoom(zoomed), 0);
	});

	test('stops growing the delta once the font size hits the upstream limits', () => {
		assert.deepStrictEqual({
			in: paradisNextTerminalFontZoom(12, 0, 1),
			out: paradisNextTerminalFontZoom(12, 0, -1),
			reset: paradisNextTerminalFontZoom(12, 5, 0),
			atMinimum: paradisNextTerminalFontZoom(7, -1, -1),
			atMaximum: paradisNextTerminalFontZoom(99, 1, 1),
		}, {
			in: 1,
			out: -1,
			reset: 0,
			atMinimum: -1,
			atMaximum: 1,
		});
	});

	test('remembers deltas by terminal nonce, drops cleared and malformed entries', () => {
		const memory = paradisReadTerminalFontZoomMemory(JSON.stringify([['a', 2], ['b', 1.5], [3, 1], ['c', 0], 'junk']));
		const afterSet = paradisUpdateTerminalFontZoomMemory(memory, 'd', -1);
		const afterClearAll = paradisUpdateTerminalFontZoomMemory(paradisReadTerminalFontZoomMemory(afterSet), 'a', 0);
		assert.deepStrictEqual({
			afterSet: JSON.parse(afterSet!),
			afterClear: JSON.parse(afterClearAll!),
			cleared: paradisUpdateTerminalFontZoomMemory(new Map([['x', 1]]), 'x', 0),
			broken: [...paradisReadTerminalFontZoomMemory('{')],
		}, {
			afterSet: [['a', 2], ['d', -1]],
			afterClear: [['d', -1]],
			cleared: undefined,
			broken: [],
		});
	});

	test('keeps the zoom keys away from the shell while a terminal has focus', () => {
		assert.deepStrictEqual(
			[ParadisTerminalFontZoomCommandId.ZoomIn, ParadisTerminalFontZoomCommandId.ZoomOut, ParadisTerminalFontZoomCommandId.ZoomReset].map(id => DEFAULT_COMMANDS_TO_SKIP_SHELL.includes(id)),
			[true, true, true],
		);
	});
});
