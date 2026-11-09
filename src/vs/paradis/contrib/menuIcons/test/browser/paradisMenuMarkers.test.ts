/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MENU_ITEM_DANGER_CLASS, PARADIS_MENU_ITEM_ICON_CLASS } from '../../../../browser/paradisMenu.js';
import { PARADIS_MENU_DANGER_CLASS, PARADIS_MENU_ICON_CLASS } from '../../browser/paradisMenuIcons.js';

suite('Paradis menu markers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the UI kit menu (vs/paradis/browser/paradisMenu.ts) uses the markers that the menu.ts PARA-PATCH and paradisMenuIcons.css read', () => {
		assert.deepStrictEqual([PARADIS_MENU_ITEM_ICON_CLASS, PARADIS_MENU_ITEM_DANGER_CLASS], [PARADIS_MENU_ICON_CLASS, PARADIS_MENU_DANGER_CLASS]);
	});
});
