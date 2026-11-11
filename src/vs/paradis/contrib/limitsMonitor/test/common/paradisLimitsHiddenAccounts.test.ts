/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsLimitsAccountHidden, paradisLimitsWithoutHidden, paradisParseLimitsHiddenAccounts } from '../../common/paradisLimitsHiddenAccounts.js';

suite('Paradis limits hidden accounts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the stored ledger, including the old id-only form, and ignores broken values', () => {
		assert.deepStrictEqual({
			current: [...paradisParseLimitsHiddenAccounts(JSON.stringify([{ id: 'a', email: 'a@example.com' }, { id: 'b' }]))],
			oldForm: [...paradisParseLimitsHiddenAccounts(JSON.stringify(['a']))],
			broken: [...paradisParseLimitsHiddenAccounts('{')],
			notArray: [...paradisParseLimitsHiddenAccounts('{"id":"a"}')],
			empty: [...paradisParseLimitsHiddenAccounts(undefined)],
		}, {
			current: [['a', 'a@example.com'], ['b', undefined]],
			oldForm: [['a', undefined]],
			broken: [],
			notArray: [],
			empty: [],
		});
	});

	// id は別のアカウントに使い回されることがあるので、両方の email が分かっていて食い違うときだけ隠さない
	test('hides by id and stops hiding only when both emails are known and differ', () => {
		const hidden = new Map<string, string | undefined>([['a', 'a@example.com'], ['b', undefined]]);
		assert.deepStrictEqual({
			sameEmail: paradisIsLimitsAccountHidden(hidden, { id: 'a', email: 'a@example.com' }),
			otherEmail: paradisIsLimitsAccountHidden(hidden, { id: 'a', email: 'x@example.com' }),
			emailNotRead: paradisIsLimitsAccountHidden(hidden, { id: 'a' }),
			hiddenWithoutEmail: paradisIsLimitsAccountHidden(hidden, { id: 'b', email: 'b@example.com' }),
			notHidden: paradisIsLimitsAccountHidden(hidden, { id: 'c', email: 'a@example.com' }),
		}, {
			sameEmail: true,
			otherEmail: false,
			emailNotRead: true,
			hiddenWithoutEmail: true,
			notHidden: false,
		});
	});

	test('removes the hidden accounts from both providers', () => {
		const snapshot = {
			fetchedAt: 1,
			claude: { accounts: [{ provider: 'claude', id: 'a', email: 'a@example.com', status: 'ok' }, { provider: 'claude', id: 'b', status: 'ok' }] },
			codex: { accounts: [{ provider: 'codex', id: '/home/example/.codex', status: 'ok' }] },
		} as const;
		assert.deepStrictEqual({
			hidden: paradisLimitsWithoutHidden(snapshot, new Map([['a', 'a@example.com'], ['/home/example/.codex', undefined]])),
			none: paradisLimitsWithoutHidden(snapshot, new Map()) === snapshot,
		}, {
			hidden: {
				fetchedAt: 1,
				claude: { accounts: [{ provider: 'claude', id: 'b', status: 'ok' }] },
				codex: { accounts: [] },
			},
			none: true,
		});
	});

	test('also removes a hidden Antigravity account, and leaves a snapshot without Antigravity as it is', () => {
		const antigravity = { provider: 'antigravity', id: '/home/example/.gemini', homeLabel: '~/.gemini', status: 'ok' } as const;
		const snapshot = { fetchedAt: 1, claude: { accounts: [] }, codex: { accounts: [] }, antigravity: { accounts: [antigravity] } };
		const hidden = new Map([['/home/example/.gemini', undefined]]);
		assert.deepStrictEqual({
			hidden: paradisLimitsWithoutHidden(snapshot, hidden),
			noAntigravity: paradisLimitsWithoutHidden({ fetchedAt: 1, claude: { accounts: [] }, codex: { accounts: [] } }, hidden),
		}, {
			hidden: { fetchedAt: 1, claude: { accounts: [] }, codex: { accounts: [] }, antigravity: { accounts: [] } },
			noAntigravity: { fetchedAt: 1, claude: { accounts: [] }, codex: { accounts: [] } },
		});
	});
});
