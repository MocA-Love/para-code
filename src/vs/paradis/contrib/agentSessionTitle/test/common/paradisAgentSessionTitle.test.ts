/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisHumanizeAgentSessionTitle } from '../../common/paradisAgentSessionTitle.js';

suite('paradisAgentSessionTitle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows the pasted text instead of the raw pasted_content tags', () => {
		assert.deepStrictEqual({
			pasted: paradisHumanizeAgentSessionTitle('\n\n<pasted_content id="512f">\nビルドが落ちる\nログ\n</pasted_content id="512f">\n'),
			surrounded: paradisHumanizeAgentSessionTitle('これを見て\n\n<pasted_content id="a1">\nlog\n</pasted_content id="a1">\nどう思う?'),
		}, {
			pasted: 'ビルドが落ちる ログ',
			surrounded: 'これを見て log どう思う?',
		});
	});
});
