/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Color, RGBA } from '../../../../../base/common/color.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisTransparentActive, paradisXtermBackground } from '../../browser/paradisTerminalTransparency.js';
import { clampParadisTransparencyOpacity } from '../../common/paradisTransparency.js';

suite('ParadisWindowTransparency', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('defaults invalid opacity and clamps finite and infinite values to the readable range', () => {
		assert.deepStrictEqual([
			clampParadisTransparencyOpacity(undefined),
			clampParadisTransparencyOpacity(Number.NaN),
			clampParadisTransparencyOpacity(Number.NEGATIVE_INFINITY),
			clampParadisTransparencyOpacity(0.2),
			clampParadisTransparencyOpacity(0.65),
			clampParadisTransparencyOpacity(1.2),
			clampParadisTransparencyOpacity(Number.POSITIVE_INFINITY),
		], [
			0.8,
			0.8,
			0.3,
			0.3,
			0.65,
			1,
			1,
		]);
	});

	test('preserves RGB while making the xterm background transparent only for an active transparent workbench', () => {
		const selector = '.monaco-workbench.paradis-transparent';
		const previouslyActive = Array.from(mainWindow.document.querySelectorAll<HTMLElement>(selector));
		for (const element of previouslyActive) {
			element.classList.remove('paradis-transparent');
		}
		const fixture = mainWindow.document.createElement('div');
		fixture.classList.add('monaco-workbench');
		mainWindow.document.body.appendChild(fixture);
		const background = new Color(new RGBA(12, 34, 56, 0.75));

		try {
			assert.strictEqual(isParadisTransparentActive(), false);
			assert.strictEqual(paradisXtermBackground(undefined), undefined);
			assert.strictEqual(paradisXtermBackground(background), 'rgba(12, 34, 56, 0.75)');

			fixture.classList.add('paradis-transparent');

			assert.strictEqual(isParadisTransparentActive(), true);
			assert.strictEqual(paradisXtermBackground(background), 'rgba(12, 34, 56, 0)');
		} finally {
			fixture.remove();
			for (const element of previouslyActive) {
				element.classList.add('paradis-transparent');
			}
		}
	});
});
