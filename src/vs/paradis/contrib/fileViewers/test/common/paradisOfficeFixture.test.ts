/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildOpcFixture } from './paradisOfficeFixture.js';

suite('ParadisOfficeFixture', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds a deterministic OPC package independent of input ordering', async () => {
		const a = await buildOpcFixture({ parts: [['/a.xml', '<a/>'], ['/b.bin', new Uint8Array([1])]] });
		const b = await buildOpcFixture({ parts: [['/b.bin', new Uint8Array([1])], ['/a.xml', '<a/>']] });

		deepStrictEqual(a, b);
	});
});
