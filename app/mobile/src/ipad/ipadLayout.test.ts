// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { listColumnsFor, sidebarWidthFor } from './ipadLayout.js';

describe('sidebarWidthFor', () => {
	test('狭いiPadでは下限、広いiPadでは上限で止まる', () => {
		// iPad mini portrait(744) / iPad Pro 11 portrait(834) / 13インチ landscape(1366)
		expect([744, 834, 1366].map(sidebarWidthFor)).toEqual([280, 280, 340]);
	});

	test('本文側に必ず400pt以上残る', () => {
		for (const width of [744, 820, 834, 1024, 1133, 1194, 1366]) {
			expect(width - sidebarWidthFor(width)).toBeGreaterThanOrEqual(400);
		}
	});
});

describe('listColumnsFor', () => {
	test('本文が十分広いときだけ2列にする', () => {
		expect([400, 500, 839, 840, 1026].map(listColumnsFor)).toEqual([1, 1, 1, 2, 2]);
	});

	test('iPad Pro 11のportraitではサイドバーを引くと1列に収まる', () => {
		expect(listColumnsFor(834 - sidebarWidthFor(834))).toBe(1);
	});

	test('13インチのlandscapeでは2列になる', () => {
		expect(listColumnsFor(1366 - sidebarWidthFor(1366))).toBe(2);
	});
});
