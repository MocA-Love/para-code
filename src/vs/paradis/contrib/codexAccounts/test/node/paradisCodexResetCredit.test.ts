/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisMapCodexResetCredits } from '../../common/paradisCodexAccounts.js';
import { IParadisCodexAppServerRpc, ParadisCodexAppServerRpcFactory } from '../../node/paradisCodexAppServerRpc.js';
import { ParadisCodexAccountsService } from '../../node/paradisCodexAccountsService.js';

interface IFakeCall { readonly home: string | undefined; readonly method: string; readonly params: unknown }

suite('Paradis Codex reset credits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let codexHome: string;
	let stateDirectory: string;
	let calls: IFakeCall[];
	let consumeHandler: (params: { idempotencyKey: string }) => Promise<unknown>;
	let credits: unknown;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-reset-'));
		home = join(root, 'home');
		codexHome = join(home, '.codex');
		stateDirectory = join(root, 'state');
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1' } }));
		calls = [];
		credits = { availableCount: 2, credits: [{ id: 'c1', status: 'available', expiresAt: 1_900_000_000, grantedAt: 1_800_000_000 }, { id: 'c2', status: 'available', expiresAt: 1_950_000_000, grantedAt: 1_800_000_000 }] };
		consumeHandler = async () => ({ outcome: 'reset' });
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const startRpc: ParadisCodexAppServerRpcFactory = async (_command, env) => {
		const rpc: IParadisCodexAppServerRpc = {
			request: async (method, params) => {
				calls.push({ home: env.CODEX_HOME, method, params });
				if (method === 'account/rateLimits/read') {
					return { rateLimitResetCredits: credits, accountId: 'acct-1' };
				}
				if (method === 'account/rateLimitResetCredit/consume') {
					return consumeHandler(params as { idempotencyKey: string });
				}
				throw new Error('unexpected method');
			},
			dispose: () => { },
		};
		return rpc;
	};

	function createService(now: () => number = () => 1_000): ParadisCodexAccountsService {
		return new ParadisCodexAccountsService({
			logService: new NullLogService(),
			stateDirectory,
			resolveEnv: async () => ({}),
			homeDirectory: home,
			startRpc,
			resolveCodexCommand: async () => 'codex',
			now,
		});
	}

	function consumeCalls(): string[] {
		return calls.filter(call => call.method === 'account/rateLimitResetCredit/consume').map(call => (call.params as { idempotencyKey: string }).idempotencyKey);
	}

	test('maps the app-server summary to milliseconds and the earliest expiry', () => {
		assert.deepStrictEqual(paradisMapCodexResetCredits(credits), {
			availableCount: 2,
			nextExpiresAt: 1_900_000_000_000,
			credits: [
				{ status: 'available', expiresAt: 1_900_000_000_000, grantedAt: 1_800_000_000_000 },
				{ status: 'available', expiresAt: 1_950_000_000_000, grantedAt: 1_800_000_000_000 },
			],
		});
		assert.strictEqual(paradisMapCodexResetCredits(null), undefined);
		assert.strictEqual(paradisMapCodexResetCredits({ availableCount: 'x' }), undefined);
	});

	test('reads credits once per cache window and in the right Codex home', async () => {
		const service = createService();
		const first = await service.readResetCredits(codexHome, false);
		const second = await service.readResetCredits(codexHome, false);
		service.dispose();
		assert.deepStrictEqual({
			count: first.credits?.availableCount,
			hasRevision: typeof first.offerRevision === 'string',
			same: first === second || first.offerRevision === second.offerRevision,
			reads: calls.map(call => [call.home, call.method]),
		}, { count: 2, hasRevision: true, same: true, reads: [[codexHome, 'account/rateLimits/read']] });
	});

	test('two windows pressing at the same time only send one consume request', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		const [a, b] = await Promise.all([
			service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }),
			service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b' }),
		]);
		service.dispose();
		assert.deepStrictEqual({ a, b, sent: consumeCalls() }, {
			a: { kind: 'consumed', outcome: 'reset' },
			b: { kind: 'rejected', reason: 'offerChanged' },
			sent: ['key-a'],
		});
	});

	test('a double click with the same key shares one request', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		const request = { homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' };
		const [a, b] = await Promise.all([service.consumeResetCredit(request), service.consumeResetCredit(request)]);
		const replay = await service.consumeResetCredit(request);
		service.dispose();
		assert.deepStrictEqual({ a, b, replay, sent: consumeCalls() }, {
			a: { kind: 'consumed', outcome: 'reset' },
			b: { kind: 'consumed', outcome: 'reset' },
			replay: { kind: 'consumed', outcome: 'reset' },
			sent: ['key-a'],
		});
	});

	test('an offer that another key already claimed is refused even after a re-read', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' });
		// 別ウィンドウが古い提示のまま押した
		const stale = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b' });
		service.dispose();
		assert.deepStrictEqual({ stale, sent: consumeCalls() }, { stale: { kind: 'rejected', reason: 'offerChanged' }, sent: ['key-a'] });
	});

	test('an unknown outcome is resent with the original key after a restart', async () => {
		consumeHandler = async () => { throw new Error('codex app-server request timed out'); };
		const first = createService();
		const offer = await first.readResetCredits(codexHome, false);
		await assert.rejects(first.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		first.dispose();

		consumeHandler = async () => ({ outcome: 'alreadyRedeemed' });
		const second = createService(() => 2_000);
		const reread = await second.readResetCredits(codexHome, true);
		const result = await second.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-b' });
		second.dispose();
		assert.deepStrictEqual({ pendingUnknown: reread.pendingUnknown, result, sent: consumeCalls() }, {
			pendingUnknown: true,
			result: { kind: 'consumed', outcome: 'alreadyRedeemed' },
			sent: ['key-a', 'key-a'],
		});
	});

	test('a corrupt ledger or an unknown home never reaches the provider', async () => {
		mkdirSync(stateDirectory, { recursive: true });
		writeFileSync(join(stateDirectory, 'codex-reset-credit-ledger.json'), '{not json');
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		const corrupt = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' });
		service.dispose();

		rmSync(join(stateDirectory, 'codex-reset-credit-ledger.json'));
		const other = createService();
		const unknown = await other.consumeResetCredit({ homePath: join(root, 'elsewhere'), offerRevision: 'x', idempotencyKey: 'key-c' });
		other.dispose();
		assert.deepStrictEqual({ corrupt, unknown, sent: consumeCalls(), ledgerKept: readFileSafe(join(stateDirectory, 'codex-reset-credit-ledger.json')) }, {
			corrupt: { kind: 'rejected', reason: 'ledgerUnavailable' },
			unknown: { kind: 'rejected', reason: 'unknownHome' },
			sent: [],
			ledgerKept: undefined,
		});
	});

	function readFileSafe(path: string): string | undefined {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return undefined;
		}
	}
});
