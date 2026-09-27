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
import { paradisMapCodexBackendResetCredits, paradisMapCodexResetCredits } from '../../common/paradisCodexAccounts.js';
import { IParadisCodexAppServerRpc, ParadisCodexAppServerRpcFactory, ParadisCodexRpcError } from '../../../../node/paradisCodexAppServerRpc.js';
import { ParadisCodexAccountsService } from '../../node/paradisCodexAccountsService.js';

interface IFakeCall { readonly home: string | undefined; readonly method: string; readonly params: unknown }

suite('Paradis Codex reset credits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let codexHome: string;
	let stateDirectory: string;
	let calls: IFakeCall[];
	let fetches: { url: string; account: string | undefined }[];
	let consumeHandler: (params: { idempotencyKey: string }) => Promise<unknown>;
	let startFailure: Error | undefined;
	let backendCredits: unknown;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-reset-'));
		home = join(root, 'home');
		codexHome = join(home, '.codex');
		stateDirectory = join(root, 'state');
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'test-token' } }));
		calls = [];
		fetches = [];
		startFailure = undefined;
		backendCredits = { available_count: 2, credits: [{ status: 'AVAILABLE', expires_at: '2030-03-17T17:46:40.000Z', granted_at: '2027-01-15T08:00:00.000Z' }, { status: 'available', expires_at: 1_950_000_000 }] };
		consumeHandler = async () => ({ outcome: 'reset' });
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const startRpc: ParadisCodexAppServerRpcFactory = async (_command, env) => {
		if (startFailure) {
			throw startFailure;
		}
		const rpc: IParadisCodexAppServerRpc = {
			request: async (method, params) => {
				calls.push({ home: env.CODEX_HOME, method, params });
				if (method === 'account/rateLimitResetCredit/consume') {
					return consumeHandler(params as { idempotencyKey: string });
				}
				throw new Error('unexpected method');
			},
			dispose: () => { },
		};
		return rpc;
	};

	const fakeFetch = (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		fetches.push({ url, account: headers['ChatGPT-Account-Id'] });
		return new Response(JSON.stringify(backendCredits), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as unknown as typeof fetch;

	function createService(now: () => number = () => 1_000): ParadisCodexAccountsService {
		return new ParadisCodexAccountsService({
			logService: new NullLogService(),
			stateDirectory,
			resolveEnv: async () => ({}),
			homeDirectory: home,
			startRpc,
			resolveCodexCommand: async () => 'codex',
			fetch: fakeFetch,
			now,
			skipBackgroundWork: true,
		});
	}

	function consumeCalls(): string[] {
		return calls.filter(call => call.method === 'account/rateLimitResetCredit/consume').map(call => (call.params as { idempotencyKey: string }).idempotencyKey);
	}

	function ledgerStates(): string[] {
		try {
			const ledger = JSON.parse(readFileSync(join(stateDirectory, 'codex-reset-credit-ledger.json'), 'utf8')) as { attempts: { key: string; state: string }[] };
			return ledger.attempts.map(attempt => `${attempt.key}:${attempt.state}`);
		} catch {
			return [];
		}
	}

	test('maps the app-server and backend summaries to milliseconds and the earliest expiry', () => {
		assert.deepStrictEqual({
			rpc: paradisMapCodexResetCredits({ availableCount: 1, credits: [{ status: 'available', expiresAt: 1_900_000_000, grantedAt: 1_800_000_000 }] }),
			backend: paradisMapCodexBackendResetCredits(backendCredits),
			invalid: [paradisMapCodexResetCredits(null), paradisMapCodexResetCredits({ availableCount: 'x' }), paradisMapCodexBackendResetCredits({})],
		}, {
			rpc: { availableCount: 1, nextExpiresAt: 1_900_000_000_000, credits: [{ status: 'available', expiresAt: 1_900_000_000_000, grantedAt: 1_800_000_000_000 }] },
			backend: {
				availableCount: 2,
				nextExpiresAt: 1_900_000_000_000,
				credits: [
					{ status: 'available', expiresAt: 1_900_000_000_000, grantedAt: 1_800_000_000_000 },
					{ status: 'available', expiresAt: 1_950_000_000_000, grantedAt: undefined },
				],
			},
			invalid: [undefined, undefined, undefined],
		});
	});

	// パネルを開くたびに app-server を起こさない。残りは使用量と同じく auth.json のトークンで直接読む。
	test('reads credits over HTTP once per cache window without starting an app-server', async () => {
		const service = createService();
		const first = await service.readResetCredits(codexHome, false);
		const second = await service.readResetCredits(codexHome, false);
		service.dispose();
		assert.deepStrictEqual({
			count: first.credits?.availableCount,
			sameOffer: first.offerRevision === second.offerRevision && typeof first.offerRevision === 'string',
			fetches,
			appServerCalls: calls.length,
		}, { count: 2, sameOffer: true, fetches: [{ url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', account: 'acct-1' }], appServerCalls: 0 });
	});

	test('two windows pressing at the same time only send one consume request', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		const [a, b] = await Promise.all([
			service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }),
			service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b' }),
		]);
		service.dispose();
		assert.deepStrictEqual({ a, b, sent: consumeCalls(), home: calls[0]?.home }, {
			a: { kind: 'consumed', outcome: 'reset' },
			b: { kind: 'rejected', reason: 'offerChanged' },
			sent: ['key-a'],
			home: codexHome,
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

	// 別のプロセスが同じ台帳で同じ提示を読んでいた（取得時刻まで同じ）場合でも、2つ目の鍵は断る。
	test('an offer that another key already claimed is refused as already attempted', async () => {
		const first = createService();
		const offer = await first.readResetCredits(codexHome, false);
		await first.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' });
		first.dispose();
		const second = createService();
		const sameOffer = await second.readResetCredits(codexHome, false);
		const refused = await second.consumeResetCredit({ homePath: codexHome, offerRevision: sameOffer.offerRevision!, idempotencyKey: 'key-b' });
		second.dispose();
		assert.deepStrictEqual({ sameRevision: sameOffer.offerRevision === offer.offerRevision, refused, sent: consumeCalls() }, {
			sameRevision: true,
			refused: { kind: 'rejected', reason: 'alreadyAttempted' },
			sent: ['key-a'],
		});
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

	// 要求が provider へ出ていないと分かっているときは「結果不明」にしない（抜けられなくなるため）。
	test('does not leave an unknown outcome when codex never started or refused for missing auth', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		startFailure = new Error('codex not found');
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		const afterStartFailure = ledgerStates();
		startFailure = undefined;
		consumeHandler = async () => { throw new ParadisCodexRpcError('codex account authentication required for rate limit reset credits', -32600); };
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b' }));
		const reread = await service.readResetCredits(codexHome, false);
		service.dispose();
		assert.deepStrictEqual({ afterStartFailure, afterAuthFailure: ledgerStates(), pendingUnknown: reread.pendingUnknown }, {
			afterStartFailure: [],
			afterAuthFailure: [],
			pendingUnknown: undefined,
		});
	});

	// app-server がエラーで答えたら結果不明にしない（同じ提示への2回目は断り、読み直せば押せる）。
	test('records a definite app-server error as failed instead of unknown', async () => {
		consumeHandler = async () => { throw new ParadisCodexRpcError('reset credit request rejected', -32000); };
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		const reread = await service.readResetCredits(codexHome, false);
		service.dispose();
		assert.deepStrictEqual({ ledger: ledgerStates(), pendingUnknown: reread.pendingUnknown, fetchedAgain: fetches.length }, {
			ledger: ['key-a:failed'],
			pendingUnknown: undefined,
			fetchedAgain: 2,
		});
	});

	// 確認した後にそのホームで別のアカウントへログインし直していたら、消費しない。
	test('refuses to consume when the home signed in to another account after the offer was shown', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-2', access_token: 'test-token' } }));
		const result = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' });
		service.dispose();
		assert.deepStrictEqual({ result, sent: consumeCalls() }, { result: { kind: 'rejected', reason: 'offerChanged' }, sent: [] });
	});

	// 同じ ChatGPT アカウントで2つのホームにログインしていても、「結果不明」は両方に効く。
	test('an unknown outcome in one home also blocks a fresh key from another home of the same account', async () => {
		const secondHome = join(home, '.codex-2');
		mkdirSync(secondHome, { recursive: true });
		writeFileSync(join(secondHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'test-token' } }));
		consumeHandler = async () => { throw new Error('codex app-server request timed out'); };
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		consumeHandler = async () => ({ outcome: 'alreadyRedeemed' });
		const other = await service.readResetCredits(secondHome, false);
		const result = await service.consumeResetCredit({ homePath: secondHome, offerRevision: other.offerRevision!, idempotencyKey: 'key-b' });
		service.dispose();
		assert.deepStrictEqual({ pendingUnknown: other.pendingUnknown, result, sent: consumeCalls() }, {
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
		assert.deepStrictEqual({ corrupt, unknown, sent: consumeCalls() }, {
			corrupt: { kind: 'rejected', reason: 'ledgerUnavailable' },
			unknown: { kind: 'rejected', reason: 'unknownHome' },
			sent: [],
		});
	});
});
