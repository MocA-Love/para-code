/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { paradisIsCodexTerminalTitle } from '../../common/paradisCodexTitle.js';

suite('paradisIsCodexTerminalTitle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only the title Para Code asks Codex to set', () => {
		const titles = [
			'codex',
			'Codex',
			'codex | 019a5c3e-1f2b-7c3d-8e4f-0123456789ab',
			'codex | Fix the login bug',
			'  codex|x',
			'user@host: ~/work/codex',
			'codex.md',
			'vim codex.md',
			'codex-tools',
			'Review codex notes',
			'codex review',
			'opencode | codex',
			'',
		];
		assert.deepStrictEqual(Object.fromEntries(titles.map(title => [title, paradisIsCodexTerminalTitle(title)])), {
			'codex': true,
			'Codex': true,
			'codex | 019a5c3e-1f2b-7c3d-8e4f-0123456789ab': true,
			'codex | Fix the login bug': true,
			'  codex|x': true,
			'user@host: ~/work/codex': false,
			'codex.md': false,
			'vim codex.md': false,
			'codex-tools': false,
			'Review codex notes': false,
			'codex review': false,
			'opencode | codex': false,
			'': false,
		});
	});
});
