/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { suite, test } from 'node:test';
import { shouldGenerateParadisNodeCompileCache } from '../paradisNodeCompileCache.ts';

suite('paradisNodeCompileCache', () => {
	test('generation stays off unless explicitly enabled', () => {
		assert.deepStrictEqual([
			shouldGenerateParadisNodeCompileCache({}),
			shouldGenerateParadisNodeCompileCache({ PARA_GENERATE_NODE_COMPILE_CACHE: '0' }),
			shouldGenerateParadisNodeCompileCache({ PARA_GENERATE_NODE_COMPILE_CACHE: '1' }),
		], [false, false, true]);
	});
});
