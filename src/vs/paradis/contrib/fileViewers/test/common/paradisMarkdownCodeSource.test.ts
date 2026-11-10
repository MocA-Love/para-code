/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisRecoverMarkdownCodeSources } from '../../common/paradisMarkdownCodeSource.js';

suite('ParadisMarkdownCodeSource', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('leading tabs that marked expanded are restored, nested in lists and quotes too', () => {
		const markdown = [
			'```make',
			'all:',
			'\tgo build',
			'```',
			'',
			'- item',
			'  ```go',
			'  func f() {',
			'  \treturn',
			'  }',
			'  ```',
			'',
			'> ```',
			'> \tquoted',
			'> ```',
		].join('\r\n');
		const sources = paradisRecoverMarkdownCodeSources(markdown, [
			{ text: 'all:\n    go build', fenced: true },
			{ text: 'func f() {\n    return\n}', fenced: true },
			{ text: '    quoted', fenced: true },
		]);
		assert.deepStrictEqual([...sources], [
			['all:\n    go build', 'all:\n\tgo build'],
			['func f() {\n    return\n}', 'func f() {\n\treturn\n}'],
			['    quoted', '\tquoted'],
		]);
	});

	test('blocks that look the same but were written differently, indented blocks and documents without tabs keep the shown text', () => {
		const ambiguous = paradisRecoverMarkdownCodeSources(['```', '    x', '```', '```', '\tx', '```'].join('\n'), [
			{ text: '    x', fenced: true },
			{ text: '    x', fenced: true },
		]);
		const indented = paradisRecoverMarkdownCodeSources(['para', '', '\tcode', ''].join('\n'), [{ text: 'code', fenced: false }]);
		const noTabs = paradisRecoverMarkdownCodeSources(['```', '    x', '```'].join('\n'), [{ text: '    x', fenced: true }]);
		assert.deepStrictEqual([ambiguous.size, indented.size, noTabs.size], [0, 0, 0]);
	});
});
