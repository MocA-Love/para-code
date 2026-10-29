/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as path from 'path';
import { suite, test } from 'node:test';
import { findParadisForbiddenMainImports } from '../paradisMainBareImports.ts';

suite('Para Code main bundle imports', () => {
	test('the packaged main statically imports no npm package (they would stop the app before it starts)', { timeout: 120_000 }, async () => {
		assert.deepStrictEqual(await findParadisForbiddenMainImports(path.join(import.meta.dirname, '..', '..', '..')), []);
	});
});
