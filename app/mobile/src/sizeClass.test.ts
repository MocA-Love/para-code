// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { REGULAR_RELEASE_THRESHOLD, REGULAR_WIDTH_THRESHOLD, sizeClassForWithHysteresis } from './sizeClass.js';

describe('sizeClassForWithHysteresis', () => {
	test('compact中に閾値を超えたらregularへ昇格する（iPhoneでは常にcompact）', () => {
		expect(sizeClassForWithHysteresis('compact', REGULAR_WIDTH_THRESHOLD, true)).toBe('regular');
		expect(sizeClassForWithHysteresis(undefined, REGULAR_WIDTH_THRESHOLD, true)).toBe('regular');
		expect(sizeClassForWithHysteresis('regular', 900, false)).toBe('compact');
	});

	test('regular維持中は解除閾値未満まで落ちない（Split View分割線ドラッグでの往復跨ぎ対策）', () => {
		// 700→680への往復は型交換を起こさない。
		expect(sizeClassForWithHysteresis('regular', REGULAR_WIDTH_THRESHOLD - 20, true)).toBe('regular');
		// 解除閾値(660)ちょうどはまだregular。
		expect(sizeClassForWithHysteresis('regular', REGULAR_RELEASE_THRESHOLD, true)).toBe('regular');
		// 660を切ったときだけcompactへ降格する。
		expect(sizeClassForWithHysteresis('regular', REGULAR_RELEASE_THRESHOLD - 1, true)).toBe('compact');
	});

	test('compactからは解除閾値以上でも昇格しない（閾値700が必要）', () => {
		expect(sizeClassForWithHysteresis('compact', REGULAR_RELEASE_THRESHOLD, true)).toBe('compact');
		expect(sizeClassForWithHysteresis('compact', 690, true)).toBe('compact');
	});
});
