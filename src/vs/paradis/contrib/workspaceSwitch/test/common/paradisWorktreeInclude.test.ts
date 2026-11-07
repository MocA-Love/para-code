/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisNormalizeWorktreeIncludePath, paradisParseWorktreeIncludeConfig, paradisParseWorktreeIncludeFile, paradisUpdateWorktreeIncludeConfig } from '../../common/paradisWorktreeInclude.js';

suite('Paradis worktree include declarations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only literal paths inside the repository', () => {
		const inputs = ['./.env', 'config\\secrets.json', '.cache/models/', '/etc/passwd', 'C:/x', '../x', 'a/../b', 'a//b', '.git/config', '*.env', 'a?', '!x', '', '  ', 42];
		assert.deepStrictEqual(inputs.map(paradisNormalizeWorktreeIncludePath), ['.env', 'config/secrets.json', '.cache/models', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('reads the worktree section and drops unusable or duplicate paths', () => {
		assert.deepStrictEqual([
			paradisParseWorktreeIncludeConfig(`{
				// comments are fine
				"presets": [],
				"worktree": { "include": [".env", "./.env", "../x", 3], "sharedDirectories": ".cache" }
			}`),
			paradisParseWorktreeIncludeConfig('{ "worktree": [] }'),
		], [
			{ include: ['.env'], sharedDirectories: [] },
			{ include: [], sharedDirectories: [] },
		]);
	});

	test('reads .worktreeinclude lines, skipping comments and blanks', () => {
		assert.deepStrictEqual(paradisParseWorktreeIncludeFile('# secrets\n.env\r\n\n  .env.local  \n*.pem\n.env\n'), ['.env', '.env.local']);
	});

	test('updates only the declared lists and keeps other fields', () => {
		const before = '{ "presets": [{ "name": "dev" }], "setupScript": "npm ci", "worktree": { "future": true, "include": [".old"] } }';
		assert.deepStrictEqual([
			JSON.parse(paradisUpdateWorktreeIncludeConfig(before, { include: ['.env'], sharedDirectories: ['.cache/models'] })),
			JSON.parse(paradisUpdateWorktreeIncludeConfig('{ "worktree": { "include": [".env"] } }', { include: [], sharedDirectories: [] })),
			JSON.parse(paradisUpdateWorktreeIncludeConfig(undefined, { include: ['.env'], sharedDirectories: [] })),
		], [
			{ presets: [{ name: 'dev' }], setupScript: 'npm ci', worktree: { future: true, include: ['.env'], sharedDirectories: ['.cache/models'] } },
			{},
			{ worktree: { include: ['.env'] } },
		]);
	});
});
