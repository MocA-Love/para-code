/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentChatTimeLabel } from '../../common/paradisAgentChatTime.js';

suite('paradisAgentChatTimeLabel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows the time for today, the day for earlier days and the year for earlier years', () => {
		const now = new Date(2026, 10, 27, 15, 0).getTime();
		assert.deepStrictEqual([
			paradisAgentChatTimeLabel(new Date(2026, 10, 27, 9, 5).getTime(), now),
			paradisAgentChatTimeLabel(new Date(2026, 10, 26, 23, 21).getTime(), now),
			paradisAgentChatTimeLabel(new Date(2025, 11, 31, 0, 0).getTime(), now),
		], ['9:05', '11/26 23:21', '2025/12/31 0:00']);
	});
});
