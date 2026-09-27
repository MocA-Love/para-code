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
import { ParadisCodexAccountsService } from '../../node/paradisCodexAccountsService.js';

interface IFakeConsume { readonly account: string | undefined; readonly token: string | undefined; readonly redeemRequestId: string; readonly userAgent?: string; readonly beta?: string; readonly originator?: string; readonly redirect?: string }

/** 偽のバックエンドの消費の答え。`status` が 200 以外なら本文は空。`throws` なら通信の失敗。 */
type ParadisFakeConsumeAnswer = { readonly status: number; readonly code?: string; readonly throws?: undefined } | { readonly status?: undefined; readonly throws: Error };

suite('Paradis Codex reset credits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let codexHome: string;
	let stateDirectory: string;
	let consumes: IFakeConsume[];
	let fetches: { url: string; account: string | undefined }[];
	let consumeAnswer: () => ParadisFakeConsumeAnswer;
	let backendCredits: unknown;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-reset-'));
		home = join(root, 'home');
		codexHome = join(home, '.codex');
		stateDirectory = join(root, 'state');
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'test-token' } }));
		consumes = [];
		fetches = [];
		backendCredits = { available_count: 2, credits: [{ status: 'AVAILABLE', expires_at: '2030-03-17T17:46:40.000Z', granted_at: '2027-01-15T08:00:00.000Z' }, { status: 'available', expires_at: 1_950_000_000 }] };
		consumeAnswer = () => ({ status: 200, code: 'reset' });
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// 本物の chatgpt.com へは出さない。読み取りと消費の両方をこの偽物が答える。
	const fakeFetch = (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		if (url === 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume') {
			assert.strictEqual(init?.method, 'POST');
			consumes.push({
				account: headers['ChatGPT-Account-Id'], token: headers.Authorization,
				redeemRequestId: (JSON.parse(String(init?.body)) as { redeem_request_id: string }).redeem_request_id,
				userAgent: headers['User-Agent'], beta: headers['OpenAI-Beta'], originator: headers.originator, redirect: init?.redirect,
			});
			const answer = consumeAnswer();
			if (answer.throws !== undefined) {
				throw answer.throws;
			}
			return new Response(answer.status === 200 ? JSON.stringify({ code: answer.code }) : null, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
		}
		fetches.push({ url, account: headers['ChatGPT-Account-Id'] });
		return new Response(JSON.stringify(backendCredits), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as unknown as typeof fetch;

	function createService(now: () => number = () => 1_000): ParadisCodexAccountsService {
		return new ParadisCodexAccountsService({
			logService: new NullLogService(),
			stateDirectory,
			resolveEnv: async () => ({}),
			homeDirectory: home,
			fetch: fakeFetch,
			now,
			skipBackgroundWork: true,
		});
	}

	function consumeCalls(): string[] {
		return consumes.map(consume => consume.redeemRequestId);
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

	// 残りは使用量と同じく auth.json のトークンで直接読む。
	test('reads credits over HTTP once per cache window', async () => {
		const service = createService();
		const first = await service.readResetCredits(codexHome, false);
		const second = await service.readResetCredits(codexHome, false);
		service.dispose();
		assert.deepStrictEqual({
			count: first.credits?.availableCount,
			sameOffer: first.offerRevision === second.offerRevision && typeof first.offerRevision === 'string',
			fetches,
			consumes: consumes.length,
		}, { count: 2, sameOffer: true, fetches: [{ url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', account: 'acct-1' }], consumes: 0 });
	});

	test('two windows pressing at the same time only send one consume request', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		const [a, b] = await Promise.all([
			service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }),
			service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b' }),
		]);
		service.dispose();
		// Orca と同じく、バックエンドへ直接 POST し、本文の redeem_request_id に冪等の鍵を載せる
		assert.deepStrictEqual({ a, b, consumes }, {
			a: { kind: 'consumed', outcome: 'reset' },
			b: { kind: 'rejected', reason: 'offerChanged' },
			// 見出しは Orca と同じ。リダイレクトは追わない（トークンを chatgpt.com の外へ転送させない）
			consumes: [{ account: 'acct-1', token: 'Bearer test-token', redeemRequestId: 'key-a', userAgent: 'codex-cli', beta: 'codex-1', originator: 'Codex Desktop', redirect: 'error' }],
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

	test('an unknown outcome is resent with the original redeem_request_id after a restart', async () => {
		consumeAnswer = () => ({ throws: new Error('fetch failed') });
		const first = createService();
		const offer = await first.readResetCredits(codexHome, false);
		await assert.rejects(first.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		first.dispose();

		consumeAnswer = () => ({ status: 200, code: 'already_redeemed' });
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

	// 要求が provider へ出ていない・使われていないと分かっているときは「結果不明」にしない（抜けられなくなるため）。
	test('does not leave an unknown outcome when signed out or the backend refused a first request for auth', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1' } }));
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		const afterSignedOut = { ledger: ledgerStates(), sent: consumeCalls() };
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'test-token' } }));
		const results: string[] = [];
		for (const status of [401, 403]) {
			consumeAnswer = () => ({ status });
			const reread = await service.readResetCredits(codexHome, true);
			results.push(await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: `key-${status}` }).then(() => 'consumed', (error: Error) => error.message));
		}
		const reread = await service.readResetCredits(codexHome, false);
		service.dispose();
		assert.deepStrictEqual({ afterSignedOut, results, ledger: ledgerStates(), pendingUnknown: reread.pendingUnknown }, {
			afterSignedOut: { ledger: [], sent: [] },
			results: ['Codex reset failed: HTTP 401', 'Codex reset failed: HTTP 403'],
			ledger: [],
			pendingUnknown: undefined,
		});
	});

	// 429 は初めての鍵でも結果不明のまま残す（ゲートウェイで断ったとは限らない）。
	// 結果不明の再送が 401・403・429 を受けても記録を外さない。外すと次の操作が新しい鍵になり、
	// 最初の要求が使われていた場合に2枚目が減る。
	test('keeps the unknown outcome when a first request gets 429 or a resend gets 401, 403 or 429', async () => {
		consumeAnswer = () => ({ status: 429 });
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		const after429 = ledgerStates();
		const resent: string[] = [];
		for (const status of [401, 403, 429]) {
			consumeAnswer = () => ({ status });
			const reread = await service.readResetCredits(codexHome, true);
			resent.push(await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: `key-${status}` }).then(() => 'consumed', (error: Error) => error.message));
		}
		consumeAnswer = () => ({ status: 200, code: 'already_redeemed' });
		const reread = await service.readResetCredits(codexHome, true);
		const settled = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-new' });
		service.dispose();
		assert.deepStrictEqual({ after429, resent, pendingUnknown: reread.pendingUnknown, settled, sent: consumeCalls(), ledger: ledgerStates() }, {
			after429: ['key-a:providerPending'],
			resent: ['Codex reset failed: HTTP 401', 'Codex reset failed: HTTP 403', 'Codex reset failed: HTTP 429'],
			pendingUnknown: true,
			settled: { kind: 'consumed', outcome: 'alreadyRedeemed' },
			// どの再送も最初の鍵のまま
			sent: ['key-a', 'key-a', 'key-a', 'key-a', 'key-a'],
			ledger: ['key-a:settled'],
		});
	});

	// バックエンドが要求を断ったら結果不明にしない（同じ提示への2回目は断り、読み直せば押せる）。
	// 5xx は使われたか分からないので結果不明のまま残し、同じ redeem_request_id で再送する。
	test('records a refused request as failed and keeps a 5xx as unknown', async () => {
		consumeAnswer = () => ({ status: 503 });
		const unknown = createService();
		const first = await unknown.readResetCredits(codexHome, false);
		await assert.rejects(unknown.consumeResetCredit({ homePath: codexHome, offerRevision: first.offerRevision!, idempotencyKey: 'key-5xx' }));
		consumeAnswer = () => ({ status: 200, code: 'reset' });
		const retried = await unknown.readResetCredits(codexHome, true);
		const resent = await unknown.consumeResetCredit({ homePath: codexHome, offerRevision: retried.offerRevision!, idempotencyKey: 'key-new' });
		unknown.dispose();
		assert.deepStrictEqual({ pendingUnknown: retried.pendingUnknown, resent, sent: consumeCalls() }, {
			pendingUnknown: true,
			resent: { kind: 'consumed', outcome: 'reset' },
			sent: ['key-5xx', 'key-5xx'],
		});
	});

	test('records a definite backend refusal as failed instead of unknown', async () => {
		consumeAnswer = () => ({ status: 400 });
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
		consumeAnswer = () => ({ throws: new Error('The operation was aborted') });
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		consumeAnswer = () => ({ status: 200, code: 'already_redeemed' });
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
