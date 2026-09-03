/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ok, strictEqual } from 'assert';
import { Color } from '../../../../../base/common/color.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO, paradisAdjustSpaceAccent } from '../../browser/paradisSpaceAccentColor.js';

suite('paradisSpaceAccentColor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DARK_TAB = Color.fromHex('#1f1f1f');
	const LIGHT_TAB = Color.fromHex('#ffffff');

	function contrastAgainst(background: Color, accent: Color): number {
		return background.getContrastRatio(accent);
	}

	test('keeps a space color that is already readable on every tab background', () => {
		// 既に見えている色を寄せると、ユーザーが選んだスペース色と見た目がずれてしまう。
		const accent = Color.fromHex('#3fb950');
		strictEqual(paradisAdjustSpaceAccent(accent, [DARK_TAB, DARK_TAB]).toString(), accent.toString());
	});

	test('brightens a color that sinks into a dark tab background', () => {
		// slate 系のように暗い背景へ沈む色。明度を上げて帯が見える状態まで持ち上げる。
		const accent = Color.fromHex('#2f3542');
		ok(contrastAgainst(DARK_TAB, accent) < PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO);

		const adjusted = paradisAdjustSpaceAccent(accent, [DARK_TAB]);
		ok(adjusted.getRelativeLuminance() > accent.getRelativeLuminance());
		ok(contrastAgainst(DARK_TAB, adjusted) >= PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO,
			`contrast ${contrastAgainst(DARK_TAB, adjusted)}`);
	});

	test('darkens a color that washes out on a light tab background', () => {
		const accent = Color.fromHex('#ffe066');
		ok(contrastAgainst(LIGHT_TAB, accent) < PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO);

		const adjusted = paradisAdjustSpaceAccent(accent, [LIGHT_TAB]);
		ok(adjusted.getRelativeLuminance() < accent.getRelativeLuminance());
		ok(contrastAgainst(LIGHT_TAB, adjusted) >= PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO,
			`contrast ${contrastAgainst(LIGHT_TAB, adjusted)}`);
	});

	test('adjusts against the worst background so the band survives on both tab kinds', () => {
		// アクティブタブ (暗い) では十分でも、選択中タブ (明るい) に対しては沈む色。
		// 片方だけを見て判定すると、もう片方のタブで帯が消える。
		const accent = Color.fromHex('#ffe066');
		ok(contrastAgainst(DARK_TAB, accent) >= PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO);
		ok(contrastAgainst(LIGHT_TAB, accent) < PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO);

		const adjusted = paradisAdjustSpaceAccent(accent, [DARK_TAB, LIGHT_TAB]);
		ok(contrastAgainst(LIGHT_TAB, adjusted) >= PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO,
			`contrast ${contrastAgainst(LIGHT_TAB, adjusted)}`);
		strictEqual(paradisAdjustSpaceAccent(accent, [LIGHT_TAB, DARK_TAB]).toString(), adjusted.toString());
	});

	test('returns the space color unchanged when there is no background to compare against', () => {
		const accent = Color.fromHex('#2f3542');
		strictEqual(paradisAdjustSpaceAccent(accent, []).toString(), accent.toString());
	});
});
