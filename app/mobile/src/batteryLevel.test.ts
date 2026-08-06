// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { batteryLevelClass } from './batteryLevel.js';

/**
 * 実機のバッテリーを減らさずに境目を固定するテスト。
 * 「充電中は緑になる境目が高い」「10%以下は充電していても赤」の2点が本質。
 */
describe('batteryLevelClass', () => {
	test('充電していないときは20%超で緑、11〜20%で黄、10%以下で赤', () => {
		expect([100, 21, 20, 11, 10, 1].map(level => batteryLevelClass(level, false)))
			.toEqual(['ok', 'ok', 'warn', 'warn', 'low', 'low']);
	});

	test('充電中は80%超まで緑にならない（戻りきっていない間は黄のまま）', () => {
		expect([100, 81, 80, 45, 11, 10, 1].map(level => batteryLevelClass(level, true)))
			.toEqual(['ok', 'ok', 'warn', 'warn', 'warn', 'low', 'low']);
	});

	test('10%以下は充電していても赤のまま（危険域を隠さない）', () => {
		expect(batteryLevelClass(8, true)).toBe('low');
		expect(batteryLevelClass(8, false)).toBe('low');
	});
});
