// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { REGULAR_WIDTH_THRESHOLD, sizeClassFor } from './sizeClass.js';

/**
 * レイアウト分岐の条件を実機なしで固定するテスト。
 * 「iPadの全画面はサイドバーが出る」「Split Viewで狭くなればiPhoneと同じ1カラムに戻る」
 * 「iPhoneでは横に広くてもサイドバーを出さない」の3点が本質。
 */
describe('sizeClassFor', () => {
	test('iPhoneはどの幅でもcompact（横向き解禁時の誤爆を防ぐ）', () => {
		expect([320, 393, 430, 932].map(width => sizeClassFor(width, false))).toEqual(['compact', 'compact', 'compact', 'compact']);
	});

	test('iPadの全画面はportrait/landscapeともregular', () => {
		// iPad mini 6 / iPad Pro 11 / iPad Pro 13 のportrait短辺とlandscape長辺
		expect([744, 834, 1024, 1133, 1194, 1366].map(width => sizeClassFor(width, true))).toEqual(
			['regular', 'regular', 'regular', 'regular', 'regular', 'regular'],
		);
	});

	test('iPadでもSplit View 1/2やSlide Overの幅ではcompactへ落ちる', () => {
		// Slide Over(320) / 11インチSplit View 1/2(507) / しきい値直下
		expect([320, 507, REGULAR_WIDTH_THRESHOLD - 1].map(width => sizeClassFor(width, true))).toEqual(['compact', 'compact', 'compact']);
	});

	test('しきい値ちょうどはregular', () => {
		expect(sizeClassFor(REGULAR_WIDTH_THRESHOLD, true)).toBe('regular');
	});
});
