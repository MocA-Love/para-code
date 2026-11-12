/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisTaskBoardWindowBackground } from '../../common/paradisTaskBoardHost.js';

suite('paradisTaskBoardWindowBackground', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the board background it reported or remembered, and falls back to the dark one', () => {
		assert.deepStrictEqual(
			['#0a0c10', '#f3f5f8', '#F3F5F8', '#ff0000', 'red', undefined, 42].map(paradisTaskBoardWindowBackground),
			['#0a0c10', '#f3f5f8', '#f3f5f8', '#0a0c10', '#0a0c10', '#0a0c10', '#0a0c10'],
		);
	});
});
