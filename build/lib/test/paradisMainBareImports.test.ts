/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as path from 'path';
import { suite, test } from 'node:test';
import { findParadisForbiddenBareImports } from '../paradisMainBareImports.ts';

suite('Para Code main bundle imports', () => {
	test('main, mainImpl, cli and bootstrap-fork statically import no npm package (they would stop the app before it starts)', { timeout: 300_000 }, async () => {
		assert.deepStrictEqual(await findParadisForbiddenBareImports(path.join(import.meta.dirname, '..', '..', '..')), {});
	});
});
