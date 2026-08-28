/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { planParadisWordOverlayPlacements } from '../../common/word/paradisWordOverlayPlacement.js';

suite('ParadisWordOverlayPlacement', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches a drawing to its own frame regardless of order', () => {
		// 枠の並びが図形の並びと違っても、目印が一致した相手に入る。
		deepStrictEqual(
			planParadisWordOverlayPlacements(
				[{ id: 'a', drawingId: '10' }, { id: 'b', drawingId: '20' }],
				[{ drawingId: '20' }, { drawingId: '10' }],
			),
			{
				placements: [{ candidateIndex: 1, slotIndex: 0 }, { candidateIndex: 0, slotIndex: 1 }],
				unmatchedCandidates: 0,
			},
		);
	});

	test('skips drawings whose frame never appeared', () => {
		// docx-preview が Fallback(VML)を描いた図形には枠が作られない。描かずに数える。
		deepStrictEqual(
			planParadisWordOverlayPlacements(
				[{ id: 'a', drawingId: '10' }, { id: 'b', drawingId: '20' }],
				[{ drawingId: '10' }],
			),
			{ placements: [{ candidateIndex: 0, slotIndex: 0 }], unmatchedCandidates: 1 },
		);
	});

	test('fills every copy of a repeated frame', () => {
		// ヘッダーの図はページごとに複製されるので、同じ図を全部の枠へ描く。
		deepStrictEqual(
			planParadisWordOverlayPlacements(
				[{ id: 'a', drawingId: '10' }],
				[{ drawingId: '10' }, { drawingId: '10' }, { drawingId: '10' }],
			),
			{
				placements: [
					{ candidateIndex: 0, slotIndex: 0 },
					{ candidateIndex: 0, slotIndex: 1 },
					{ candidateIndex: 0, slotIndex: 2 },
				],
				unmatchedCandidates: 0,
			},
		);
	});

	test('drops an id shared by more than one drawing instead of guessing', () => {
		deepStrictEqual(
			planParadisWordOverlayPlacements(
				[{ id: 'a', drawingId: '10' }, { id: 'b', drawingId: '10' }, { id: 'c', drawingId: '20' }],
				[{ drawingId: '10' }, { drawingId: '20' }],
			),
			{ placements: [{ candidateIndex: 2, slotIndex: 1 }], unmatchedCandidates: 2 },
		);
	});

	test('ignores drawings and frames without a marker', () => {
		deepStrictEqual(
			planParadisWordOverlayPlacements(
				[{ id: 'a' }, { id: 'b', drawingId: '' }],
				[{ drawingId: '10' }, {}, { drawingId: '' }],
			),
			{ placements: [], unmatchedCandidates: 2 },
		);
	});

	test('returns nothing for empty input', () => {
		deepStrictEqual(planParadisWordOverlayPlacements([], []), { placements: [], unmatchedCandidates: 0 });
		deepStrictEqual(planParadisWordOverlayPlacements([{ id: 'a', drawingId: '1' }], []), { placements: [], unmatchedCandidates: 1 });
	});
});
