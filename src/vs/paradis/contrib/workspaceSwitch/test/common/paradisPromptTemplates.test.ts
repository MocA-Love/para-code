/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInsertPromptTemplate, paradisPromptTemplateName } from '../../common/paradisPromptTemplates.js';

suite('ParadisPromptTemplates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// allow-any-unicode-next-line
	const TEMPLATE = '次の Issue を直す: {{Issue の URL}}\nテストも足す';
	/** 入れた後の中身と、選ばれている文字。 */
	const insert = (value: string, start: number, end: number, touched: boolean, template = TEMPLATE) => {
		const result = paradisInsertPromptTemplate(value, start, end, touched, template);
		return { value: result.value, selected: result.value.slice(result.selectionStart, result.selectionEnd), caret: result.selectionStart };
	};

	test('inserts at the caret, replaces the selection, appends when the field was never touched, and selects the first hole', () => {
		assert.deepStrictEqual({
			// allow-any-unicode-next-line
			empty: insert('', 0, 0, false),
			// 欄に触っていなければ末尾へ。前の文が改行で終わっていなければ改行を 1 つはさむ
			// allow-any-unicode-next-line
			untouched: insert('先に書いた文', 0, 0, false),
			// カーソルの位置（文の途中）へ入れる
			caret: insert('AB', 1, 1, true, 'x'),
			// 選んでいた文字は置き換える（穴が選ばれたまま別のテンプレートを押したときも同じ）
			// allow-any-unicode-next-line
			selection: insert('前 {{古い穴}} 後', 2, 9, true, 'new'),
			// カーソルを末尾に置いていれば、改行をはさまずにそのまま続ける
			caretAtEnd: insert('line', 4, 4, true, 'x'),
			// 触っていなくても、前の文が改行で終わっていれば改行を足さない
			newline: insert('line\n', 0, 0, false, 'x'),
		}, {
			// allow-any-unicode-next-line
			empty: { value: TEMPLATE, selected: '{{Issue の URL}}', caret: 14 },
			// allow-any-unicode-next-line
			untouched: { value: `先に書いた文\n${TEMPLATE}`, selected: '{{Issue の URL}}', caret: 21 },
			caret: { value: 'AxB', selected: '', caret: 2 },
			// allow-any-unicode-next-line
			selection: { value: '前 new 後', selected: '', caret: 5 },
			caretAtEnd: { value: 'linex', selected: '', caret: 5 },
			newline: { value: 'line\nx', selected: '', caret: 6 },
		});
	});

	test('names a saved template after the first line, cut at 24 characters, and numbers a taken name', () => {
		assert.deepStrictEqual([
			paradisPromptTemplateName('\n   \n  Fix   the login  \nmore', []),
			paradisPromptTemplateName('Fix the login', ['Fix the login', 'Fix the login (2)']),
			// allow-any-unicode-next-line
			paradisPromptTemplateName('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ', []),
			paradisPromptTemplateName('  \n ', []),
		], [
			'Fix the login',
			'Fix the login (3)',
			// allow-any-unicode-next-line
			'あいうえおかきくけこさしすせそたちつてとなにぬね…',
			undefined,
		]);
	});
});
