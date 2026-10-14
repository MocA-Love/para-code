/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { editorBackground, editorHoverBackground, editorWidgetBackground } from '../../../../../platform/theme/common/colors/editorColors.js';
import { menuBackground } from '../../../../../platform/theme/common/colors/menuColors.js';
import { quickInputBackground } from '../../../../../platform/theme/common/colors/quickpickColors.js';
import { TestColorTheme } from '../../../../../platform/theme/test/common/testThemeService.js';
import { NOTIFICATIONS_BACKGROUND } from '../../../../../workbench/common/theme.js';
import { clampParadisGlassOpacity, computeParadisGlassTint, computeParadisGlassTintValues } from '../../common/paradisFrostedGlassTint.js';

suite('ParadisFrostedGlassTint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the tint composites back to the surface colour over the backdrop, and clamps what cannot be reached', () => {
		const surface = { r: 100, g: 100, b: 100 };
		const backdrop = { r: 20, g: 40, b: 60 };
		assert.deepStrictEqual({
			opaque: computeParadisGlassTint(surface, backdrop, 100),
			half: computeParadisGlassTint(surface, backdrop, 50),
			unreachable: computeParadisGlassTint({ r: 10, g: 250, b: 128 }, { r: 200, g: 0, b: 128 }, 50),
		}, {
			opaque: { r: 100, g: 100, b: 100 },
			half: { r: 180, g: 160, b: 140 },
			unreachable: { r: 0, g: 255, b: 128 },
		});
	});

	test('clamps the frosted glass opacity setting like upstream', () => {
		assert.deepStrictEqual(
			[undefined, Number.NaN, 30, 50, 75, 100, 120].map(clampParadisGlassOpacity),
			[80, 80, 50, 50, 75, 100, 100],
		);
	});

	test('computes one tint per glass surface from the theme, flattening translucent colours over the editor background and dimming the dialog backdrop', () => {
		const theme = new TestColorTheme({
			[editorBackground]: '#141414',
			[NOTIFICATIONS_BACKGROUND]: '#303030',
			[quickInputBackground]: '#ffffff00',
			[menuBackground]: '#3c3c3c',
			[editorHoverBackground]: '#282828',
			[editorWidgetBackground]: '#2a2a2a',
		});
		assert.deepStrictEqual(computeParadisGlassTintValues(theme, 80), [
			['--paradis-glass-notifications-background', 'rgb(55 55 55 / 80%)'],
			['--paradis-glass-quick-input-background', 'rgb(20 20 20 / 80%)'],
			['--paradis-glass-menu-background', 'rgb(70 70 70 / 80%)'],
			['--paradis-glass-hover-background', 'rgb(45 45 45 / 80%)'],
			// The dialog sits over the screen dimmed by 50% black, so its backdrop is half the editor colour.
			['--paradis-glass-dialog-background', 'rgb(50 50 50 / 80%)'],
		]);
	});

	test('sets nothing when the theme has no editor background', () => {
		assert.deepStrictEqual(computeParadisGlassTintValues(new TestColorTheme({ [NOTIFICATIONS_BACKGROUND]: '#323232' }), 80), []);
	});
});
