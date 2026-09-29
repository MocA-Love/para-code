/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisClaudeHostAccountsState } from '../../common/paradisClaudeAccounts.js';

suite('paradisClaudeHostAccountsState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks the SSH host and drops everything tied to switching local accounts', () => {
		const state = paradisClaudeHostAccountsState({
			claude: {
				accounts: [{ provider: 'claude', id: 'claude-host', email: 'host@example.com', homeLabel: '~/.claude', active: true, managed: true, registrable: true, status: 'ok', fiveHour: { usedPercent: 42 }, fetchedAt: 5 }],
				legacyAccounts: [{ email: 'old@example.com' }],
			},
			oldestFetchedAt: 5,
			switching: true,
		}, { label: 'devbox' });

		assert.deepStrictEqual(state, {
			claude: {
				accounts: [{ provider: 'claude', id: 'claude-host', email: 'host@example.com', homeLabel: '~/.claude', status: 'ok', fiveHour: { usedPercent: 42 }, fetchedAt: 5 }],
				remoteHost: { label: 'devbox' },
			},
			oldestFetchedAt: 5,
			switching: false,
		});
	});

	test('when the host could not be asked, shows the reason instead of any account', () => {
		assert.deepStrictEqual(paradisClaudeHostAccountsState(undefined, { label: 'devbox' }, 'not supported'), {
			claude: { accounts: [], sourceError: 'not supported', remoteHost: { label: 'devbox' } },
			switching: false,
		});
	});
});
