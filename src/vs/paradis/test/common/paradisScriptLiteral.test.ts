/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisScriptStringLiteral } from '../../common/paradisScriptLiteral.js';

suite('paradisScriptLiteral', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads back as the same string and cannot close a script element', () => {
		const values = ['plain', '/done', '</script><script>alert(1)</script>', '<!-- x -->', 'a\u2028b\u2029c', '"quoted" \\ back\nline', 'div > input[name="q"]'];
		const literals = values.map(paradisScriptStringLiteral);
		assert.deepStrictEqual({
			readBack: literals.map(literal => new Function(`return ${literal};`)()),
			unsafe: literals.filter(literal => /[<>\u2028\u2029]/.test(literal)),
			plain: literals.slice(0, 2),
		}, {
			readBack: values,
			unsafe: [],
			plain: ['"plain"', '"/done"'],
		});
	});
});
