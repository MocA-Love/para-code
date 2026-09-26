/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as fs from 'fs';
import * as path from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisLimitsAccount } from '../../common/paradisLimitsMonitor.js';
import { IParadisClaudeAccountRecord, ParadisClaudeAccountRegistry, ParadisKeychainClaudeSecretStore, PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE } from '../../node/paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService } from '../../node/paradisClaudeAccountService.js';
import { ParadisClaudeLiveAuth, PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE } from '../../node/paradisClaudeLiveAuth.js';
import {
	ParadisFakeClaudeOAuth,
	ParadisMemoryKeychain,
	paradisCreateClaudeTestHome,
	paradisTestCredentials,
	paradisTestOauthAccount,
	paradisTestUsage,
	paradisWriteClaudeGlobalConfig
} from './paradisClaudeTestUtils.js';

const HOUR = 3600_000;
const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';
const USER = 'tester';

interface IHarness {
	readonly home: string;
	readonly userData: string;
	readonly keychain: ParadisMemoryKeychain;
	readonly oauth: ParadisFakeClaudeOAuth;
	readonly service: ParadisClaudeAccountService;
	now: number;
}

/** 表示に関係する項目だけに絞る（比較を1つの deepStrictEqual で書くため）。 */
function summarize(account: IParadisLimitsAccount): object {
	return {
		id: account.id,
		email: account.email,
		active: account.active,
		managed: account.managed,
		status: account.status,
		unavailableReason: account.unavailableReason,
		fiveHour: account.fiveHour?.usedPercent,
	};
}

