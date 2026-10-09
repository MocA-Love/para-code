/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_PRESET_SHAPES } from '../../common/spreadsheet/paradisPresetShapeData.js';
import { evaluateParadisGuideFormula, isParadisPresetShape, paradisPresetShapeAdjustDefaults, paradisPresetShapeCount, paradisShapeGeometry } from '../../common/spreadsheet/paradisPresetShapeGeometry.js';

suite('ParadisPresetShapeGeometry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('covers all 187 preset shape types and computes every one of them', () => {
		const names = [...Object.keys(PARADIS_PRESET_SHAPES), 'upArrow'];
		const failed = names.filter(name => {
			const geometry = paradisShapeGeometry(name, { x: 0, y: 0, width: 70, height: 60 });
			return !geometry || geometry.paths.length === 0 || geometry.paths.some(path => !path.d || /NaN|Infinity/.test(path.d));
		});
		deepStrictEqual({ count: paradisPresetShapeCount(), failed, upArrow: isParadisPresetShape('upArrow'), unknown: isParadisPresetShape('notAShape') }, { count: 187, failed: [], upArrow: true, unknown: false });
	});

	test('evaluates the 17 guide formulas (Part 1 §20.1.10.25)', () => {
		const guides = new Map([['a', 3], ['b', 4], ['c', 12]]);
		deepStrictEqual([
			'val 7', '*/ a b c', '+- a b c', '+/ a b c', '?: a b c', '?: -1 b c', 'abs -5', 'max a b', 'min a b', 'mod a b c', 'pin a 10 c', 'pin a 1 c', 'sqrt 16',
		].map(formula => evaluateParadisGuideFormula(formula, guides)), [7, 1, -5, 7 / 12, 4, 12, 5, 4, 3, 13, 10, 3, 4]);
		const angle = (formula: string) => Math.round(evaluateParadisGuideFormula(formula, guides) * 1000) / 1000;
		deepStrictEqual([angle('at2 1 1'), angle('cos 10 5400000'), angle('sin 10 5400000'), angle('tan 10 2700000'), angle('cat2 10 1 0'), angle('sat2 10 0 1')], [2700000, 0, 10, 10, 10, 10]);
	});

	test('uses the adjust values, draws arcs from the current point, and flips the missing upArrow from downArrow', () => {
		const box = { x: 0, y: 0, width: 100, height: 40 };
		const round = (adjust?: Record<string, number>) => paradisShapeGeometry('roundRect', box, adjust)!.paths[0].d.split(' ').slice(0, 3).join(' ');
		const custom = paradisShapeGeometry({ paths: [{ w: 10, h: 10, c: [['M', '0', '10'], ['A', '5', '5', '10800000', '10800000'], ['Z']] }] }, box)!;
		deepStrictEqual({
			defaultCorner: round(),
			sharperCorner: round({ adj: 0 }),
			arc: custom.paths[0].d,
			upArrow: paradisShapeGeometry('upArrow', box)!.paths[0].d,
		}, {
			defaultCorner: 'M 0 6.67',
			sharperCorner: 'M 0 0',
			arc: 'M 0 40 A 50 20 0 0 1 100 40 Z',
			upArrow: 'M 0 20 L 25 20 L 25 40 L 75 40 L 75 20 L 100 20 L 50 0 Z',
		});
	});

	test('lists the default adjust values by guide name, through aliases', () => {
		deepStrictEqual([paradisPresetShapeAdjustDefaults('roundRect'), paradisPresetShapeAdjustDefaults('upArrow'), paradisPresetShapeAdjustDefaults('rect'), paradisPresetShapeAdjustDefaults('toString')], [
			{ adj: 16667 },
			{ adj1: 50000, adj2: 50000 },
			{},
			{},
		]);
	});

	test('returns nothing for shapes it cannot compute', () => {
		deepStrictEqual([
			paradisShapeGeometry('notAShape', { x: 0, y: 0, width: 10, height: 10 }),
			paradisShapeGeometry({ gd: [['g', 'unknown 1 2']], paths: [{ c: [['M', 'g', '0']] }] }, { x: 0, y: 0, width: 10, height: 10 }),
		], [undefined, undefined]);
	});
});
