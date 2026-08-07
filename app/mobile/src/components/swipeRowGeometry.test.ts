// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { cardEdgeIndex, swipeGeometry } from './swipeRowGeometry.js';

describe('swipeGeometry', () => {
	// 「開く < 引き切る < 上限」が崩れると、開いた瞬間に実行扱いになったり、
	// 引き切りに永久に到達しなくなる。枚数が増えても崩れないことを固定する。
	test('keeps open < fullSwipe < limit for every card count in use', () => {
		expect([0, 1, 2, 3, 4].map(swipeGeometry)).toEqual([
			{ openDistance: 0, fullSwipeAt: 43, limit: 79, cardStep: 0 },
			{ openDistance: 80, fullSwipeAt: 123, limit: 159, cardStep: 80 },
			{ openDistance: 160, fullSwipeAt: 203, limit: 239, cardStep: 80 },
			{ openDistance: 240, fullSwipeAt: 283, limit: 319, cardStep: 80 },
			{ openDistance: 320, fullSwipeAt: 363, limit: 399, cardStep: 80 },
		]);
	});

	// 端からの並び順。'left'（右側から出る）はDOM上最後のカードが最初に生え、
	// 'right'は先頭が最初に生える。反転を間違えても目視では気付けないのでここで固定する。
	test('cardEdgeIndex counts from the exposed edge', () => {
		expect([0, 1, 2].map(i => cardEdgeIndex('left', i, 3))).toEqual([2, 1, 0]);
		expect([0, 1, 2].map(i => cardEdgeIndex('right', i, 3))).toEqual([0, 1, 2]);
	});
});
