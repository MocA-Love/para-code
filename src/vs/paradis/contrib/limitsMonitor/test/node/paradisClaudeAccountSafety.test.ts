/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 別のアカウントのトークンを保存しない・アカウントと関係の無い秘密を巻き込まない・壊れた一覧を
// 上書きしない、といった取り違えの防止と、取得間隔の結合部を確かめる。

import assert from 'assert';
import * as fs from 'fs';
import * as path from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisClaudeAccountRecord, ParadisClaudeAccountRegistry, ParadisKeychainClaudeSecretStore, PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE } from '../../node/paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService } from '../../node/paradisClaudeAccountService.js';
import { ParadisClaudeLiveAuth, PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE } from '../../node/paradisClaudeLiveAuth.js';
import {
	ParadisFakeClaudeLoginRunner,
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

suite('ParadisClaudeAccountService safety', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	function record(id: string, accountUuid: string, email: string): IParadisClaudeAccountRecord {
		return { id, email, accountUuid, organizationUuid: 'org-1', oauthAccount: paradisTestOauthAccount(accountUuid, email), createdAt: 1, updatedAt: 1 };
	}

	async function createHarness(records: IParadisClaudeAccountRecord[], options: { withLoginRunner?: boolean } = {}) {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const tmp = path.join(dirs.userData, 'tmp');
		await fs.promises.mkdir(tmp);
		const keychain = new ParadisMemoryKeychain();
		const oauth = new ParadisFakeClaudeOAuth();
		const registry = new ParadisClaudeAccountRegistry(path.join(dirs.userData, 'accounts.json'), 'darwin');
		await registry.save(records);
		const clock = { now: Date.parse('2029-12-31T12:00:00Z') };
		const service = disposables.add(new ParadisClaudeAccountService({
			liveAuth: new ParadisClaudeLiveAuth({ homedir: dirs.home, platform: 'darwin', keychain, userName: USER, lockTimeoutMs: 300 }),
			registry,
			secrets: new ParadisKeychainClaudeSecretStore(keychain),
			oauth,
			logService: new NullLogService(),
			loginRunner: options.withLoginRunner ? new ParadisFakeClaudeLoginRunner(async () => undefined) : undefined,
			tmpdir: tmp,
			now: () => clock.now,
			random: () => 0.5,
		}));
		return { ...dirs, tmp, keychain, oauth, registry, service, clock };
	}

	async function poll(service: ParadisClaudeAccountService): Promise<void> {
		await service.getState(undefined);
		await service.pollDue();
	}

	test('a switch during a poll does not store the new account\'s token under the previous account', async () => {
		const harness = await createHarness([record(BOB_ID, 'u-bob', 'bob@example.com'), record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		const aliceStored = paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + HOUR);
		const bobStored = paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + 8 * HOUR);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, aliceStored);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, bobStored);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, aliceStored);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.oauth.usageByToken.set('bob-1', { kind: 'ok', usage: paradisTestUsage(5) });
		harness.oauth.usageByToken.set('alice-1', { kind: 'ok', usage: paradisTestUsage(40) });
		// どちらのトークンの持ち主も API で確かめられる状態にしておく（取り違えを身元の読み直しで防ぐことを見る）
		harness.oauth.setProfile('bob-1', 'u-bob', 'bob@example.com');
		harness.oauth.setProfile('alice-1', 'u-alice', 'alice@example.com');

		// 控えの Bob を取っている途中で止め、その間に Bob へ切り替える
		let release: () => void = () => { };
		harness.oauth.usageGate = new Promise<void>(resolve => { release = resolve; });
		await harness.service.getState(undefined);
		const polling = harness.service.pollDue();
		while (harness.oauth.usageCalls.length === 0) {
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		const switched = await harness.service.switchAccount(`para-claude:${BOB_ID}`);
		harness.oauth.usageGate = undefined;
		release();
		await polling;

		assert.deepStrictEqual({
			switched: switched.outcome,
			aliceStored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceStored,
			bobStored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID) === bobStored,
		}, { switched: 'switched', aliceStored: true, bobStored: true });
	});

	test('does not adopt live credentials whose owner is another account', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		const aliceStored = paradisTestCredentials('alice-1', 'alice-r1', harness.clock.now + HOUR);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, aliceStored);
		// ~/.claude.json は Alice だが、キーチェーンには別人のトークン（期限は新しい）が入っている
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('carol-1', 'carol-r1', harness.clock.now + 5 * HOUR));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.oauth.usageByToken.set('carol-1', { kind: 'ok', usage: paradisTestUsage(1) });
		harness.oauth.setProfile('carol-1', 'u-carol', 'carol@example.com');

		await poll(harness.service);
		assert.deepStrictEqual({
			stored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceStored,
			profileChecked: harness.oauth.profileCalls,
		}, { stored: true, profileChecked: ['carol-1'] });
	});

	test('stores and switches only claudeAiOauth, leaving MCP tokens in the live credentials alone', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')]);
		const bobStored = paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + 8 * HOUR);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, bobStored);
		const aliceOauth = { accessToken: 'alice-2', refreshToken: 'alice-r2', expiresAt: harness.clock.now + 2 * HOUR };
		const mcpOAuth = { 'server|abc': { accessToken: 'mcp-secret', refreshToken: 'mcp-refresh' } };
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, JSON.stringify({ claudeAiOauth: aliceOauth, mcpOAuth }));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.oauth.setProfile('alice-2', 'u-alice', 'alice@example.com');

		const result = await harness.service.switchAccount(`para-claude:${BOB_ID}`);
		assert.deepStrictEqual({
			outcome: result.outcome,
			// いまのログインは claudeAiOauth だけが Bob になり、MCP のトークンはそのまま
			live: JSON.parse(harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER)!),
			// 控えに回った Alice の保存分に MCP のトークンは入らない
			aliceStored: JSON.parse(harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID)!),
		}, {
			outcome: 'switched',
			live: { claudeAiOauth: JSON.parse(bobStored).claudeAiOauth, mcpOAuth },
			aliceStored: { claudeAiOauth: aliceOauth },
		});
	});

	test('keeps a refreshed token that could not be saved and saves it on the next read', async () => {
		const harness = await createHarness([record(BOB_ID, 'u-bob', 'bob@example.com')]);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + 60_000));
		const rotated = paradisTestCredentials('bob-2', 'bob-r2', harness.clock.now + 8 * HOUR);
		harness.oauth.refreshByToken.set('bob-r1', { kind: 'ok', credentialsJson: rotated });
		harness.oauth.usageByToken.set('bob-2', { kind: 'ok', usage: paradisTestUsage(3) });

		harness.keychain.failWrites = 1;
		await poll(harness.service);
		const afterFailure = harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID);
		harness.clock.now += 11 * 60_000;
		await poll(harness.service);

		assert.deepStrictEqual({
			stillOld: afterFailure !== rotated,
			savedLater: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID) === rotated,
			// 使用済みのリフレッシュトークンで更新し直さない
			refreshCalls: harness.oauth.refreshCalls,
			usageCalls: harness.oauth.usageCalls,
		}, { stillOld: true, savedLater: true, refreshCalls: ['bob-r1'], usageCalls: ['bob-2', 'bob-2'] });
	});

	test('refuses to write the account list while it cannot be read', async () => {
		const harness = await createHarness([record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		const listPath = path.join(harness.userData, 'accounts.json');
		await fs.promises.writeFile(listPath, '{"version":1,"accounts":[{"id":');
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('bob-1', 'bob-r1', harness.clock.now + HOUR));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-bob', 'bob@example.com') });
		harness.oauth.setProfile('bob-1', 'u-bob', 'bob@example.com');

		const result = await harness.service.registerLiveAccount();
		const removed = await harness.service.removeAccount(`para-claude:${ALICE_ID}`).then(value => value, () => 'refused');
		assert.deepStrictEqual({
			result,
			removed,
			list: await fs.promises.readFile(listPath, 'utf8'),
		}, { result: { outcome: 'failed' }, removed: 'refused', list: '{"version":1,"accounts":[{"id":' });
	});

	test('keeps the post-429 interval after the second success following a long block', async () => {
		const harness = await createHarness([]);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('live', 'live-r', harness.clock.now + 10 * HOUR));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.oauth.usageByToken.set('live', { kind: 'http', status: 429, retryAfterS: 3600 });
		await poll(harness.service);

		// 1 時間 15 分の待ちが明けてから 2 回成功する
		harness.oauth.usageByToken.set('live', { kind: 'ok', usage: paradisTestUsage(10) });
		harness.clock.now += 75 * 60_000 + 1000;
		await poll(harness.service);
		harness.clock.now += 6 * 60_000 + 1000;
		await poll(harness.service);
		const callsAfterSecondSuccess = harness.oauth.usageCalls.length;
		// 2 回目の後も 429 の後の間隔（6 分 × 1.5 = 9 分）が続く。修正前は 5 分に戻っていた
		harness.clock.now += 7 * 60_000;
		await poll(harness.service);

		assert.deepStrictEqual({ callsAfterSecondSuccess, afterSevenMinutes: harness.oauth.usageCalls.length }, { callsAfterSecondSuccess: 3, afterSevenMinutes: 3 });
	});

	test('fetches an account again when it becomes the current login after it needed a re-login', async () => {
		const harness = await createHarness([record(BOB_ID, 'u-bob', 'bob@example.com')]);
		harness.keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, paradisTestCredentials('bob-dead', 'bob-r-dead', harness.clock.now - HOUR));
		harness.oauth.refreshByToken.set('bob-r-dead', { kind: 'invalid_grant' });
		await poll(harness.service);
		const before = (await harness.service.getState(undefined)).claude.accounts.map(account => account.status);

		// ターミナルで `claude /login` して Bob に戻った
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('bob-live', 'bob-r-live', harness.clock.now + HOUR));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-bob', 'bob@example.com') });
		harness.oauth.usageByToken.set('bob-live', { kind: 'ok', usage: paradisTestUsage(12) });
		await poll(harness.service);
		const after = (await harness.service.getState(undefined)).claude.accounts.map(account => ({ status: account.status, active: account.active, fiveHour: account.fiveHour?.usedPercent }));

		assert.deepStrictEqual({ before, after }, { before: ['relogin_required'], after: [{ status: 'ok', active: true, fiveHour: 12 }] });
	});

	test('passive reads from change notifications do not start polling', async () => {
		const harness = await createHarness([]);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, paradisTestCredentials('live', 'live-r', harness.clock.now + HOUR));
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		harness.oauth.usageByToken.set('live', { kind: 'ok', usage: paradisTestUsage(1) });

		await harness.service.getState({ passive: true });
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.deepStrictEqual(harness.oauth.usageCalls, []);
	});

	test('removes login directories and keychain items left behind by an earlier run', async () => {
		const harness = await createHarness([], { withLoginRunner: true });
		const stale = path.join(harness.tmp, 'paradis-claude-login-stale');
		// 起動時の掃除と競っても取りこぼさないよう、項目はディレクトリより先に置く
		harness.keychain.set(ParadisClaudeLiveAuth.scopedKeychainService(stale), USER, 'left-behind');
		const fresh = path.join(harness.tmp, 'paradis-claude-login-fresh');
		const unrelated = path.join(harness.tmp, 'something-else');
		for (const dir of [stale, fresh, unrelated]) {
			await fs.promises.mkdir(dir);
		}
		const old = new Date(harness.clock.now - 2 * HOUR);
		await fs.promises.utimes(stale, old, old);
		await fs.promises.utimes(fresh, new Date(harness.clock.now), new Date(harness.clock.now));
		await fs.promises.utimes(unrelated, old, old);

		// 次の起動（サービスを作ったとき）と同じ掃除を呼ぶ
		await harness.service.cleanStaleLogins();
		assert.deepStrictEqual({
			entries: (await fs.promises.readdir(harness.tmp)).sort(),
			item: harness.keychain.get(ParadisClaudeLiveAuth.scopedKeychainService(stale), USER),
		}, { entries: ['paradis-claude-login-fresh', 'something-else'], item: undefined });
	});
});
