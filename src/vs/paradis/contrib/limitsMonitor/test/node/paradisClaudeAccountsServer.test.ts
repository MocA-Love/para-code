/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）での Claude のアカウント。HOME・ユーザーデータは一時ディレクトリで、本物の
// ~/.claude・キーチェーン・API・claude には触れない。

import assert from 'assert';
import * as fs from 'fs';
import * as path from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisClaudeAccountsState, PARADIS_CLAUDE_HOST_ACCOUNT_ID, paradisClaudeActiveLoginState } from '../../common/paradisClaudeAccounts.js';
import { paradisConnectionClientId } from '../../../../common/paradisConnectionClient.js';
import { IParadisLimitsSetupHandle, IParadisLimitsSetupState } from '../../common/paradisLimitsMonitor.js';
import { paradisClaudeHostSwitchingSupported } from '../../node/paradisClaudeAccounts.server.js';
import { IParadisClaudeAccountRecord, ParadisClaudeAccountRegistry, ParadisPlainFileClaudeSecretStore } from '../../node/paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService, ParadisClaudeAccountsChannel } from '../../node/paradisClaudeAccountService.js';
import { ParadisClaudeHostUsage, paradisSetClaudeHostStateSource } from '../../node/paradisClaudeHostUsage.js';
import { paradisAcquireClaudeDirectoryLock, ParadisClaudeLiveAuth } from '../../node/paradisClaudeLiveAuth.js';
import {
	ParadisFakeClaudeLoginRunner,
	ParadisFakeClaudeOAuth,
	paradisCreateClaudeTestHome,
	paradisTestCredentials,
	paradisTestOauthAccount,
	paradisTestUsage,
	paradisWriteClaudeGlobalConfig
} from './paradisClaudeTestUtils.js';

const HOUR = 3600_000;
const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';

