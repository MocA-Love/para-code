/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCodexAccountsState, paradisCodexLaunchHomeFor, paradisLooksLikeRunningCodex, paradisSelectedCodexHome } from '../../common/paradisCodexAccounts.js';

suite('Paradis Codex accounts (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const homes: IParadisCodexAccountsState['homes'] = [
		{ homePath: '/u/.codex', label: '~/.codex', isDefault: true, signedIn: true },
		{ homePath: '/u/.codex-2', label: '~/.codex-2', isDefault: false, signedIn: true },
	];

	test('only passes CODEX_HOME for a selected, still existing, non-default home', () => {
		assert.deepStrictEqual([
			paradisCodexLaunchHomeFor({ homes, selection: { revision: 0 } }),
			paradisCodexLaunchHomeFor({ homes, selection: { homePath: '/u/.codex-2', revision: 1 } }),
			// 選んだアカウントが消された → 既定へ戻る
			paradisCodexLaunchHomeFor({ homes, selection: { homePath: '/u/.codex-9', revision: 2 } }),
			paradisSelectedCodexHome({ homes, selection: { homePath: '/u/.codex-9', revision: 2 } })?.homePath,
		], [undefined, '/u/.codex-2', undefined, '/u/.codex']);
	});

	test('recognizes a running Codex from the command line or the process name', () => {
		assert.deepStrictEqual([
			paradisLooksLikeRunningCodex('codex resume --last', 'zsh'),
			paradisLooksLikeRunningCodex('/opt/homebrew/bin/codex', undefined),
			paradisLooksLikeRunningCodex('npx codex-helper', 'node'),
			paradisLooksLikeRunningCodex('git status', 'codex'),
			paradisLooksLikeRunningCodex(undefined, 'codex'),
			paradisLooksLikeRunningCodex(undefined, 'zsh'),
		], [true, true, false, false, true, false]);
	});
});
