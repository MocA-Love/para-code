/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 別のアカウントのトークンを保存しないための防御を、1つずつ切り分けて確かめる（ほかの防御が
// 先に止めてしまうと、その防御が壊れても気付けないため、各テストは1つの防御だけが止める状況を作る）。

import assert from 'assert';
import * as fs from 'fs';
import * as path from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisClaudeIdentity } from '../../common/paradisClaudeUsage.js';
import { IParadisClaudeAccountRecord, ParadisClaudeAccountRegistry, ParadisKeychainClaudeSecretStore, PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE } from '../../node/paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService } from '../../node/paradisClaudeAccountService.js';
import { IParadisClaudeLiveAuthOptions, ParadisClaudeLiveAuth, PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE } from '../../node/paradisClaudeLiveAuth.js';
import {
	ParadisFakeClaudeOAuth,
	ParadisMemoryKeychain,
	paradisCreateClaudeTestHome,
	paradisTestCredentials,
	paradisTestOauthAccount,
	paradisTestUsage,
	paradisWriteClaudeGlobalConfig
} from './paradisClaudeTestUtils.js';

const USER = 'tester';
const HOUR = 3600_000;
const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';
const BOB = `para-claude:${BOB_ID}`;

/** 読み直しのたびに身元を差し替えられる（2回の読み直しの間に書き換わった状況を作る）。 */
class ParadisScriptedIdentityLiveAuth extends ParadisClaudeLiveAuth {
	freshIdentities: (IParadisClaudeIdentity | undefined)[] = [];
	override async readIdentity(fresh = false): Promise<IParadisClaudeIdentity | undefined> {
		if (fresh && this.freshIdentities.length > 0) {
			return this.freshIdentities.shift();
		}
		return super.readIdentity(fresh);
	}
}

