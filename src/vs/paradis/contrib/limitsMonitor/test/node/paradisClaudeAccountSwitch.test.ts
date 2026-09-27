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
import { IParadisClaudeAccountRecord, ParadisClaudeAccountRegistry, ParadisKeychainClaudeSecretStore, PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE } from '../../node/paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService } from '../../node/paradisClaudeAccountService.js';
import { IParadisClaudeLiveSnapshot, ParadisClaudeLiveAuth, PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE } from '../../node/paradisClaudeLiveAuth.js';
import {
	ParadisFakeClaudeOAuth,
	ParadisMemoryKeychain,
	paradisCreateClaudeTestHome,
	paradisReadClaudeGlobalConfig,
	paradisTestCredentials,
	paradisTestOauthAccount,
	paradisWriteClaudeGlobalConfig
} from './paradisClaudeTestUtils.js';

const USER = 'tester';
const HOUR = 3600_000;
const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';
const ALICE = `para-claude:${ALICE_ID}`;
const BOB = `para-claude:${BOB_ID}`;

suite('ParadisClaudeAccountService switching', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	function record(id: string, accountUuid: string, email: string): IParadisClaudeAccountRecord {
		return { id, email, accountUuid, organizationUuid: 'org-1', oauthAccount: paradisTestOauthAccount(accountUuid, email), createdAt: 1, updatedAt: 1 };
	}

	/** 書き終わった直後に失敗する（途中まで書いた状態からの巻き戻しを確かめる）。 */
	class ParadisFailAfterWriteLiveAuth extends ParadisClaudeLiveAuth {
		override async activate(credentialsJson: string, oauthAccount: unknown, snapshot: IParadisClaudeLiveSnapshot): Promise<void> {
			await super.activate(credentialsJson, oauthAccount, snapshot);
			throw new Error('simulated failure after writing');
		}
	}

	async function createHarness(platform: NodeJS.Platform = 'darwin', failAfterWrite = false) {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const keychain = new ParadisMemoryKeychain();
		const oauth = new ParadisFakeClaudeOAuth();
		const registry = new ParadisClaudeAccountRegistry(path.join(dirs.userData, 'accounts.json'));
		await registry.save([record(ALICE_ID, 'u-alice', 'alice@example.com'), record(BOB_ID, 'u-bob', 'bob@example.com')]);
		const liveAuthOptions = { homedir: dirs.home, platform, keychain: platform === 'darwin' ? keychain : undefined, userName: USER, lockTimeoutMs: 300 };
		const service = disposables.add(new ParadisClaudeAccountService({
			liveAuth: failAfterWrite ? new ParadisFailAfterWriteLiveAuth(liveAuthOptions) : new ParadisClaudeLiveAuth(liveAuthOptions),
			registry,
			secrets: new ParadisKeychainClaudeSecretStore(keychain),
			oauth,
			logService: new NullLogService(),
		}));
		const aliceStored = paradisTestCredentials('alice-1', 'alice-r1', Date.now() + HOUR);
		const bobStored = paradisTestCredentials('bob-1', 'bob-r1', Date.now() + 8 * HOUR);
		keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID, aliceStored);
		keychain.set(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, BOB_ID, bobStored);
		return { ...dirs, keychain, oauth, registry, service, aliceStored, bobStored };
	}

	test('switches the PC-wide login and keeps the outgoing account\'s refreshed token', async () => {
		const harness = await createHarness();
		// Claude Code が Alice のトークンを更新して書き戻した状態
		const aliceRefreshed = paradisTestCredentials('alice-2', 'alice-r2', Date.now() + 2 * HOUR);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, aliceRefreshed);
		harness.oauth.setProfile('alice-2', 'u-alice', 'alice@example.com');
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com'), projects: { '/work': { allowedTools: [] } }, numStartups: 3 });

		const result = await harness.service.switchAccount(BOB);
		const config = await paradisReadClaudeGlobalConfig(harness.home);
		const accounts = (await harness.service.getState(undefined)).claude.accounts.map(account => ({ id: account.id, active: account.active }));
		const again = await harness.service.switchAccount(BOB);

		assert.deepStrictEqual({
			result,
			live: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === harness.bobStored,
			aliceStored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) === aliceRefreshed,
			config,
			accounts,
			again: again.outcome,
			// Claude Code のロックは残さない
			locks: (await fs.promises.readdir(harness.home)).filter(name => name.endsWith('.lock')),
		}, {
			result: { outcome: 'switched', email: 'bob@example.com', previousEmail: 'alice@example.com' },
			live: true,
			aliceStored: true,
			// oauthAccount だけを差し替え、ほかの設定はそのまま
			config: { oauthAccount: paradisTestOauthAccount('u-bob', 'bob@example.com'), projects: { '/work': { allowedTools: [] } }, numStartups: 3 },
			accounts: [{ id: ALICE, active: false }, { id: BOB, active: true }],
			again: 'already_active',
			locks: [],
		});
	});

	test('writes ~/.claude/.credentials.json outside macOS', async () => {
		const harness = await createHarness('linux');
		await fs.promises.mkdir(path.join(harness.home, '.claude'));
		// 保存分と同じ（Claude Code が更新していない）ので、控えに回る Alice の確認は要らない
		await fs.promises.writeFile(path.join(harness.home, '.claude', '.credentials.json'), harness.aliceStored);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });

		const result = await harness.service.switchAccount(BOB);
		const credentialsPath = path.join(harness.home, '.claude', '.credentials.json');
		assert.deepStrictEqual({
			outcome: result.outcome,
			file: await fs.promises.readFile(credentialsPath, 'utf8') === harness.bobStored,
			// macOS 以外ではキーチェーンに触れない
			keychainItems: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER),
		}, { outcome: 'switched', file: true, keychainItems: undefined });
	});

	test('refuses to overwrite a login that is not registered in Para Code', async () => {
		const harness = await createHarness();
		const carol = paradisTestCredentials('carol', 'carol-r', Date.now() + HOUR);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, carol);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-carol', 'carol@example.com') });

		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			result,
			live: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === carol,
			config: (await paradisReadClaudeGlobalConfig(harness.home)).oauthAccount,
		}, {
			result: { outcome: 'unmanaged_live', email: 'bob@example.com', previousEmail: 'carol@example.com' },
			live: true,
			config: paradisTestOauthAccount('u-carol', 'carol@example.com'),
		});
	});

	test('rolls back when a write fails and leaves the files untouched when ~/.claude.json is broken', async () => {
		const harness = await createHarness();
		// 保存してあるものと同じ（取り込みの書き込みが起きない）状態にしておく
		const alice = harness.aliceStored;
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, alice);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		const configBefore = await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8');

		// キーチェーンへの書き込みが失敗する
		harness.keychain.failWrites = 1;
		const keychainFailure = await harness.service.switchAccount(BOB);
		const afterKeychainFailure = {
			live: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === alice,
			config: await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8') === configBefore,
		};

		// ~/.claude.json が壊れている（書きかけで途切れた）: 何も書かずに止める
		await fs.promises.writeFile(path.join(harness.home, '.claude.json'), '{"oauthAccount": {"accountUuid": "u-alice", "emailAddress": "alice@example.com"}, "projects": {');
		const brokenConfig = await harness.service.switchAccount(BOB);

		assert.deepStrictEqual({
			keychainFailure,
			afterKeychainFailure,
			brokenConfig,
			liveAfterBroken: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === alice,
			brokenConfigKept: (await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8')).endsWith('"projects": {'),
		}, {
			keychainFailure: { outcome: 'failed', email: 'bob@example.com', rolledBack: true, detail: 'keychain' },
			afterKeychainFailure: { live: true, config: true },
			// 壊れた設定は身元が読めないので「使用中」が分からない。登録していないログインとして扱い、上書きしない
			brokenConfig: { outcome: 'unmanaged_live', email: 'bob@example.com', previousEmail: undefined },
			liveAfterBroken: true,
			brokenConfigKept: true,
		});
	});

	test('restores the keychain, credentials file and config after a failure half-way through', async () => {
		const harness = await createHarness('darwin', true);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, harness.aliceStored);
		await fs.promises.mkdir(path.join(harness.home, '.claude'));
		await fs.promises.writeFile(path.join(harness.home, '.claude', '.credentials.json'), harness.aliceStored);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com'), projects: {} });
		const configBefore = await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8');

		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			result,
			keychain: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === harness.aliceStored,
			// 書く前に無かったハッシュ付きの項目は、戻すときに消す
			scopedKeychain: harness.keychain.get(ParadisClaudeLiveAuth.scopedKeychainService(path.join(harness.home, '.claude')), USER),
			file: await fs.promises.readFile(path.join(harness.home, '.claude', '.credentials.json'), 'utf8') === harness.aliceStored,
			config: await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8') === configBefore,
		}, {
			result: { outcome: 'failed', email: 'bob@example.com', rolledBack: true, detail: 'io' },
			keychain: true,
			scopedKeychain: undefined,
			file: true,
			config: true,
		});
	});

	// Orca と同じく、設定フォルダのハッシュ付きの項目（Claude Code-credentials-<hash>）にも書く。既にあれば
	// その項目の mcpOAuth を残し、無ければハッシュ無しの項目の mcpOAuth を写す。戻すときは両方を戻す。
	test('writes and restores the config-dir scoped keychain item as well', async () => {
		const harness = await createHarness();
		const scopedService = ParadisClaudeLiveAuth.scopedKeychainService(path.join(harness.home, '.claude'));
		// 保存分と同じトークン（Claude Code が更新していない）なので、控えに回る Alice の確認は要らない
		const aliceLive = JSON.stringify({ ...JSON.parse(harness.aliceStored), mcpOAuth: { server: 'legacy' } });
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, aliceLive);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		const switched = await harness.service.switchAccount(BOB);
		const firstScoped = harness.keychain.get(scopedService, USER);
		// 既にあるハッシュ付きの項目は、その項目の mcpOAuth を残す
		harness.keychain.set(scopedService, USER, JSON.stringify({ ...JSON.parse(firstScoped!), mcpOAuth: { server: 'scoped' } }));
		const back = await harness.service.switchAccount(ALICE);
		const read = (service: string) => {
			const value = harness.keychain.get(service, USER);
			const parsed = value === undefined ? undefined : JSON.parse(value);
			return parsed && { accessToken: parsed.claudeAiOauth?.accessToken, mcpOAuth: parsed.mcpOAuth };
		};
		assert.deepStrictEqual({
			outcomes: [switched.outcome, back.outcome],
			firstScoped: firstScoped === undefined ? undefined : { accessToken: JSON.parse(firstScoped).claudeAiOauth?.accessToken, mcpOAuth: JSON.parse(firstScoped).mcpOAuth },
			legacy: read(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE),
			scoped: read(scopedService),
		}, {
			outcomes: ['switched', 'switched'],
			firstScoped: { accessToken: 'bob-1', mcpOAuth: { server: 'legacy' } },
			legacy: { accessToken: 'alice-1', mcpOAuth: { server: 'legacy' } },
			scoped: { accessToken: 'alice-1', mcpOAuth: { server: 'scoped' } },
		});
	});

	test('does not run two switches at once and waits for Claude Code\'s lock', async () => {
		const harness = await createHarness();
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, harness.aliceStored);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });

		// Claude Code がトークンを更新している最中（ロックを持っている）
		await fs.promises.mkdir(path.join(harness.home, '.claude.lock'));
		const first = harness.service.switchAccount(BOB);
		const second = await harness.service.switchAccount(BOB);
		const locked = await first;
		await fs.promises.rmdir(path.join(harness.home, '.claude.lock'));
		const afterRelease = await harness.service.switchAccount(BOB);

		assert.deepStrictEqual({ second: second.outcome, locked: locked.outcome, afterRelease: afterRelease.outcome }, { second: 'busy', locked: 'locked', afterRelease: 'switched' });
	});

	// dotfiles から symlink した `~/.claude.json` は、リンクを残したまま実体を書き換える。
	// 置き換える直前に Claude Code が `~/.claude.json` を書いていたら、読み直してその変更も残す。
	test('keeps a symlinked ~/.claude.json a link and keeps a change Claude Code wrote while switching', async () => {
		const harness = await createHarness();
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, harness.aliceStored);
		const realConfig = path.join(harness.home, 'dotfiles-claude.json');
		await fs.promises.writeFile(realConfig, JSON.stringify({ oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com'), numStartups: 1 }));
		await fs.promises.symlink(realConfig, path.join(harness.home, '.claude.json'));
		// キーチェーンを書いた直後（~/.claude.json を書く前）に Claude Code がプロジェクトの設定を書く
		const write = harness.keychain.write.bind(harness.keychain);
		harness.keychain.write = async (service, account, value) => {
			await write(service, account, value);
			if (service === PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE) {
				await fs.promises.writeFile(realConfig, JSON.stringify({ oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com'), numStartups: 2 }));
			}
		};

		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			outcome: result.outcome,
			isLink: (await fs.promises.lstat(path.join(harness.home, '.claude.json'))).isSymbolicLink(),
			config: JSON.parse(await fs.promises.readFile(realConfig, 'utf8')),
		}, {
			outcome: 'switched',
			isLink: true,
			config: { oauthAccount: paradisTestOauthAccount('u-bob', 'bob@example.com'), numStartups: 2 },
		});
	});

	// CLAUDE_CONFIG_DIR=<home>/.claude で動く Claude Code はハッシュ付きの項目だけを更新する。Orca と同じく
	// ハッシュ付きの項目も読み、新しい方を「いまのログイン」として控えのトークンに取り込む（持ち主の確認も通す）。
	test('takes the newer token from the scoped keychain item when switching away', async () => {
		const harness = await createHarness();
		const scopedService = ParadisClaudeLiveAuth.scopedKeychainService(path.join(harness.home, '.claude'));
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, harness.aliceStored);
		const aliceRefreshed = paradisTestCredentials('alice-2', 'alice-r2', Date.now() + 2 * HOUR);
		harness.keychain.set(scopedService, USER, aliceRefreshed);
		harness.oauth.setProfile('alice-2', 'u-alice', 'alice@example.com');
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });

		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			outcome: result.outcome,
			// 控えに回る Alice の保存分は、ハッシュ付きの項目にあった新しいトークン
			aliceStored: JSON.parse(harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, ALICE_ID) ?? '{}').claudeAiOauth?.refreshToken,
		}, { outcome: 'switched', aliceStored: 'alice-r2' });
	});

	// 書く前からあったハッシュ付きの項目は、失敗したら元の値へ戻す。2つ目（ハッシュ付き）の書き込みで
	// 失敗しても、1つ目（ハッシュ無し）を戻す。
	test('restores both keychain items when the scoped write fails or a later step fails', async () => {
		const harness = await createHarness();
		const scopedService = ParadisClaudeLiveAuth.scopedKeychainService(path.join(harness.home, '.claude'));
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, harness.aliceStored);
		const scopedBefore = JSON.stringify({ ...JSON.parse(harness.aliceStored), mcpOAuth: { server: 'scoped' } });
		harness.keychain.set(scopedService, USER, scopedBefore);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		// ハッシュ付きの項目への書き込み（2つ目）だけを失敗させる
		const write = harness.keychain.write.bind(harness.keychain);
		harness.keychain.write = async (service, account, value) => {
			if (service === scopedService && value !== scopedBefore) {
				throw new Error('scoped write failed');
			}
			return write(service, account, value);
		};

		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			outcome: result.outcome,
			rolledBack: result.outcome === 'failed' ? result.rolledBack : undefined,
			legacy: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === harness.aliceStored,
			scoped: harness.keychain.get(scopedService, USER) === scopedBefore,
		}, { outcome: 'failed', rolledBack: true, legacy: true, scoped: true });
	});

	test('restores a scoped keychain item that existed before when a later step fails', async () => {
		const harness = await createHarness('darwin', true);
		const scopedService = ParadisClaudeLiveAuth.scopedKeychainService(path.join(harness.home, '.claude'));
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, harness.aliceStored);
		const scopedBefore = JSON.stringify({ ...JSON.parse(harness.aliceStored), mcpOAuth: { server: 'scoped' } });
		harness.keychain.set(scopedService, USER, scopedBefore);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		const result = await harness.service.switchAccount(BOB);
		assert.deepStrictEqual({
			outcome: result.outcome,
			legacy: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === harness.aliceStored,
			scoped: harness.keychain.get(scopedService, USER) === scopedBefore,
		}, { outcome: 'failed', legacy: true, scoped: true });
	});

	// Claude Code は安全な保存先（キーチェーン）を `~/.claude/.storage-write.lock`（proper-lockfile、
	// 15 秒で古いとみなす）の中で読み直して書く。切り替えも同じロックの中で書き、持ち主がいる間は
	// 書かずに `locked` で止める。15 秒より古いロックは持ち主がいないとみなして取る。
	test('writes the keychain and ~/.claude.json only while holding Claude Code\'s .storage-write lock', async () => {
		const harness = await createHarness();
		const lockPath = path.join(harness.home, '.claude', '.storage-write.lock');
		const heldWhileWriting: boolean[] = [];
		const write = harness.keychain.write.bind(harness.keychain);
		harness.keychain.write = async (service, account, value) => {
			if (service.startsWith(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE)) {
				heldWhileWriting.push(fs.existsSync(lockPath));
			}
			return write(service, account, value);
		};
		// 保存分と同じトークンにする（別の時刻で作ると、控えに回る Alice の確認が要って止まる）
		const aliceLive = harness.aliceStored;
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, aliceLive);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		const configBefore = await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8');

		// Claude Code が保存先を書いている最中
		await fs.promises.mkdir(lockPath, { recursive: true });
		const locked = await harness.service.switchAccount(BOB);
		const untouched = {
			keychain: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === aliceLive,
			config: await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8') === configBefore,
		};
		// 持ち主が落ちて 15 秒以上更新されていないロック
		const old = new Date(Date.now() - 20_000);
		await fs.promises.utimes(lockPath, old, old);
		const afterStale = await harness.service.switchAccount(BOB);

		assert.deepStrictEqual({
			locked: locked.outcome,
			untouched,
			afterStale: afterStale.outcome,
			heldWhileWriting,
			released: fs.existsSync(lockPath),
		}, {
			locked: 'locked',
			untouched: { keychain: true, config: true },
			afterStale: 'switched',
			// ハッシュ無しとハッシュ付きの2つの項目
			heldWhileWriting: [true, true],
			released: false,
		});
	});
});
