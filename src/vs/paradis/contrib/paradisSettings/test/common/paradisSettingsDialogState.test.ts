/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsSettingsDialogOpen, paradisMarkSettingsDialogOpen } from '../../common/paradisSettingsDialogState.js';

suite('ParadisSettingsDialogState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('開いている間だけ true になり、同じ記録を2回閉じても数がずれない', () => {
		const before = paradisIsSettingsDialogOpen();
		const first = paradisMarkSettingsDialogOpen();
		const second = paradisMarkSettingsDialogOpen();
		first.dispose();
		const oneLeft = paradisIsSettingsDialogOpen();
		first.dispose();
		const stillOneLeft = paradisIsSettingsDialogOpen();
		second.dispose();

		assert.deepStrictEqual({ before, oneLeft, stillOneLeft, after: paradisIsSettingsDialogOpen() }, {
			before: false,
			oneLeft: true,
			stillOneLeft: true,
			after: false,
		});
	});
});
