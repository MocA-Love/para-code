/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisClaudeProjectSlug } from '../../common/paradisClaudeProjectSlug.js';

suite('paradisClaudeProjectSlug', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches the folder names Claude Code 2.1.309 creates', () => {
		// 期待値は Claude Code 2.1.309 のバイナリから写した処理で作った
		const exact = `/${'a'.repeat(199)}`;
		assert.deepStrictEqual({
			short: paradisClaudeProjectSlug('/Users/example/projects/repo.git'),
			exact: paradisClaudeProjectSlug(exact),
			over: paradisClaudeProjectSlug(`${exact}b`),
			// allow-any-unicode-next-line
			long: paradisClaudeProjectSlug(`/home/user/${'very-long-directory-name/'.repeat(9)}プロジェクト`),
		}, {
			short: '-Users-example-projects-repo-git',
			exact: `-${'a'.repeat(199)}`,
			over: `-${'a'.repeat(199)}-b6ymvk`,
			long: '-home-user-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-directory-name-very-long-dire-ca48xn',
		});
	});
});
