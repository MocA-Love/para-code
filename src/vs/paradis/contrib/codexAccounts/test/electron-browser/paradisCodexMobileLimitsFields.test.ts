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
import { IParadisCodexAccountsState, IParadisCodexResetCreditOffer } from '../../common/paradisCodexAccounts.js';
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
				{ provider: 'codex', id: '/u/.codex-3', homeLabel: '~/.codex-3', status: 'relogin_required' },
			],
		},
		fetchedAt: 1,
	};

	function create(options: { readonly slowHomes?: readonly string[]; readonly deadlineMs?: number } = {}): { fields: ParadisCodexMobileLimitsFields; reads: string[] } {
		const reads: string[] = [];
		// SSH のウィンドウでもクライアントが接続先のチャネルを呼ぶだけなので、ここでは区別しない
		const client = {
			getState: async () => state,
			readResetCredits: (homePath: string): Promise<IParadisCodexResetCreditOffer> => {
				reads.push(homePath);
				if (options.slowHomes?.includes(homePath)) {
					return new Promise(() => { });
				}
				return Promise.resolve({
					homePath,
					fetchedAt: 1,
					credits: homePath === '/u/.codex-2'
						? { availableCount: 3, nextExpiresAt: 5_000, credits: [{ status: 'available', expiresAt: 9_000, id: 'b' }, { status: 'redeemed', expiresAt: 1_000 }, { status: 'available', id: 'c' }, { status: 'available', expiresAt: 5_000, id: 'a' }] }
						: { availableCount: 0, credits: [] },
				});
			},
			peekResetCredits: async () => ({ '/u/.codex-2': { availableCount: 1, nextExpiresAt: 7_000 } }),
		};
		return { fields: new ParadisCodexMobileLimitsFields(options.deadlineMs ?? 1_000, { createInstance: () => client } as unknown as IInstantiationService), reads };
	}

	test('reads the reset credits on every request and sends each expiry without the ids', async () => {
		const { fields, reads } = create();
		const result = await fields.addTo(snapshot);
		const empty = { ...snapshot, codex: { accounts: [] } };
		assert.deepStrictEqual({ result, reads, emptyUnchanged: await create().fields.addTo(empty) === empty }, {
			result: {
				claude: snapshot.claude,
				codex: {
					accounts: [
						{ provider: 'codex', id: '/u/.codex', homeLabel: '~/.codex', status: 'ok', resetCredits: { availableCount: 0, credits: [] } },
						{
							provider: 'codex', id: '/u/.codex-2', homeLabel: '~/.codex-2', status: 'ok', active: true,
							resetCredits: { availableCount: 3, nextExpiresAt: 5_000, credits: [{ expiresAt: 5_000 }, { expiresAt: 9_000 }, {}] },
						},
						{ provider: 'codex', id: '/u/.codex-3', homeLabel: '~/.codex-3', status: 'relogin_required' },
					],
				},
				fetchedAt: 1,
			},
			// 認証の切れたアカウントは読まない
			reads: ['/u/.codex', '/u/.codex-2'],
			emptyUnchanged: true,
		});
	});

	test('answers with the cached value when a read does not finish in time', async () => {
		const { fields } = create({ slowHomes: ['/u/.codex-2'], deadlineMs: 1 });
		const result = await fields.addTo(snapshot);
		assert.deepStrictEqual(result.codex.accounts.map(account => (account as { resetCredits?: unknown }).resetCredits), [
			{ availableCount: 0, credits: [] },
			{ availableCount: 1, nextExpiresAt: 7_000 },
			undefined,
		]);
	});
});
