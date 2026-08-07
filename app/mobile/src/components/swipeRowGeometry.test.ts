// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { swipeGeometry } from './swipeRowGeometry.js';

describe('swipeGeometry', () => {
	// 「開く < 引き切る < 上限」が崩れると、開いた瞬間に実行扱いになったり、
	// 引き切りに永久に到達しなくなる。枚数が増えても崩れないことを固定する。
	test('keeps open < fullSwipe < limit for every card count in use', () => {
		expect([0, 1, 2, 3, 4].map(swipeGeometry)).toEqual([
			{ openDistance: 0, fullSwipeAt: 43, limit: 79 },
			{ openDistance: 80, fullSwipeAt: 123, limit: 159 },
			{ openDistance: 160, fullSwipeAt: 203, limit: 239 },
			{ openDistance: 240, fullSwipeAt: 283, limit: 319 },
			{ openDistance: 320, fullSwipeAt: 363, limit: 399 },
		]);
	});
});
