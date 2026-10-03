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
import { paradisCodexResetCreditRows, paradisMapCodexBackendResetCredits, paradisMapCodexResetCredits } from '../../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsService } from '../../node/paradisCodexAccountsService.js';

interface IFakeConsume { readonly account: string | undefined; readonly token: string | undefined; readonly redeemRequestId: string; readonly creditId?: string; readonly userAgent?: string; readonly beta?: string; readonly originator?: string; readonly redirect?: string }

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
	/** 設定すると、次の読み取り1回の応答をこれが解決するまで返さない（読んだ時点の中身で返す）。 */
	let readGate: Promise<void> | undefined;
	/** その止めた読み取りが始まったら呼ぶ。 */
	let onGatedRead: (() => void) | undefined;
	/** 設定すると、次の消費1回の応答をこれが解決するまで返さない。始まったら onGatedConsume を呼ぶ。 */
	let consumeGate: Promise<void> | undefined;
	let onGatedConsume: (() => void) | undefined;

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
		readGate = undefined;
		onGatedRead = undefined;
		consumeGate = undefined;
		onGatedConsume = undefined;
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// 本物の chatgpt.com へは出さない。読み取りと消費の両方をこの偽物が答える。
	const fakeFetch = (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		if (url === 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume') {
			assert.strictEqual(init?.method, 'POST');
			const body = JSON.parse(String(init?.body)) as { redeem_request_id: string; credit_id?: string };
			consumes.push({
				account: headers['ChatGPT-Account-Id'], token: headers.Authorization,
				redeemRequestId: body.redeem_request_id,
				...(body.credit_id !== undefined ? { creditId: body.credit_id } : {}),
				userAgent: headers['User-Agent'], beta: headers['OpenAI-Beta'], originator: headers.originator, redirect: init?.redirect,
			});
			const gate = consumeGate;
			consumeGate = undefined;
			if (gate) {
				onGatedConsume?.();
				await gate;
			}
			const answer = consumeAnswer();
			if (answer.throws !== undefined) {
				throw answer.throws;
			}
			return new Response(answer.status === 200 ? JSON.stringify({ code: answer.code }) : null, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
		}
		fetches.push({ url, account: headers['ChatGPT-Account-Id'] });
		const body = JSON.stringify(backendCredits);
		const gate = readGate;
		readGate = undefined;
		if (gate) {
			onGatedRead?.();
			await gate;
		}
		return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
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

	// 期限の一覧で選んだ1件は、Codex 本体（backend-client の consume_rate_limit_reset_credit_by_id）と同じく credit_id で送る。
	test('sends the chosen credit as credit_id and refuses an id that is not in the offer', async () => {
		backendCredits = { available_count: 2, credits: [{ id: 'credit-late', status: 'available', expires_at: 1_950_000_000 }, { id: 'credit-early', status: 'available', expires_at: 1_900_000_000 }] };
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		const stranger = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-x', creditId: 'credit-other' });
		const invalid = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-y', creditId: '' }).then(() => 'consumed', (error: Error) => error.message);
		const chosen = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', creditId: 'credit-late' });
		service.dispose();
		assert.deepStrictEqual({ rows: paradisCodexResetCreditRows(offer.credits!), stranger, invalid, chosen, sent: consumes.map(consume => [consume.redeemRequestId, consume.creditId]) }, {
			rows: [{ kind: 'dated', expiresAt: 1_900_000_000_000, id: 'credit-early' }, { kind: 'dated', expiresAt: 1_950_000_000_000, id: 'credit-late' }],
			stranger: { kind: 'rejected', reason: 'offerChanged' },
			invalid: 'invalid reset-credit request',
			chosen: { kind: 'consumed', outcome: 'reset' },
			sent: [['key-a', 'credit-late']],
		});
	});

	test('resends an unknown outcome with the credit that was chosen first', async () => {
		backendCredits = { available_count: 2, credits: [{ id: 'credit-1', status: 'available', expires_at: 1_900_000_000 }, { id: 'credit-2', status: 'available', expires_at: 1_950_000_000 }] };
		consumeAnswer = () => ({ throws: new Error('fetch failed') });
		const first = createService();
		const offer = await first.readResetCredits(codexHome, false);
		await assert.rejects(first.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', creditId: 'credit-2' }));
		first.dispose();

		consumeAnswer = () => ({ status: 200, code: 'already_redeemed' });
		const second = createService(() => 2_000);
		const reread = await second.readResetCredits(codexHome, true);
		// 今回は別の1件を選んでも、送るのは結果の分からない最初の要求と同じもの
		const result = await second.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-b', creditId: 'credit-1' });
		second.dispose();
		assert.deepStrictEqual({ result, sent: consumes.map(consume => [consume.redeemRequestId, consume.creditId]) }, {
			result: { kind: 'consumed', outcome: 'alreadyRedeemed', resentPrevious: true },
			sent: [['key-a', 'credit-2'], ['key-a', 'credit-2']],
		});
	});

	// モバイルの要求で3分ごとに読み直しても、中身が同じなら確認した提示のまま押せる。中身が変われば断る。
	test('the offer revision depends only on the content, not on when it was read', async () => {
		let now = 1_000;
		const service = createService(() => now);
		const shown = await service.readResetCredits(codexHome, false);
		now = 1_000 + 4 * 60_000;
		const reread = await service.readResetCredits(codexHome, false);
		const sameContent = await service.consumeResetCredit({ homePath: codexHome, offerRevision: shown.offerRevision!, idempotencyKey: 'key-a' });
		backendCredits = { available_count: 1, credits: [{ status: 'available', expires_at: 1_950_000_000 }] };
		now += 60_000;
		const changed = await service.readResetCredits(codexHome, true);
		const staleRevision = await service.consumeResetCredit({ homePath: codexHome, offerRevision: shown.offerRevision!, idempotencyKey: 'key-b' });
		service.dispose();
		assert.deepStrictEqual({
			sameRevision: reread.offerRevision === shown.offerRevision,
			fetchCount: fetches.length,
			sameContent,
			revisionChanged: changed.offerRevision !== shown.offerRevision,
			staleRevision,
			sent: consumeCalls(),
		}, {
			sameRevision: true,
			fetchCount: 3,
			sameContent: { kind: 'consumed', outcome: 'reset' },
			revisionChanged: true,
			staleRevision: { kind: 'rejected', reason: 'offerChanged' },
			sent: ['key-a'],
		});
	});

	// 同じ中身への2回目は、結果の出た要求の後に読み直した提示なら押せる（連打・同時操作は断る）。
	test('a settled or refused request blocks the same content until it is read again', async () => {
		let now = 1_000;
		consumeAnswer = () => ({ status: 400 });
		const service = createService(() => now);
		const offer = await service.readResetCredits(codexHome, false);
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		consumeAnswer = () => ({ status: 200, code: 'nothing_to_reset' });
		const notReread = await service.readResetCredits(codexHome, false).then(() => service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b', offerFetchedAt: offer.fetchedAt }));
		now += 1_000;
		const reread = await service.readResetCredits(codexHome, true);
		const afterReread = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-c', offerFetchedAt: reread.fetchedAt });
		service.dispose();
		assert.deepStrictEqual({ sameRevision: reread.offerRevision === offer.offerRevision, notReread, afterReread, sent: consumeCalls() }, {
			sameRevision: true,
			notReread: { kind: 'rejected', reason: 'alreadyAttempted' },
			afterReread: { kind: 'consumed', outcome: 'nothingToReset' },
			sent: ['key-a', 'key-c'],
		});
	});

	test('marks the result when a chosen credit was not sent because an earlier request was resent', async () => {
		backendCredits = { available_count: 2, credits: [{ id: 'credit-1', status: 'available', expires_at: 1_900_000_000 }, { id: 'credit-2', status: 'available', expires_at: 1_950_000_000 }] };
		consumeAnswer = () => ({ throws: new Error('fetch failed') });
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a' }));
		consumeAnswer = () => ({ status: 200, code: 'reset' });
		const reread = await service.readResetCredits(codexHome, true);
		const chosen = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-b', creditId: 'credit-2' });
		service.dispose();
		assert.deepStrictEqual({ chosen, sent: consumes.map(consume => [consume.redeemRequestId, consume.creditId]) }, {
			chosen: { kind: 'consumed', outcome: 'reset', resentPrevious: true },
			sent: [['key-a', undefined], ['key-a', undefined]],
		});
	});

	// reset の後に同じ中身が見えているのは読み取りが古いということ。読み直していても、別の画面からでも断る。
	test('after a reset the same content is refused from another window, even when it was read again', async () => {
		let now = 1_000;
		const service = createService(() => now);
		const windowA = await service.readResetCredits(codexHome, false);
		const windowB = { ...windowA };
		await service.consumeResetCredit({ homePath: codexHome, offerRevision: windowA.offerRevision!, idempotencyKey: 'key-a', offerFetchedAt: windowA.fetchedAt });
		// backend の明細の反映が遅れ、使った後も同じ中身を返す
		now += 60_000;
		const reread = await service.readResetCredits(codexHome, true);
		const oldScreen = await service.consumeResetCredit({ homePath: codexHome, offerRevision: windowB.offerRevision!, idempotencyKey: 'key-b', offerFetchedAt: windowB.fetchedAt });
		const rereadScreen = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-c', offerFetchedAt: reread.fetchedAt });
		service.dispose();
		assert.deepStrictEqual({ sameRevision: reread.offerRevision === windowA.offerRevision, oldScreen, rereadScreen, sent: consumeCalls() }, {
			sameRevision: true,
			oldScreen: { kind: 'rejected', reason: 'alreadyAttempted' },
			rereadScreen: { kind: 'rejected', reason: 'alreadyAttempted' },
			sent: ['key-a'],
		});
	});

	test('pressing again right after a reset is refused', async () => {
		const service = createService();
		const offer = await service.readResetCredits(codexHome, false);
		const first = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', offerFetchedAt: offer.fetchedAt });
		const second = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b', offerFetchedAt: offer.fetchedAt });
		// 次の読み取りが同じ中身を返しても、同じ画面からの連打は通らない
		await service.readResetCredits(codexHome, false);
		const third = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-c', offerFetchedAt: offer.fetchedAt });
		service.dispose();
		assert.deepStrictEqual({ first, second, third, sent: consumeCalls() }, {
			first: { kind: 'consumed', outcome: 'reset' },
			second: { kind: 'rejected', reason: 'offerChanged' },
			third: { kind: 'rejected', reason: 'alreadyAttempted' },
			sent: ['key-a'],
		});
	});

	// 消費の前に始まった読み取り（使う前の残数）が消費の後に返っても、キャッシュを上書きしない。
	test('a read that started before a consume does not overwrite the cache after it', async () => {
		let now = 1_000;
		const service = createService(() => now);
		const offer = await service.readResetCredits(codexHome, false);
		let release!: () => void;
		readGate = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { onGatedRead = resolve; });
		const slowRead = service.readResetCredits(codexHome, true);
		await started;
		await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', offerFetchedAt: offer.fetchedAt });
		backendCredits = { available_count: 1, credits: [{ status: 'available', expires_at: 1_950_000_000 }] };
		now += 1_000;
		// 走っている読み取りは消費より前のものなので、読み直す
		const fresh = await service.readResetCredits(codexHome, true);
		release();
		const late = await slowRead;
		const cached = await service.readResetCredits(codexHome, false);
		service.dispose();
		assert.deepStrictEqual({ late: late.credits?.availableCount, fresh: fresh.credits?.availableCount, cached: cached.credits?.availableCount, peek: service.peekResetCredits()[codexHome]?.availableCount, fetchCount: fetches.length }, {
			late: 2,
			fresh: 1,
			cached: 1,
			peek: 1,
			fetchCount: 3,
		});
	});

	// 消費の途中に始まった読み取り（まだ使う前の残数かもしれない）は、消費の前に終わってもキャッシュに書かない。
	test('a read that starts while a consume is in flight is not cached', async () => {
		let now = 1_000;
		const service = createService(() => now);
		const offer = await service.readResetCredits(codexHome, false);
		let release!: () => void;
		consumeGate = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { onGatedConsume = resolve; });
		// 結果の分からない失敗にして、消費の後のキャッシュの削除に頼らない
		consumeAnswer = () => ({ throws: new Error('fetch failed') });
		const consuming = service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', offerFetchedAt: offer.fetchedAt });
		await started;
		now += 1_000;
		backendCredits = { available_count: 1, credits: [{ status: 'available', expires_at: 1_950_000_000 }] };
		const midway = await service.readResetCredits(codexHome, true);
		const peekWhileConsuming = service.peekResetCredits()[codexHome];
		release();
		await assert.rejects(consuming);
		service.dispose();
		assert.deepStrictEqual({ midway: midway.credits?.availableCount, peekWhileConsuming: peekWhileConsuming?.availableCount, peekAfter: service.peekResetCredits()[codexHome]?.availableCount }, {
			midway: 1,
			// 途中の読み取り（残り 1）では、消費の前の読み取り（残り 2）を上書きしていない
			peekWhileConsuming: 2,
			peekAfter: 2,
		});
	});

	// 明細の無い応答で、使った後に付与されて同じ回数に戻ったとき。使った直後の古い読み取りと見分けがつかないので
	// 10 分は断り、それを過ぎてから読んだ提示なら押せる（未来の読み取り時刻は断る）。
	test('after a reset the same count can be used again once ten minutes have passed', async () => {
		backendCredits = { available_count: 2 };
		let now = 1_000;
		const service = createService(() => now);
		const offer = await service.readResetCredits(codexHome, false);
		await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', offerFetchedAt: offer.fetchedAt });
		now += 11 * 60_000;
		const reread = await service.readResetCredits(codexHome, true);
		const future = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-b', offerFetchedAt: reread.fetchedAt + 1 });
		const after = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-c', offerFetchedAt: reread.fetchedAt });
		service.dispose();
		assert.deepStrictEqual({ sameRevision: reread.offerRevision === offer.offerRevision, future, after, sent: consumeCalls() }, {
			sameRevision: true,
			future: { kind: 'rejected', reason: 'alreadyAttempted' },
			after: { kind: 'consumed', outcome: 'reset' },
			sent: ['key-a', 'key-c'],
		});
	});

	test('after a reset the same count is refused within ten minutes', async () => {
		backendCredits = { available_count: 2 };
		let now = 1_000;
		const service = createService(() => now);
		const offer = await service.readResetCredits(codexHome, false);
		await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', offerFetchedAt: offer.fetchedAt });
		now += 9 * 60_000;
		const reread = await service.readResetCredits(codexHome, true);
		const within = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-b', offerFetchedAt: reread.fetchedAt });
		service.dispose();
		assert.deepStrictEqual({ within, sent: consumeCalls() }, {
			within: { kind: 'rejected', reason: 'alreadyAttempted' },
			sent: ['key-a'],
		});
	});

	// 結果の分からないまま 24 時間を過ぎた要求は送り直さず、読み直した提示なら新しい鍵で押せる。
	test('an unknown outcome older than the resend window allows a fresh press after reading again', async () => {
		let now = 1_000;
		consumeAnswer = () => ({ throws: new Error('fetch failed') });
		const service = createService(() => now);
		const offer = await service.readResetCredits(codexHome, false);
		await assert.rejects(service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-a', offerFetchedAt: offer.fetchedAt }));
		consumeAnswer = () => ({ status: 200, code: 'reset' });
		now += 25 * 60 * 60 * 1000;
		const reread = await service.readResetCredits(codexHome, true);
		const oldScreen = await service.consumeResetCredit({ homePath: codexHome, offerRevision: offer.offerRevision!, idempotencyKey: 'key-b', offerFetchedAt: offer.fetchedAt });
		const fresh = await service.consumeResetCredit({ homePath: codexHome, offerRevision: reread.offerRevision!, idempotencyKey: 'key-c', offerFetchedAt: reread.fetchedAt });
		service.dispose();
		assert.deepStrictEqual({ pendingUnknown: reread.pendingUnknown, oldScreen, fresh, sent: consumeCalls() }, {
			pendingUnknown: undefined,
			oldScreen: { kind: 'rejected', reason: 'alreadyAttempted' },
			fresh: { kind: 'consumed', outcome: 'reset' },
			sent: ['key-a', 'key-c'],
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
