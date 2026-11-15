/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisMapCodexBackendResetCredits, paradisMapCodexResetCredits } from '../../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsService } from '../../node/paradisCodexAccountsService.js';

suite('Paradis Codex reset credits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let codexHome: string;
	let stateDirectory: string;
	let fetches: { url: string; method: string | undefined; account: string | undefined }[];
	let backendCredits: unknown;
	let backendStatus: number;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-reset-'));
		home = join(root, 'home');
		codexHome = join(home, '.codex');
		stateDirectory = join(root, 'state');
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'test-token' } }));
		fetches = [];
		backendCredits = { available_count: 2, credits: [{ status: 'AVAILABLE', expires_at: '2030-03-17T17:46:40.000Z', granted_at: '2027-01-15T08:00:00.000Z' }, { status: 'available', expires_at: 1_950_000_000 }] };
		backendStatus = 200;
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// 本物の chatgpt.com へは出さない。読み取りはこの偽物が答える。
	const fakeFetch = (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		fetches.push({ url, method: init?.method, account: headers['ChatGPT-Account-Id'] });
		return new Response(backendStatus === 200 ? JSON.stringify(backendCredits) : null, { status: backendStatus, headers: { 'Content-Type': 'application/json' } });
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

	// 残りは使用量と同じく auth.json のトークンで直接読む。見せるだけなので GET しか出さない。
	test('reads credits over HTTP once per cache window, and again after the window', async () => {
		let now = 1_000;
		const service = createService(() => now);
		const first = await service.readResetCredits(codexHome, false);
		await service.readResetCredits(codexHome, false);
		now += 3 * 60_000;
		await service.readResetCredits(codexHome, false);
		const peeked = service.peekResetCredits();
		service.dispose();
		assert.deepStrictEqual({
			count: first.credits?.availableCount,
			fetches,
			peeked: Object.keys(peeked),
		}, {
			count: 2,
			fetches: [
				{ url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', method: 'GET', account: 'acct-1' },
				{ url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', method: 'GET', account: 'acct-1' },
			],
			peeked: [codexHome],
		});
	});

	test('reports auth and backend failures without credits', async () => {
		const service = createService();
		backendStatus = 401;
		const auth = await service.readResetCredits(codexHome, true);
		backendStatus = 500;
		const unavailable = await service.readResetCredits(codexHome, true);
		const unknownHome = await service.readResetCredits(join(home, '.codex-unknown'), true);
		service.dispose();
		assert.deepStrictEqual([auth.error, auth.credits, unavailable.error, unavailable.credits, unknownHome.error], ['auth', undefined, 'unavailable', undefined, 'auth']);
	});
});