suite('ParadisClaudeAccounts on the SSH host', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	function record(id: string, accountUuid: string, email: string): IParadisClaudeAccountRecord {
		return { id, email, accountUuid, organizationUuid: 'org-1', oauthAccount: paradisTestOauthAccount(accountUuid, email), createdAt: 1, updatedAt: 1 };
	}

	/** 書き込みを指定の回数だけ失敗させる（更新したトークンを保存できなかった状態を作る）。 */
	class ParadisFlakySecretStore extends ParadisPlainFileClaudeSecretStore {
		failWrites = 0;
		override async write(accountId: string, credentialsJson: string): Promise<void> {
			if (this.failWrites > 0) {
				this.failWrites--;
				throw new Error('disk full');
			}
			return super.write(accountId, credentialsJson);
		}
	}

	/** 保存してある認証情報の読み出し（手元に持っている保存し直し待ちの値を含む）をテストから呼ぶ。 */
	class ParadisTestableService extends ParadisClaudeAccountService {
		readSecretForTest(accountId: string): Promise<string | undefined> {
			return this.readSecret(accountId);
		}
	}

	/** 接続先と同じ組み立て（Linux、キーチェーン無し、平文のファイル、プロセスをまたいだロック）。 */
	async function createHost() {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const storageDir = path.join(dirs.userData, 'paradis-claude-accounts');
		const tmp = path.join(dirs.userData, 'tmp');
		await fs.promises.mkdir(tmp);
		const oauth = new ParadisFakeClaudeOAuth();
		let finishLogin: () => void = () => { };
		const runner = new ParadisFakeClaudeLoginRunner(async (configDir, signal) => {
			await new Promise<void>((resolve, reject) => {
				finishLogin = resolve;
				signal.addEventListener('abort', () => reject(new Error('aborted')));
			});
			await fs.promises.writeFile(path.join(configDir, '.credentials.json'), paradisTestCredentials('carol-1', 'carol-r1', Date.now() + HOUR));
			await paradisWriteClaudeGlobalConfig(configDir, { oauthAccount: paradisTestOauthAccount('u-carol', 'carol@example.com') });
		});
		const create = (secrets = new ParadisFlakySecretStore(path.join(storageDir, 'secrets'))) => disposables.add(new ParadisTestableService({
			liveAuth: new ParadisClaudeLiveAuth({ homedir: dirs.home, platform: 'linux', keychain: undefined, userName: undefined, lockTimeoutMs: 300 }),
			registry: new ParadisClaudeAccountRegistry(path.join(storageDir, 'accounts.json')),
			secrets,
			oauth,
			logService: new NullLogService(),
			loginRunner: runner,
			tmpdir: tmp,
			crossProcessLockPath: path.join(storageDir, '.mutation.lock'),
		}));
		return { ...dirs, storageDir, oauth, create, finishLogin: () => finishLogin() };
	}

	test('keeps each credential in a file only the user can read, and refuses to write through a symbolic link', async function () {
		if (isWindows) {
			this.skip();
		}
		const host = await createHost();
		const secrets = new ParadisPlainFileClaudeSecretStore(path.join(host.storageDir, 'secrets'));
		await secrets.write(ALICE_ID, 'alice');
		const file = path.join(host.storageDir, 'secrets', `${ALICE_ID}.json`);
		await fs.promises.chmod(file, 0o644);
		await secrets.write(ALICE_ID, 'alice-2');
		const mode = (await fs.promises.stat(file)).mode & 0o777;
		const directoryMode = (await fs.promises.stat(path.join(host.storageDir, 'secrets'))).mode & 0o777;
		await fs.promises.symlink(path.join(host.userData, 'elsewhere.json'), path.join(host.storageDir, 'secrets', `${BOB_ID}.json`));
		const symlinkRejected = await secrets.write(BOB_ID, 'bob').then(() => false, () => true);
		const read = await secrets.read(ALICE_ID);
		await secrets.delete(ALICE_ID);
		assert.deepStrictEqual({ mode, directoryMode, symlinkRejected, read, afterDelete: await secrets.read(ALICE_ID), leaked: fs.existsSync(path.join(host.userData, 'elsewhere.json')) }, {
			mode: 0o600,
			directoryMode: 0o700,
			symlinkRejected: true,
			read: 'alice-2',
			afterDelete: undefined,
			leaked: false,
		});
	});

	// 更新の直後は古い版の REH が同じユーザーデータを読み書きする。覚えている一覧で書き戻さず、
	// ロックを持たれている間は書き換えを待つ。
	test('sees the other process\'s list changes and waits for its lock before changing anything', async () => {
		const host = await createHost();
		await new ParadisClaudeAccountRegistry(path.join(host.storageDir, 'accounts.json')).save([record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')]);
		const current = host.create();
		const older = host.create();
		const emails = (state: IParadisClaudeAccountsState) => state.claude.accounts.map(account => account.email);
		const before = emails(await current.getState({ passive: true }));
		await older.removeAccount(`para-claude:${BOB_ID}`);
		const afterOtherRemoved = emails(await current.getState({ passive: true }));

		const lockPath = path.join(host.storageDir, '.mutation.lock');
		await fs.promises.mkdir(lockPath);
		let removed = false;
		const removal = current.removeAccount(`para-claude:${ALICE_ID}`).then(result => { removed = result; });
		await new Promise(resolve => setTimeout(resolve, 300));
		const removedWhileLocked = removed;
		await fs.promises.rmdir(lockPath);
		await removal;
		assert.deepStrictEqual({ before, afterOtherRemoved, removedWhileLocked, removed, lockLeft: fs.existsSync(lockPath) }, {
			before: ['alice@example.com', 'bob@example.com'],
			afterOtherRemoved: ['alice@example.com'],
			removedWhileLocked: false,
			removed: true,
			lockLeft: false,
		});
	});

	// REH では全ウィンドウの clientId が同じ 'renderer'。接続（context のオブジェクト）で持ち主を見分ける。
	test('adds an account on the host, and only the connection that started it can see or cancel the login', async () => {
		const host = await createHost();
		const service = host.create();
		const channel = new ParadisClaudeAccountsChannel<unknown>(service);
		const windowA = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const windowB = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const { sessionId } = await channel.call<IParadisLimitsSetupHandle>(windowA, 'startLogin', []);
		let own = await channel.call<IParadisLimitsSetupState>(windowA, 'getSetupState', [sessionId]);
		for (let i = 0; i < 100 && own.url === undefined; i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
			own = await channel.call<IParadisLimitsSetupState>(windowA, 'getSetupState', [sessionId]);
		}
		const seenByOther = await channel.call<IParadisLimitsSetupState>(windowB, 'getSetupState', [sessionId]);
		await channel.call(windowB, 'cancelSetup', [sessionId]);
		host.finishLogin();
		let done = own;
		for (let i = 0; i < 200 && done.phase !== 'done' && done.phase !== 'error'; i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
			done = await channel.call<IParadisLimitsSetupState>(windowA, 'getSetupState', [sessionId]);
		}
		const records = await new ParadisClaudeAccountRegistry(path.join(host.storageDir, 'accounts.json')).load();
		const secretFiles = await fs.promises.readdir(path.join(host.storageDir, 'secrets'));
		assert.deepStrictEqual({
			ownUrl: own.url,
			seenByOther,
			done: [done.phase, done.email],
			registered: records.map(entry => entry.email),
			secretFiles: secretFiles.length,
			liveLoginWritten: fs.existsSync(path.join(host.home, '.claude', '.credentials.json')),
		}, {
			ownUrl: 'https://claude.ai/oauth/authorize?code=true',
			seenByOther: { phase: 'error', error: 'not_found' },
			done: ['done', 'carol@example.com'],
			registered: ['carol@example.com'],
			secretFiles: 1,
			liveLoginWritten: false,
		});
	});

	// リロードしたウィンドウは別の接続になり、前の手続きを取り消せない。接続が切れたら止めて、次の追加を
	// 「使用中」で断り続けないようにする。
	test('stops a login when the connection that started it goes away, so another window can add an account', async () => {
		const host = await createHost();
		const service = host.create();
		const channel = new ParadisClaudeAccountsChannel<unknown>(service);
		const windowA = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const windowB = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const first = await channel.call<IParadisLimitsSetupHandle>(windowA, 'startLogin', []);
		const whileRunning = await channel.call<IParadisLimitsSetupHandle>(windowB, 'startLogin', []);
		await new Promise(resolve => setTimeout(resolve, 20));
		const blocked = await channel.call<IParadisLimitsSetupState>(windowB, 'getSetupState', [whileRunning.sessionId]);
		service.abortSetupsOwnedBy(paradisConnectionClientId(windowA)!);
		await new Promise(resolve => setTimeout(resolve, 20));
		const second = await channel.call<IParadisLimitsSetupHandle>(windowB, 'startLogin', []);
		let state = await channel.call<IParadisLimitsSetupState>(windowB, 'getSetupState', [second.sessionId]);
		for (let i = 0; i < 100 && state.url === undefined && state.phase !== 'error'; i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
			state = await channel.call<IParadisLimitsSetupState>(windowB, 'getSetupState', [second.sessionId]);
		}
		await channel.call(windowB, 'cancelSetup', [second.sessionId]);
		assert.deepStrictEqual({
			blocked: blocked.error,
			firstGone: (await channel.call<IParadisLimitsSetupState>(windowA, 'getSetupState', [first.sessionId])).error,
			secondStarted: [state.phase, state.url],
		}, {
			blocked: 'busy',
			firstGone: 'not_found',
			secondStarted: ['waiting_browser', 'https://claude.ai/oauth/authorize?code=true'],
		});
	});

	// 保存できずに手元に持っていたトークンより新しいものを、別のプロセスが保存していたら、手元の古い方
	// （リフレッシュトークンは相手の更新で使用済み）で上書きしない。
	test('drops a token it could not save once the other process has saved a newer one', async () => {
		const host = await createHost();
		await new ParadisClaudeAccountRegistry(path.join(host.storageDir, 'accounts.json')).save([record(ALICE_ID, 'u-alice', 'alice@example.com')]);
		const store = new ParadisFlakySecretStore(path.join(host.storageDir, 'secrets'));
		await store.write(ALICE_ID, paradisTestCredentials('alice-1', 'alice-r1', Date.now() + 60_000));
		const refreshed = paradisTestCredentials('alice-2', 'alice-r2', Date.now() + HOUR);
		host.oauth.refreshByToken.set('alice-r1', { kind: 'ok', credentialsJson: refreshed });
		host.oauth.usageByToken.set('alice-2', { kind: 'ok', usage: paradisTestUsage(10) });
		const service = host.create(store);
		store.failWrites = 1;
		await service.pollDue();
		const keptLocally = await service.readSecretForTest(ALICE_ID);
		// 別のプロセスは同じロックの中で保存する
		const newer = paradisTestCredentials('alice-3', 'alice-r3', Date.now() + 2 * HOUR);
		const release = await paradisAcquireClaudeDirectoryLock(path.join(host.storageDir, '.mutation.lock'), 30_000, 5_000);
		await new ParadisPlainFileClaudeSecretStore(path.join(host.storageDir, 'secrets')).write(ALICE_ID, newer);
		await release();
		const afterOtherSaved = await service.readSecretForTest(ALICE_ID);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual({
			refreshed: host.oauth.refreshCalls,
			keptLocally,
			afterOtherSaved,
			onDisk: await store.read(ALICE_ID),
		}, {
			refreshed: ['alice-r1'],
			keptLocally: refreshed,
			afterOtherSaved: newer,
			onDisk: newer,
		});
	});

	test('switches only where the login is in ~/.claude/.credentials.json and Claude Code uses the default config folder', () => {
		assert.deepStrictEqual({
			linux: paradisClaudeHostSwitchingSupported('linux', '/home/u', undefined),
			linuxDefaultDir: paradisClaudeHostSwitchingSupported('linux', '/home/u', '/home/u/.claude/'),
			linuxOtherDir: paradisClaudeHostSwitchingSupported('linux', '/home/u', '/home/u/.claude-work'),
			mac: paradisClaudeHostSwitchingSupported('darwin', '/Users/u', undefined),
		}, {
			linux: true,
			linuxDefaultDir: true,
			linuxOtherDir: false,
			mac: false,
		});
	});

	// スマホが接続先のログインを見る口は、切り替えのサービスが取った結果を使い、自分では取りに行かない。
	test('the read-only host view shows only the current login from the account service, without fetching again', async () => {
		const host = await createHost();
		const oauth = new ParadisFakeClaudeOAuth();
		const hostUsage = new ParadisClaudeHostUsage({ homedir: host.home, platform: 'linux', oauth, logService: new NullLogService() });
		const accounts: IParadisClaudeAccountsState = {
			claude: {
				accounts: [
					{ provider: 'claude', id: `para-claude:${ALICE_ID}`, email: 'alice@example.com', status: 'ok', active: true, managed: true, fetchedAt: 5 },
					{ provider: 'claude', id: `para-claude:${BOB_ID}`, email: 'bob@example.com', status: 'ok', managed: true },
				],
			},
			switching: false,
		};
		const registration = paradisSetClaudeHostStateSource(async () => accounts);
		const delegated = await hostUsage.getState({ refresh: true });
		registration.dispose();
		const noneActive = paradisClaudeActiveLoginState({ claude: { accounts: [accounts.claude.accounts[1]] }, switching: false }, '~/.claude');
		assert.deepStrictEqual({ delegated, noneActive, fetched: oauth.usageCalls.length }, {
			delegated: {
				claude: { accounts: [{ provider: 'claude', id: PARADIS_CLAUDE_HOST_ACCOUNT_ID, email: 'alice@example.com', status: 'ok', active: true, managed: true, fetchedAt: 5, homeLabel: '~/.claude' }] },
				oldestFetchedAt: 5,
				switching: false,
			},
			noneActive: { claude: { accounts: [{ provider: 'claude', id: PARADIS_CLAUDE_HOST_ACCOUNT_ID, homeLabel: '~/.claude', status: 'no_credentials' }] }, switching: false },
			fetched: 0,
		});
	});
});
