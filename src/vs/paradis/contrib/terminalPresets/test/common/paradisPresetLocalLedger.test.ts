/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisFolderLabelMoves, paradisLocallyHiddenKeys, paradisSharedPresetNames } from '../../common/paradisPresetLocalLedger.js';

suite('paradisPresetLocalLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const repositoryFile = URI.file('/repos/app/.paracode.json');
	const worktreeFile = URI.file('/worktrees/app-feature/.paracode.json');

	test('the hidden key follows the repository and the name, not the worktree or the commands', () => {
		const inRepository = paradisLocallyHiddenKeys(repositoryFile, [repositoryFile], { name: ' SETUP ', commands: ['bun i'] }, false);
		const inWorktree = paradisLocallyHiddenKeys(repositoryFile, [worktreeFile], { name: 'SETUP', commands: ['make'], folder: 'tools' }, false);
		const shared = paradisLocallyHiddenKeys(repositoryFile, [repositoryFile], { name: 'SETUP', commands: ['bun i'] }, true);
		assert.deepStrictEqual({
			sameKey: inRepository.primary === inWorktree.primary,
			sharedNameAddsFingerprint: shared.primary !== inRepository.primary,
			// 親だけ: 旧形式 1。ワークツリーも: ワークツリーの新形式 1 ＋ 旧形式 2。
			aliasCount: [inRepository.aliases.length, inWorktree.aliases.length],
		}, { sameKey: true, sharedNameAddsFingerprint: true, aliasCount: [1, 3] });
	});

	test('shared names ignore surrounding whitespace', () => {
		assert.deepStrictEqual([...paradisSharedPresetNames([{ name: 'a' }, { name: 'b' }, { name: ' a ' }])], ['a']);
	});

	test('renaming a folder moves the label mark once per place the presets are stored', () => {
		const presets = [
			{ source: 'workspace' as const, sourceUri: repositoryFile },
			{ source: 'workspace' as const, sourceUri: repositoryFile },
			{ source: 'user' as const },
		];
		assert.deepStrictEqual(paradisFolderLabelMoves(presets, 'old', ' new '), [
			{ from: `workspace:${repositoryFile.toString()}::old`, to: `workspace:${repositoryFile.toString()}::new` },
			{ from: 'user::old', to: 'user::new' },
		]);
		assert.deepStrictEqual(paradisFolderLabelMoves(presets, 'same', ' same'), []);
	});
});
