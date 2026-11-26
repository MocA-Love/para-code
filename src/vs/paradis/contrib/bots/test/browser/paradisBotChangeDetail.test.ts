/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotChangeDetail } from '../../browser/paradisBotChangeDetail.js';

suite('Paradis bot change detail', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('何を何から何へ、役割の全文、権限が広がることを出す', () => {
		assert.strictEqual(paradisBotChangeDetail({
			changes: [{ field: 'permission', to: 'bypass' }, { field: 'agent', from: 'codex', to: 'claude' }, { field: 'role', to: '# A\n\nリリースを見張る。' }],
			permission: 'wider',
		}, 'api'), [
			'この変更は、あなたではなくターミナル「api」のエージェントからの依頼です。',
			'',
			'権限: （既定） → bypass',
			'エージェント: codex → claude',
			'役割（SOUL.md）を次の本文に書き換えます:',
			'# A\n\nリリースを見張る。',
			'',
			'',
			'権限が広がります。Bot が確認なしでできることが増えます。',
		].join('\n'));
	});

	test('持ち主が画面から変えるとき（依頼したターミナルなし）は、依頼の行を出さない', () => {
		assert.strictEqual(paradisBotChangeDetail({ changes: [{ field: 'name', from: 'A', to: 'B' }] }), '名前: A → B');
	});
});
