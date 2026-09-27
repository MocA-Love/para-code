/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisRenderGrid,
	paradisIsSuspectDivergence,
	paradisIsThinGlyph,
	paradisMeasureRenderDivergence,
	paradisMissingCellCoordinates,
	paradisMissingSetsOverlap,
	ParadisRenderDesyncGate,
	paradisRenderRecordName,
	paradisRenderRecordsToPrune,
	PARADIS_RENDER_REPAIR_COOLDOWN,
} from '../../common/paradisRenderDesync.js';

const BACKGROUND: readonly [number, number, number] = [30, 30, 30];

/** 4x4 画素のセルが並ぶ画像。inked に入っているセルだけ中央に白い画素を置く。 */
function makeImage(rows: number, cols: number, inked: (row: number, col: number) => boolean, alpha = 255) {
	const width = cols * 4;
	const height = rows * 4;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data.set([BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], alpha], i * 4);
	}
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			if (inked(row, col)) {
				const index = ((row * 4 + 1) * width + col * 4 + 1) * 4;
				data.set([220, 220, 220, 255], index);
			}
		}
	}
	return { data, width, height };
}

function grid(rows: number, cols: number): IParadisRenderGrid {
	return { rows, cols, cellWidth: 4, cellHeight: 4, cursorRow: -1, backgroundRgb: BACKGROUND };
}

suite('ParadisRenderDesync', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts text cells that have no ink on screen', () => {
		// 20x20 = 400 文字。左端の列だけ欠けている（20 / 400 = 5%）→ 疑いにならない
		const partial = paradisMeasureRenderDivergence(makeImage(20, 20, (_row, col) => col !== 0), grid(20, 20), () => true);
		// 左の4列が欠けている（80 / 400 = 20%）→ 疑い
		const broken = paradisMeasureRenderDivergence(makeImage(20, 20, (_row, col) => col >= 4), grid(20, 20), () => true);
		assert.deepStrictEqual({
			partial: [partial.textCells, partial.missing, paradisIsSuspectDivergence(partial)],
			broken: [broken.textCells, broken.missing, paradisIsSuspectDivergence(broken)],
		}, { partial: [400, 20, false], broken: [400, 80, true] });
	});

	test('does not judge screens with little text or a transparent background', () => {
		// 文字が少ない（100 セル）画面は割合が暴れるので判定しない
		const small = paradisMeasureRenderDivergence(makeImage(10, 10, () => false), grid(10, 10), () => true);
		// 背景の alpha が 0（ウィンドウ透過）なら、背景の画素をインクと数えない（欠けとして正しく数える）
		const transparent = paradisMeasureRenderDivergence(makeImage(20, 20, () => false, 0), grid(20, 20), () => true);
		// 全部が欠けて見える（描画バッファを読めなかった）ときは測れなかったとみなし、判定しない
		const blank = paradisMeasureRenderDivergence(makeImage(20, 20, () => false), grid(20, 20), () => true);
		assert.deepStrictEqual({
			small: paradisIsSuspectDivergence(small),
			transparentMissing: transparent.missing,
			transparentSuspect: paradisIsSuspectDivergence(transparent),
			blankSuspect: paradisIsSuspectDivergence(blank),
		}, { small: false, transparentMissing: 400, transparentSuspect: false, blankSuspect: false });
	});

	test('ignores thin glyphs and records only the coordinates of missing cells', () => {
		const divergence = paradisMeasureRenderDivergence(makeImage(20, 20, (row, col) => !(row === 1 && col < 3)), grid(20, 20), () => true);
		assert.deepStrictEqual({
			thin: ['.', '_', '\u2500', 'a', '\u3042'].map(paradisIsThinGlyph),
			coords: paradisMissingCellCoordinates(divergence, 20),
		}, { thin: [true, true, true, false, false], coords: [[1, 0], [1, 1], [1, 2]] });
	});

	test('requires the same cells to stay missing', () => {
		assert.deepStrictEqual([
			paradisMissingSetsOverlap(new Set([1, 2, 3, 4]), new Set([1, 2, 3, 5])),
			paradisMissingSetsOverlap(new Set([1, 2, 3, 4]), new Set([5, 6, 7, 8])),
			paradisMissingSetsOverlap(new Set(), new Set()),
		], [true, false, false]);
	});

	test('cools down after a repair and gives up when the repair does not help', () => {
		let clock = 0;
		const gate = new ParadisRenderDesyncGate(() => clock);
		const seen: boolean[] = [gate.canInspect()];
		gate.noteRepaired();
		gate.noteAfterRepair(false);
		seen.push(gate.canInspect());
		clock += PARADIS_RENDER_REPAIR_COOLDOWN;
		seen.push(gate.canInspect());
		gate.noteRepaired();
		gate.noteAfterRepair(true);
		clock += PARADIS_RENDER_REPAIR_COOLDOWN;
		seen.push(gate.canInspect());
		assert.deepStrictEqual(seen, [true, false, true, false]);
	});

	test('keeps the newest records only', () => {
		const names = [
			paradisRenderRecordName(Date.UTC(2026, 8, 3), 'c'),
			paradisRenderRecordName(Date.UTC(2026, 8, 1), 'a'),
			paradisRenderRecordName(Date.UTC(2026, 8, 4), 'd'),
			paradisRenderRecordName(Date.UTC(2026, 8, 2), 'b'),
		];
		assert.deepStrictEqual(paradisRenderRecordsToPrune(names, 3), [paradisRenderRecordName(Date.UTC(2026, 8, 1), 'a')]);
		assert.strictEqual(paradisRenderRecordName(Date.UTC(2026, 8, 1, 2, 3, 4), 'x-y!z'), '20260901T020304Z-xyz');
	});
});