suite('ParadisClaudeAccountService usage', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	async function createHarness(options: { platform?: NodeJS.Platform; records?: IParadisClaudeAccountRecord[] } = {}): Promise<IHarness> {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const platform = options.platform ?? 'darwin';
		const keychain = new ParadisMemoryKeychain();
		const oauth = new ParadisFakeClaudeOAuth();
		const registry = new ParadisClaudeAccountRegistry(path.join(dirs.userData, 'paradis-claude-accounts', 'accounts.json'), platform);
		if (options.records) {
			await registry.save(options.records);
		}
		const harness: { now: number } & Partial<IHarness> = { now: Date.parse('2029-12-31T12:00:00Z') };
		const service = disposables.add(new ParadisClaudeAccountService({
			liveAuth: new ParadisClaudeLiveAuth({ homedir: dirs.home, platform, keychain: platform === 'darwin' ? keychain : undefined, userName: USER, now: () => harness.now }),
			registry,
			secrets: new ParadisKeychainClaudeSecretStore(keychain),
			oauth,
			logService: new NullLogService(),
			now: () => harness.now,
			random: () => 0.5,
		}));
		return Object.assign(harness, { home: dirs.home, userData: dirs.userData, keychain, oauth, service }) as IHarness;
	}

	function record(id: string, accountUuid: string, email: string): IParadisClaudeAccountRecord {
		return { id, email, accountUuid, organizationUuid: 'org-1', oauthAccount: paradisTestOauthAccount(accountUuid, email), createdAt: 1, updatedAt: 1 };
	}

	async function poll(harness: IHarness, refresh = false): Promise<object[]> {
		await harness.service.getState({ refresh });
		await harness.service.pollDue();
		return (await harness.service.getState(undefined)).claude.accounts.map(summarize);
	}

	test('shows the unregistered live login with usage read from the Claude Code keychain item', async () => {
		const harness = await createHarness();
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com'), projects: {} });
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('live-access', 'live-refresh', harness.now + HOUR));
		harness.oauth.usageByToken.set('live-access', { kind: 'ok', usage: paradisTestUsage(42) });

		assert.deepStrictEqual(await poll(harness), [
			{ id: 'claude-live', email: 'alice@example.com', active: true, managed: false, status: 'ok', unavailableReason: undefined, fiveHour: 42 },
		]);
		// 使用中のアカウントのトークンは Claude Code のもの。Para Code は更新しない
		assert.deepStrictEqual(harness.oauth.refreshCalls, []);
	});

	test('reads ~/.claude/.credentials.json outside macOS', async () => {
		const harness = await createHarness({ platform: 'linux' });
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		await fs.promises.mkdir(path.join(harness.home, '.claude'));
		await fs.promises.writeFile(path.join(harness.home, '.claude', '.credentials.json'), paradisTestCredentials('file-access', 'file-refresh', harness.now + HOUR));
		harness.oauth.usageByToken.set('file-access', { kind: 'ok', usage: paradisTestUsage(7) });

		assert.deepStrictEqual(await poll(harness), [
			{ id: 'claude-live', email: 'alice@example.com', active: true, managed: false, status: 'ok', unavailableReason: undefined, fiveHour: 7 },
		]);
	});

	test('refreshes an expiring stand-by token, saves the rotated token and uses it', async () => {
		const harness = await createHarness({ records: [record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')] });
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('alice-live', 'alice-r2', harness.now + HOUR));
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, paradisTestCredentials('alice-old', 'alice-r1', harness.now - HOUR));
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-old', 'bob-r1', harness.now + 60_000));
		const bobRotated = paradisTestCredentials('bob-new', 'bob-r2', harness.now + 8 * HOUR);
		harness.oauth.refreshByToken.set('bob-r1', { kind: 'ok', credentialsJson: bobRotated });
		harness.oauth.usageByToken.set('alice-live', { kind: 'ok', usage: paradisTestUsage(50) });
		harness.oauth.usageByToken.set('bob-new', { kind: 'ok', usage: paradisTestUsage(5) });

		assert.deepStrictEqual(await poll(harness), [
			{ id: `para-claude:${ALICE_ID}`, email: 'alice@example.com', active: true, managed: true, status: 'ok', unavailableReason: undefined, fiveHour: 50 },
			{ id: `para-claude:${BOB_ID}`, email: 'bob@example.com', active: false, managed: true, status: 'ok', unavailableReason: undefined, fiveHour: 5 },
		]);
		assert.deepStrictEqual({
			refreshed: harness.oauth.refreshCalls,
			usage: harness.oauth.usageCalls,
			// 控え（Bob）は回った後のトークンを保存し直す
			bobStored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID),
			// 使用中（Alice）は Claude Code が更新して書き戻したトークンを取り込む
			aliceStored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID),
		}, {
			refreshed: ['bob-r1'],
			usage: ['alice-live', 'bob-new'],
			bobStored: bobRotated,
			aliceStored: paradisTestCredentials('alice-live', 'alice-r2', harness.now + HOUR),
		});
	});

	test('does not adopt wiped live credentials over the stored token', async () => {
		const harness = await createHarness({ records: [record(ALICE_ID, 'u-alice', 'alice@example.com')] });
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		const stored = paradisTestCredentials('alice-a', 'alice-r1', harness.now + HOUR);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, stored);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: '' } }));
		harness.oauth.usageByToken.set('x', { kind: 'ok', usage: paradisTestUsage(1) });

		await poll(harness);
		assert.strictEqual(harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID), stored);
	});

	test('serves results for 180 seconds, backs off on 429 and stops on a rejected refresh token', async () => {
		const harness = await createHarness({ records: [record(BOB_ID, 'u-bob', 'bob@example.com')] });
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('alice-live', 'alice-r', harness.now + HOUR));
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-a', 'bob-r', harness.now + 10 * HOUR));
		harness.oauth.usageByToken.set('alice-live', { kind: 'ok', usage: paradisTestUsage(10) });
		harness.oauth.usageByToken.set('bob-a', { kind: 'http', status: 429, retryAfterS: 3600 });

		const first = await poll(harness);
		// 手動の更新でも、180 秒以内の結果と 429 で待っている間は API を呼ばない
		harness.now += 60_000;
		await poll(harness, true);
		const callsAfterRefresh = harness.oauth.usageCalls.length;

		// 429 の待ち（1 時間 + 15 分の余裕）が明けたら取り直す。今度は失効している
		harness.now += 76 * 60_000;
		harness.oauth.usageByToken.set('bob-a', { kind: 'http', status: 401 });
		harness.oauth.refreshByToken.set('bob-r', { kind: 'invalid_grant' });
		const afterExpiry = await poll(harness);
		// 再ログインが要る状態になったら、その後は何度聞かれても取りに行かない
		const callsAfterDead = harness.oauth.usageCalls.length;
		harness.now += 2 * HOUR;
		await poll(harness, true);

		assert.deepStrictEqual({
			first,
			callsAfterRefresh,
			afterExpiry,
			stoppedPolling: harness.oauth.usageCalls.length - callsAfterDead,
		}, {
			first: [
				{ id: 'claude-live', email: 'alice@example.com', active: true, managed: false, status: 'ok', unavailableReason: undefined, fiveHour: 10 },
				{ id: `para-claude:${BOB_ID}`, email: 'bob@example.com', active: false, managed: true, status: 'unavailable', unavailableReason: 'rate_limited', fiveHour: undefined },
			],
			callsAfterRefresh: 2,
			afterExpiry: [
				{ id: 'claude-live', email: 'alice@example.com', active: true, managed: false, status: 'ok', unavailableReason: undefined, fiveHour: 10 },
				{ id: `para-claude:${BOB_ID}`, email: 'bob@example.com', active: false, managed: true, status: 'relogin_required', unavailableReason: undefined, fiveHour: undefined },
			],
			// Alice（使用中）の定期取得だけが走る
			stoppedPolling: 1,
		});
	});

	test('reports the live login as refreshing when its token is expired', async () => {
		const harness = await createHarness();
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('expired', 'r', harness.now - HOUR));

		assert.deepStrictEqual(await poll(harness), [
			{ id: 'claude-live', email: 'alice@example.com', active: true, managed: false, status: 'refreshing', unavailableReason: undefined, fiveHour: undefined },
		]);
		assert.deepStrictEqual(harness.oauth.refreshCalls, []);
	});
});
