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

	test('権限が広がることを先頭に、前 → 後の要約、役割の全文を最後に出す', () => {
		assert.strictEqual(paradisBotChangeDetail({
			changes: [{ field: 'role', to: '# A\n\nリリースを見張る。' }, { field: 'permission', to: 'bypass' }, { field: 'agent', from: 'codex', to: 'claude' }],
			permission: 'wider',
		}, 'api'), [
			'この変更は、あなたではなくターミナル「api」のエージェントからの依頼です。',
			'',
			'権限が広がります。Bot が確認なしでできることが増えます。',
			'',
			'権限: （既定） → bypass',
			'エージェント: codex → claude',
			'',
			'役割（SOUL.md）を次の本文に書き換えます:',
			'# A\n\nリリースを見張る。',
		].join('\n'));
	});

	test('名前を変えることと一時停止を解くことも、前 → 後で出す', () => {
		assert.strictEqual(paradisBotChangeDetail({ changes: [{ field: 'name', from: 'A', to: 'B' }, { field: 'paused', from: 'true', to: 'false' }] }, 'api'), [
			'この変更は、あなたではなくターミナル「api」のエージェントからの依頼です。',
			'',
			'名前: A → B',
			'一時停止: true → false',
		].join('\n'));
	});

	test('GitHub の見張りを入れるときは、5 分ごとに gh で確かめることを出す', () => {
		assert.strictEqual(paradisBotChangeDetail({ changes: [{ field: 'watch_github', from: 'false', to: 'true' }] }), [
			'GitHub の見張り: false → true',
			'',
			'5 分ごとに gh で GitHub を確かめます。あなた宛てのレビューの依頼と担当の割り当てが新しく来たら、この Bot の見回りを起こします。gh でログインしているアカウントのすべてのリポジトリ（非公開・組織のものを含む）が対象で、その題とリポジトリ名をこの Bot に渡します。',
		].join('\n'));
	});

	test('持ち主が画面から変えるとき（依頼したターミナルなし）は、依頼の行を出さない', () => {
		assert.strictEqual(paradisBotChangeDetail({ changes: [{ field: 'name', from: 'A', to: 'B' }] }), '名前: A → B');
	});
});
