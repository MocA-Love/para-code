/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseWorkspaceLifecycleConfig, paradisUpdateWorkspaceLifecycleConfig } from '../../common/paradisWorkspaceLifecycle.js';

suite('Paradis workspace lifecycle configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads trimmed script strings and ignores wrong types', () => {
		assert.deepStrictEqual(paradisParseWorkspaceLifecycleConfig(`{
			// repository lifecycle
			"setupScript": " bun install ",
			"teardownScript": false
		}`), { setupScript: 'bun install' });
	});

	test('throws for malformed JSONC', () => {
		assert.throws(() => paradisParseWorkspaceLifecycleConfig('{ "setupScript": '));
	});

	test('updates scripts while preserving existing fields', () => {
		const updated = paradisUpdateWorkspaceLifecycleConfig(
			'{ "presets": [{ "name": "dev" }], "future": 7 }',
			{ setupScript: 'bun install', teardownScript: undefined }
		);
		assert.deepStrictEqual(JSON.parse(updated), {
			presets: [{ name: 'dev' }],
			future: 7,
			setupScript: 'bun install'
		});
	});
});
