/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsInSearchDir, paradisSanitizeSearchDir } from '../../common/paradisRemoteSearch.js';

suite('ParadisRemoteSearch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a search folder must be a plain relative path inside the workspace', () => {
		const inputs: unknown[] = ['src', 'src/app/', 'a//b', '', '/', '/etc', '..', 'src/../..', './src', 'C:/x', 'C:\\x', 'src\\app', 'file:///x', 'a\0b', 42, undefined, 'x'.repeat(1025)];
		assert.deepStrictEqual(inputs.map(paradisSanitizeSearchDir), ['src', 'src/app', 'a/b', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('only paths below the folder count as inside it', () => {
		assert.deepStrictEqual(['src/a.ts', 'src', 'srcx/a.ts', 'lib/src/a.ts'].map(path => paradisIsInSearchDir(path, 'src')), [true, false, false, false]);
	});
});
