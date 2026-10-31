/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisToggleChecked, paradisToggleValue } from '../../common/paradisSettingsToggle.js';

suite('ParadisSettingsToggle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an inverted row (chat.disableAIFeatures) shows "use upstream AI" and writes the opposite value', () => {
		assert.deepStrictEqual({
			// 本家の既定（false）と未設定はオン、true だけオフ
			checked: { upstreamDefault: paradisToggleChecked(false, true), unset: paradisToggleChecked(undefined, true), disabled: paradisToggleChecked(true, true) },
			// 外すと true（止める）、付けると false（使う）を明示して書く
			written: { uncheck: paradisToggleValue(false, true), check: paradisToggleValue(true, true) },
		}, {
			checked: { upstreamDefault: true, unset: true, disabled: false },
			written: { uncheck: true, check: false },
		});
	});

	test('a normal row is unchanged', () => {
		assert.deepStrictEqual({
			checked: [paradisToggleChecked(true, false), paradisToggleChecked(false, false), paradisToggleChecked(undefined, false)],
			written: [paradisToggleValue(true, false), paradisToggleValue(false, false)],
		}, {
			checked: [true, false, false],
			written: [true, false],
		});
	});
});
