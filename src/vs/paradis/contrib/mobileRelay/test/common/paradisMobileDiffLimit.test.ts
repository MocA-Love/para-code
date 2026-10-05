/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsRunGitOutputTruncated, paradisLimitMobileDiff } from '../../common/paradisMobileDiffLimit.js';

suite('ParadisMobileDiffLimit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('上限を超えた差分は行の境目で切り、元で切れていれば途中の最後の行を落とす', () => {
		assert.deepStrictEqual({
			small: paradisLimitMobileDiff('+a\n+b\n', false, 10),
			cut: paradisLimitMobileDiff('+aa\n+bb\n+cc\n', false, 9),
			source: paradisLimitMobileDiff('+aa\n+bb\n+c', true, 100),
			oneLine: paradisLimitMobileDiff('+😀😀', false, 4),
			overflow: [paradisIsRunGitOutputTruncated('warning\nParadisWorktreeGit: output exceeded the limit'), paradisIsRunGitOutputTruncated('fatal: bad')],
		}, {
			small: { diff: '+a\n+b\n', truncated: false },
			cut: { diff: '+aa\n+bb\n', truncated: true },
			source: { diff: '+aa\n+bb\n', truncated: true },
			oneLine: { diff: '+😀', truncated: true },
			overflow: [true, false],
		});
	});
});
