/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisIsLimitsAccountHidden,
	paradisParseHiddenLimitsAccounts,
	paradisSerializeHiddenLimitsAccounts,
} from '../../common/paradisLimitsHiddenAccounts.js';

suite('ParadisLimitsHiddenAccounts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const CODEX_HOME = '/Users/example/.codex-2';

	test('reads both the current and the legacy id-only storage shapes', () => {
		assert.deepStrictEqual({
			current: [...paradisParseHiddenLimitsAccounts(JSON.stringify([{ id: CODEX_HOME, email: 'a@example.com' }]))],
			// 旧形式には email が無い。読めなかった分は undefined として扱う。
			legacy: [...paradisParseHiddenLimitsAccounts(JSON.stringify([CODEX_HOME]))],
			// email を載せずに書かれた新形式も同じ扱いにする。
			withoutEmail: [...paradisParseHiddenLimitsAccounts(JSON.stringify([{ id: CODEX_HOME }]))],
		}, {
			current: [[CODEX_HOME, 'a@example.com']],
			legacy: [[CODEX_HOME, undefined]],
			withoutEmail: [[CODEX_HOME, undefined]],
		});
	});

	test('falls back to showing everything when the stored value cannot be trusted', () => {
		// 非表示状態を失うだけなので、読めない値は全表示側へ倒す。
		for (const raw of [undefined, '', 'not json', '{"id":"x"}', '[42]', '[null]', '[{"email":"a@example.com"}]']) {
			assert.deepStrictEqual([...paradisParseHiddenLimitsAccounts(raw)], [], JSON.stringify(raw));
		}
	});

	test('round-trips the ledger through storage', () => {
		const hidden = new Map([[CODEX_HOME, 'a@example.com'], ['1', undefined]]);
		assert.deepStrictEqual([...paradisParseHiddenLimitsAccounts(paradisSerializeHiddenLimitsAccounts(hidden))], [...hidden]);
	});

	test('keeps a row hidden while the id still points at the same account', () => {
		const hidden = new Map([[CODEX_HOME, 'a@example.com']]);
		assert.deepStrictEqual({
			sameAccount: paradisIsLimitsAccountHidden(hidden, { id: CODEX_HOME, email: 'a@example.com' }),
			notHidden: paradisIsLimitsAccountHidden(hidden, { id: '/Users/example/.codex', email: 'a@example.com' }),
		}, {
			sameAccount: true,
			notHidden: false,
		});
	});

	test('reveals the row again once the id has been reassigned to a different account', () => {
		// id(ホームパス/スロット番号)は削除→再利用で別アカウントに割り当てられ得る。
		// 隠した覚えのないアカウントが一覧から消えたままにならないようにする。
		const hidden = new Map([[CODEX_HOME, 'a@example.com']]);
		assert.strictEqual(paradisIsLimitsAccountHidden(hidden, { id: CODEX_HOME, email: 'b@example.com' }), false);
	});

	test('stays hidden when either side has no email to compare', () => {
		// auth.json が読めない・ログアウト直後は email が載らずに返る。ここで「別アカウントに
		// なった」と誤判定すると、隠していたはずの行が一時的な失敗のたびに復活してしまう。
		assert.deepStrictEqual({
			accountLostItsEmail: paradisIsLimitsAccountHidden(new Map([[CODEX_HOME, 'a@example.com']]), { id: CODEX_HOME }),
			hiddenBeforeEmailsWereRecorded: paradisIsLimitsAccountHidden(new Map([[CODEX_HOME, undefined]]), { id: CODEX_HOME, email: 'a@example.com' }),
			neitherSideKnows: paradisIsLimitsAccountHidden(new Map([[CODEX_HOME, undefined]]), { id: CODEX_HOME }),
		}, {
			accountLostItsEmail: true,
			hiddenBeforeEmailsWereRecorded: true,
			neitherSideKnows: true,
		});
	});
});
