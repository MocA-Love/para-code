/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentQuestionKeySequence } from '../../common/paradisAgentQuestionKeys.js';

suite('paradisAgentQuestionKeySequence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const single = (optionCount: number) => ({ optionCount, multiSelect: false });
	const multi = (optionCount: number) => ({ optionCount, multiSelect: true });

	test('単問の単一選択は番号だけで確定する（Enterを足すと次の入力欄へ落ちる）', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence([single(3)], [{ kind: 'option', index: 1 }]),
			['2'],
		);
	});

	test('多問の単一選択は番号だけを並べ、最後に確認画面のEnterを1つ足す', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence(
				[single(2), single(4)],
				[{ kind: 'option', index: 0 }, { kind: 'option', index: 3 }],
			),
			['1', '4', '\r'],
		);
	});

	test('単一選択の自由入力は 番号→本文→Enter の順（先にEnterを送ると空のまま取り消される）', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence([single(2)], [{ kind: 'text', optionCount: 2, text: '  独自の案  ' }]),
			['3', '独自の案', '\r'],
		);
	});

	test('自由入力の改行は空白へ潰す（そのまま送ると途中で確定して残りが次の質問へ流れる）', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence([single(1)], [{ kind: 'text', optionCount: 1, text: '一行目\n二行目' }]),
			['2', '一行目 二行目', '\r'],
		);
	});

	test('複数選択は番号でトグルし、Tabで送信ボタンまで移動してEnterで次へ進む', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence([multi(3)], [{ kind: 'multi', indices: [2, 0] }]),
			['1', '3', '\t', '\t', '\t', '\t', '\r', '\r'],
		);
	});

	test('複数選択の自由入力はTabで入力欄まで移動してから本文を入れる', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence([multi(2)], [{ kind: 'text', optionCount: 2, text: 'その他の案' }]),
			['\t', '\t', 'その他の案', '\t', '\r', '\r'],
		);
	});

	test('先頭が複数選択でも、次の質問のキーが同じ質問に降らないよう送信ボタンを踏んでから進む', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence(
				[multi(2), single(3)],
				[{ kind: 'multi', indices: [1] }, { kind: 'option', index: 2 }],
			),
			['2', '\t', '\t', '\t', '\r', '3', '\r'],
		);
	});

	test('質問より多い回答は無視する（選択肢が入れ替わった時に番号だけ流し込まない）', () => {
		assert.deepStrictEqual(
			paradisAgentQuestionKeySequence([single(2)], [{ kind: 'option', index: 0 }, { kind: 'option', index: 1 }]),
			['1'],
		);
	});

	test('回答が無ければ何も送らない', () => {
		assert.deepStrictEqual(paradisAgentQuestionKeySequence([single(2)], []), []);
	});
});