suite('ParadisClaudeAccountService defenses', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	function record(id: string, accountUuid: string, email: string): IParadisClaudeAccountRecord {
		return { id, email, accountUuid, organizationUuid: 'org-1', oauthAccount: paradisTestOauthAccount(accountUuid, email), createdAt: 1, updatedAt: 1 };
	}

	async function createHarness(records: IParadisClaudeAccountRecord[]) {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const keychain = new ParadisMemoryKeychain();
		const oauth = new ParadisFakeClaudeOAuth();
		const registry = new ParadisClaudeAccountRegistry(path.join(dirs.userData, 'accounts.json'), 'darwin');
		await registry.save(records);
		const clock = { now: Date.parse('2029-12-31T12:00:00Z') };
		const liveAuthOptions: IParadisClaudeLiveAuthOptions = { homedir: dirs.home, platform: 'darwin', keychain, userName: USER, lockTimeoutMs: 300, now: () => clock.now };
		const liveAuth = new ParadisScriptedIdentityLiveAuth(liveAuthOptions);
		const service = disposables.add(new ParadisClaudeAccountService({
			liveAuth,
			registry,
			secrets: new ParadisKeychainClaudeSecretStore(keychain),
			oauth,
			logService: new NullLogService(),
			now: () => clock.now,
			random: () => 0.5,
		}));
		return { ...dirs, keychain, oauth, registry, service, clock, liveAuth };
	}

	async function poll(service: ParadisClaudeAccountService): Promise<void> {
		await service.getState(undefined);
		await service.pollDue();
	}

	/** Alice が使用中で、Claude Code が Alice のトークンを更新した（保存分と違う）状態。 */
	async function aliceRefreshedByClaudeCode(harness: Awaited<ReturnType<typeof createHarness>>) {
		const aliceStored = paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + HOUR);
		const aliceLive = paradisTestCredentials('alice-2', 'alice-r2', harness.clock.now + 2 * HOUR);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, aliceStored);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, aliceLive);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.oauth.usageByToken.set('alice-2', { kind: 'ok', usage: paradisTestUsage(20) });
		return { aliceStored, aliceLive };
	}

	test('identity re-read: a login that changes between the two reads is not adopted', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		const { aliceStored } = await aliceRefreshedByClaudeCode(harness);
		harness.oauth.setProfile('alice-2', 'u-alice', 'alice@example.com');
		// 1回目の読み直しは Alice、2回目は Bob（その間に `claude /login` された）
		harness.liveAuth.freshIdentities = [{ accountUuid: 'u-alice', email: 'alice@example.com', organizationUuid: 'org-1' }, { accountUuid: 'u-bob', email: 'bob@example.com', organizationUuid: 'org-1' }];

		await poll(harness.service);
		assert.deepStrictEqual({ stored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceStored, profileCalls: harness.oauth.profileCalls }, { stored: true, profileCalls: [] });
	});

	test('lineage check: a token whose refresh token another registration holds is not adopted', async () => {
		// Bob を先に並べ、Alice の取り込みより前に Bob の保存分を読ませる
		const harness = await createHarness([record(BOB_ID, 'u-bob', 'bob@example.com'), record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		const { aliceStored } = await aliceRefreshedByClaudeCode(harness);
		// Bob として保存してあるものと同じリフレッシュトークン
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-x', 'alice-r2', harness.clock.now + HOUR));
		harness.oauth.setProfile('alice-2', 'u-alice', 'alice@example.com');
		harness.oauth.usageByToken.set('bob-x', { kind: 'ok', usage: paradisTestUsage(1) });

		await poll(harness.service);
		harness.clock.now += 11 * 60_000;
		await poll(harness.service);
		assert.deepStrictEqual({ stored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceStored, profileCalls: harness.oauth.profileCalls }, { stored: true, profileCalls: [] });
	});

	test('profile check: an unconfirmed owner is not adopted and is not asked again for ten minutes', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		const { aliceStored, aliceLive } = await aliceRefreshedByClaudeCode(harness);

		await poll(harness.service);
		harness.clock.now += 5 * 60_000;
		await poll(harness.service);
		const callsWithinTenMinutes = harness.oauth.profileCalls.length;
		const storedBefore = harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceStored;
		harness.oauth.setProfile('alice-2', 'u-alice', 'alice@example.com');
		harness.clock.now += 6 * 60_000;
		await poll(harness.service);

		assert.deepStrictEqual({
			callsWithinTenMinutes,
			storedBefore,
			adoptedLater: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceLive,
		}, { callsWithinTenMinutes: 1, storedBefore: true, adoptedLater: true });
	});

	test('switch window: the first poll after a switch does not adopt, the next one does', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')]);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + HOUR));
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + HOUR));
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + HOUR));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		assert.strictEqual((await harness.service.switchAccount(BOB)).outcome, 'switched');
		// 切り替えの後で Claude Code が Bob のトークンを更新した
		const bobLive = paradisTestCredentials('bob-2', 'bob-r2', harness.clock.now + 3 * HOUR);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, bobLive);
		harness.oauth.setProfile('bob-2', 'u-bob', 'bob@example.com');
		harness.oauth.usageByToken.set('bob-2', { kind: 'ok', usage: paradisTestUsage(3) });
		harness.oauth.usageByToken.set('alice-1', { kind: 'ok', usage: paradisTestUsage(3) });

		await harness.service.pollDue();
		const afterFirst = harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID) === bobLive;
		harness.clock.now += 11 * 60_000;
		await poll(harness.service);
		assert.deepStrictEqual({ afterFirst, afterSecond: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID) === bobLive }, { afterFirst: false, afterSecond: true });
	});

	test('switch stops when the outgoing account\'s newer token cannot be confirmed', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')]);
		const { aliceStored, aliceLive } = await aliceRefreshedByClaudeCode(harness);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + HOUR));

		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			result,
			live: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === aliceLive,
			stored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceStored,
		}, { result: { outcome: 'unverified', email: 'bob@example.com', previousEmail: 'alice@example.com' }, live: true, stored: true });
	});

	test('switch proceeds without confirmation when the outgoing login was wiped by Claude Code', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')]);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + HOUR));
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + HOUR));
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });

		assert.strictEqual((await harness.service.switchAccount(BOB)).outcome, 'switched');
	});

	test('a stand-by token that shares the current login\'s refresh token is never refreshed', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		// ~/.claude.json が無い（読めない）ので Alice は控えに見えるが、キーチェーンは Alice と同じ系列
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + 60_000));
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + 60_000));
		harness.oauth.refreshByToken.set('alice-r1', { kind: 'ok', credentialsJson: paradisTestCredentials('alice-2', 'alice-r2', harness.clock.now + HOUR) });

		await poll(harness.service);
		assert.deepStrictEqual({ refreshCalls: harness.oauth.refreshCalls, status: (await harness.service.getState(undefined)).claude.accounts[0].status }, { refreshCalls: [], status: 'unavailable' });
	});

	test('a login too large for the keychain stdin path fails as too_large and changes nothing', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')]);
		const aliceStored = paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + HOUR);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, aliceStored);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + HOUR));
		const live = JSON.stringify({ ...JSON.parse(aliceStored), mcpOAuth: { big: 'x'.repeat(3000) } });
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, live);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		const configBefore = await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8');
		harness.keychain.maxValueBytes = 2000;

		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			result,
			live: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === live,
			config: await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8') === configBefore,
		}, { result: { outcome: 'failed', email: 'bob@example.com', rolledBack: true, detail: 'too_large' }, live: true, config: true });
	});
});
