/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IParadisLimitsSnapshot } from '../../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisCodexAccountsState } from '../../common/paradisCodexAccounts.js';
import { ParadisCodexMobileLimitsFields } from '../../electron-browser/paradisCodexMobileLimitsFields.js';

suite('Paradis Codex mobile limits fields', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const state: IParadisCodexAccountsState = {
		homes: [
			{ homePath: '/u/.codex', label: '~/.codex', isDefault: true, signedIn: true },
			{ homePath: '/u/.codex-2', label: '~/.codex-2', isDefault: false, signedIn: true },
		],
		selection: { homePath: '/u/.codex-2', revision: 3 },
	};

	const snapshot: IParadisLimitsSnapshot = {
		claude: { accounts: [{ provider: 'claude', id: 'claude-swap:1', active: true, status: 'ok' }] },
		codex: {
			accounts: [
				{ provider: 'codex', id: '/u/.codex', homeLabel: '~/.codex', status: 'ok' },
				{ provider: 'codex', id: '/u/.codex-2', homeLabel: '~/.codex-2', status: 'ok' },
			],
		},
		fetchedAt: 1,
	};

	function create(): ParadisCodexMobileLimitsFields {
		// SSH のウィンドウでもクライアントが接続先のチャネルを呼ぶだけなので、ここでは区別しない
		const client = {
			getState: async () => state,
			peekResetCredits: async () => ({ '/u/.codex-2': { availableCount: 2, nextExpiresAt: 5_000, credits: [] } }),
		};
		return new ParadisCodexMobileLimitsFields({ createInstance: () => client } as unknown as IInstantiationService);
	}

	test('adds only optional fields to the Codex accounts and leaves everything else as is', async () => {
		const result = await create().addTo(snapshot);
		const empty = { ...snapshot, codex: { accounts: [] } };
		assert.deepStrictEqual({ result, emptyUnchanged: await create().addTo(empty) === empty }, {
			result: {
				claude: snapshot.claude,
				codex: {
					accounts: [
						{ provider: 'codex', id: '/u/.codex', homeLabel: '~/.codex', status: 'ok' },
						{ provider: 'codex', id: '/u/.codex-2', homeLabel: '~/.codex-2', status: 'ok', active: true, resetCredits: { availableCount: 2, nextExpiresAt: 5_000 } },
					],
				},
				fetchedAt: 1,
			},
			emptyUnchanged: true,
		});
	});
});
