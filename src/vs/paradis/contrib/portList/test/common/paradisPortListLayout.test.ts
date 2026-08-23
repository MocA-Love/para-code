/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPortListPanelGeometry } from '../../common/paradisPortListLayout.js';

suite('Paradis port list layout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the panel within eight-pixel viewport margins', () => {
		assert.deepStrictEqual(paradisPortListPanelGeometry(320, 300), { width: 304, left: 8 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(375, 360), { width: 359, left: 8 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(390, 370), { width: 374, left: 8 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(440, 420), { width: 424, left: 8 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(800, 760), { width: 440, left: 320 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(800, -10), { width: 440, left: 8 });
		assert.deepStrictEqual(paradisPortListPanelGeometry(800, 900), { width: 440, left: 352 });
		for (const viewportWidth of [440, 390, 375, 320]) {
			const geometry = paradisPortListPanelGeometry(viewportWidth, viewportWidth - 20);
			assert.ok(geometry.left >= 8);
			assert.ok(geometry.left + geometry.width <= viewportWidth - 8);
		}
	});
});
