/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisNormalizeRemoteFilePath, paradisPathHasVersionControlSegment, paradisReplaceRemoteFileExtension } from '../../common/paradisRemoteFileBridge.js';

suite('paradisRemoteFileBridge (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only absolute paths without "..", backslashes or control characters', () => {
		assert.deepStrictEqual([
			'/home/example/repo/shot.png',
			'/home/example/./repo//shot.png',
			'C:/Users/example/shot.png',
			'C:\\Users\\example\\shot.png',
			'/home/example/a\\b.png',
			'shot.png',
			'./shot.png',
			'~/shot.png',
			'/home/example/../other/shot.png',
			'/home/example/repo/',
			'/home/example/a\u0000b',
			'',
			42,
		].map(paradisNormalizeRemoteFilePath), [
			'/home/example/repo/shot.png',
			'/home/example/repo/shot.png',
			'/C:/Users/example/shot.png',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('finds .git, .hg and .svn segments with either separator and any case', () => {
		assert.deepStrictEqual([
			'/home/example/repo/.git/hooks/pre-commit',
			'/home/example/repo/.HG/store',
			'repo\\.svn\\entries',
			'/home/example/repo/.github/workflows/ci.yml',
			'/home/example/repo/my.git',
		].map(paradisPathHasVersionControlSegment), [true, true, true, false, false]);
	});

	test('replaces the extension like the vendored ensureExtension', () => {
		assert.deepStrictEqual([
			paradisReplaceRemoteFileExtension('/tmp/shot.jpg', '.png'),
			paradisReplaceRemoteFileExtension('/tmp/shot', '.png'),
			paradisReplaceRemoteFileExtension('/tmp/snapshot.txt', '.txt'),
		], ['/tmp/shot.png', '/tmp/shot.png', '/tmp/snapshot.txt']);
	});
});
