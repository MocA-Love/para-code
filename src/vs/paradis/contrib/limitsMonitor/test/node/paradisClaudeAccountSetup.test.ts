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
import { IParadisLimitsSetupState } from '../../common/paradisLimitsMonitor.js';
import { ParadisClaudeAccountRegistry, ParadisEncryptedFileClaudeSecretStore, ParadisKeychainClaudeSecretStore, PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE } from '../../node/paradisClaudeAccountStore.js';
import { ParadisClaudeAccountService } from '../../node/paradisClaudeAccountService.js';
import { ParadisClaudeLiveAuth, PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE } from '../../node/paradisClaudeLiveAuth.js';
import {
	ParadisFakeClaudeLoginRunner,
	ParadisFakeClaudeOAuth,
	ParadisMemoryKeychain,
	paradisCreateClaudeTestHome,
	paradisTestCredentials,
	paradisTestOauthAccount,
	paradisWriteClaudeGlobalConfig
} from './paradisClaudeTestUtils.js';

const USER = 'tester';
const HOUR = 3600_000;

suite('ParadisClaudeAccountService setup', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	async function createHarness(onLogin: (configDir: string, keychain: ParadisMemoryKeychain, signal: AbortSignal) => Promise<void>) {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const tmp = path.join(dirs.userData, 'tmp');
		await fs.promises.mkdir(tmp);
		const keychain = new ParadisMemoryKeychain();
		const runner = new ParadisFakeClaudeLoginRunner((configDir, signal) => onLogin(configDir, keychain, signal));
		const registry = new ParadisClaudeAccountRegistry(path.join(dirs.userData, 'accounts.json'), 'darwin');
		const service = disposables.add(new ParadisClaudeAccountService({
			liveAuth: new ParadisClaudeLiveAuth({ homedir: dirs.home, platform: 'darwin', keychain, userName: USER }),
			registry,
			secrets: new ParadisKeychainClaudeSecretStore(keychain),
			oauth: new ParadisFakeClaudeOAuth(),
			logService: new NullLogService(),
			loginRunner: runner,
			tmpdir: tmp,
		}));
		return { ...dirs, tmp, keychain, runner, registry, service };
	}

	async function waitForSetup(service: ParadisClaudeAccountService, sessionId: string): Promise<IParadisLimitsSetupState> {
		for (let i = 0; i < 200; i++) {
			const state = service.getSetupState(sessionId);
			if (state.phase === 'done' || state.phase === 'error') {
				return state;
			}
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		throw new Error('setup did not finish');
	}

	/** 新しい Claude Code と同じく、一時ディレクトリ用のキーチェーン項目と .claude.json へ書く。 */
	function scopedLogin(accountUuid: string, email: string, token: string) {
		return async (configDir: string, keychain: ParadisMemoryKeychain) => {
			keychain.set(ParadisClaudeLiveAuth.scopedKeychainService(configDir), USER, paradisTestCredentials(token, `${token}-refresh`, Date.now() + HOUR));
			await fs.promises.writeFile(path.join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: paradisTestOauthAccount(accountUuid, email) }));
		};
	}

	test('adds an account from a login into a temporary config dir without touching the current login', async () => {
		const harness = await createHarness(scopedLogin('u-bob', 'bob@example.com', 'bob-token'));
		const liveCredentials = paradisTestCredentials('alice-live', 'alice-r', Date.now() + HOUR);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, liveCredentials);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });
		const configBefore = await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8');

		const state = await waitForSetup(harness.service, harness.service.startLogin(undefined).sessionId);
		const records = await harness.registry.load();
		assert.deepStrictEqual({
			state: { phase: state.phase, email: state.email, url: state.url },
			records: records.map(record => ({ email: record.email, accountUuid: record.accountUuid })),
			stored: JSON.parse(harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, records[0].id)!).claudeAiOauth.accessToken,
			// いまのログインは変わらない
			live: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === liveCredentials,
			config: await fs.promises.readFile(path.join(harness.home, '.claude.json'), 'utf8') === configBefore,
			// 一時ディレクトリとその項目は残さない
			tempDirs: await fs.promises.readdir(harness.tmp),
			scopedItem: harness.keychain.get(ParadisClaudeLiveAuth.scopedKeychainService(harness.runner.configDirs[0]), USER),
		}, {
			state: { phase: 'done', email: 'bob@example.com', url: 'https://claude.ai/oauth/authorize?code=true' },
			records: [{ email: 'bob@example.com', accountUuid: 'u-bob' }],
			stored: 'bob-token',
			live: true,
			config: true,
			tempDirs: [],
			scopedItem: undefined,
		});
	});

	test('restores the default keychain item when an older Claude Code wrote the new login there', async () => {
		const liveCredentials = paradisTestCredentials('alice-live', 'alice-r', Date.now() + HOUR);
		const bobCredentials = paradisTestCredentials('bob-token', 'bob-r', Date.now() + HOUR);
		const harness = await createHarness(async (configDir, keychain) => {
			keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, bobCredentials);
			await fs.promises.writeFile(path.join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: paradisTestOauthAccount('u-bob', 'bob@example.com') }));
		});
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, liveCredentials);

		const state = await waitForSetup(harness.service, harness.service.startLogin(undefined).sessionId);
		const [record] = await harness.registry.load();
		assert.deepStrictEqual({
			phase: state.phase,
			stored: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, record.id),
			live: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER),
		}, { phase: 'done', stored: bobCredentials, live: liveCredentials });
	});

	test('re-login keeps the account id and refuses a different account', async () => {
		let who = { uuid: 'u-bob', email: 'bob@example.com', token: 'bob-1' };
		const harness = await createHarness((configDir, keychain) => scopedLogin(who.uuid, who.email, who.token)(configDir, keychain));
		await waitForSetup(harness.service, harness.service.startLogin(undefined).sessionId);
		const [record] = await harness.registry.load();
		const managedId = `para-claude:${record.id}`;

		who = { uuid: 'u-bob', email: 'bob@example.com', token: 'bob-2' };
		const again = await waitForSetup(harness.service, harness.service.startLogin(managedId).sessionId);
		who = { uuid: 'u-carol', email: 'carol@example.com', token: 'carol-1' };
		const wrong = await waitForSetup(harness.service, harness.service.startLogin(managedId).sessionId);

		assert.deepStrictEqual({
			again: again.phase,
			wrong: wrong.error,
			records: (await harness.registry.load()).map(entry => entry.id),
			stored: JSON.parse(harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, record.id)!).claudeAiOauth.accessToken,
		}, { again: 'done', wrong: 'different_account', records: [record.id], stored: 'bob-2' });
	});

	test('reports a cancelled login and a login that produced no credentials', async () => {
		let loginStarted: () => void = () => { };
		const started = new Promise<void>(resolve => { loginStarted = resolve; });
		const harness = await createHarness((_configDir, _keychain, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('cancelled')));
			loginStarted();
		}));
		const pending = harness.service.startLogin(undefined).sessionId;
		await started;
		harness.service.cancelSetup(pending);
		await new Promise(resolve => setTimeout(resolve, 50));

		const empty = await createHarnessWithoutCredentials();
		const state = await waitForSetup(empty.service, empty.service.startLogin(undefined).sessionId);
		assert.deepStrictEqual({
			cancelledRemoved: harness.service.getSetupState(pending).error,
			tempDirs: await fs.promises.readdir(harness.tmp),
			empty: state.error,
		}, { cancelledRemoved: 'not_found', tempDirs: [], empty: 'no_credentials' });

		async function createHarnessWithoutCredentials() {
			const previous = cleanup;
			const created = await createHarness(async () => undefined);
			const own = cleanup;
			cleanup = async () => { await own?.(); await previous?.(); };
			return created;
		}
	});

	test('registers the current login and removes a registration without logging out', async () => {
		const harness = await createHarness(async () => undefined);
		const liveCredentials = paradisTestCredentials('alice-live', 'alice-r', Date.now() + HOUR);
		harness.keychain.set(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER, liveCredentials);
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com') });

		const first = await harness.service.registerLiveAccount();
		const second = await harness.service.registerLiveAccount();
		const [record] = await harness.registry.load();
		const stored = harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, record.id);
		const accountsBefore = (await harness.service.getState(undefined)).claude.accounts.map(account => ({ id: account.id, active: account.active, managed: account.managed }));
		const removed = await harness.service.removeAccount(`para-claude:${record.id}`);

		assert.deepStrictEqual({
			first,
			second,
			stored: stored === liveCredentials,
			accountsBefore,
			removed,
			recordsAfter: await harness.registry.load(),
			storedAfter: harness.keychain.get(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, record.id),
			liveAfter: harness.keychain.get(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, USER) === liveCredentials,
			rejectsBadId: await harness.service.removeAccount('../../etc'),
		}, {
			first: { outcome: 'registered', email: 'alice@example.com' },
			second: { outcome: 'updated', email: 'alice@example.com' },
			stored: true,
			accountsBefore: [{ id: `para-claude:${record.id}`, active: true, managed: true }],
			removed: true,
			recordsAfter: [],
			storedAfter: undefined,
			liveAfter: true,
			rejectsBadId: false,
		});
	});
});

suite('ParadisEncryptedFileClaudeSecretStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stores only encrypted text, refuses to store without OS encryption and rejects foreign ids', async () => {
		const dirs = await paradisCreateClaudeTestHome();
		try {
			let available = true;
			const encryption = {
				isEncryptionAvailable: async () => available,
				encrypt: async (value: string) => `enc:${Buffer.from(value).toString('base64')}`,
				decrypt: async (value: string) => Buffer.from(value.slice(4), 'base64').toString(),
			};
			const directory = path.join(dirs.userData, 'secrets');
			const store = new ParadisEncryptedFileClaudeSecretStore(directory, encryption, 'linux');
			const id = '33333333-3333-4333-8333-333333333333';
			const secret = paradisTestCredentials('a', 'r', 1);
			await store.write(id, secret);
			const onDisk = await fs.promises.readFile(path.join(directory, `${id}.enc`), 'utf8');
			const readBack = await store.read(id);
			available = false;
			const refused = await store.write(id, 'other').then(() => 'stored', () => 'refused');
			const foreign = await store.read('../../escape').then(() => 'read', () => 'rejected');
			await store.delete(id);
			assert.deepStrictEqual({
				plaintextOnDisk: onDisk.includes('claudeAiOauth'),
				readBack: readBack === secret,
				refused,
				foreign,
				afterDelete: await store.read(id),
				fileMode: process.platform === 'win32' ? 0o600 : (await fs.promises.stat(directory)).mode & 0o077,
			}, { plaintextOnDisk: false, readBack: true, refused: 'refused', foreign: 'rejected', afterDelete: undefined, fileMode: process.platform === 'win32' ? 0o600 : 0 });
		} finally {
			await dirs.dispose();
		}
	});
});

suite('ParadisClaudeAccountService claude-swap migration', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('lists claude-swap accounts that are not registered yet and never writes to its data', async () => {
		const dirs = await paradisCreateClaudeTestHome();
		try {
			const cswapDir = path.join(dirs.home, '.claude-swap-backup');
			await fs.promises.mkdir(cswapDir);
			const sequencePath = path.join(cswapDir, 'sequence.json');
			const sequence = JSON.stringify({
				activeAccountNumber: 1,
				accounts: {
					'1': { email: 'alice@example.com', organizationUuid: 'org-1', organizationName: 'Alice Org', uuid: 'u-alice' },
					'2': { email: 'bob@example.com', organizationUuid: 'org-1', organizationName: 'Bob Org', uuid: 'u-bob' },
				},
			});
			await fs.promises.writeFile(sequencePath, sequence);
			const statBefore = await fs.promises.stat(sequencePath);
			const keychain = new ParadisMemoryKeychain();
			const registry = new ParadisClaudeAccountRegistry(path.join(dirs.userData, 'accounts.json'), 'darwin');
			await registry.save([{ id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', accountUuid: 'u-alice', organizationUuid: 'org-1', oauthAccount: paradisTestOauthAccount('u-alice', 'alice@example.com'), createdAt: 1, updatedAt: 1 }]);
			const service = disposables.add(new ParadisClaudeAccountService({
				liveAuth: new ParadisClaudeLiveAuth({ homedir: dirs.home, platform: 'darwin', keychain, userName: USER }),
				registry,
				secrets: new ParadisKeychainClaudeSecretStore(keychain),
				oauth: new ParadisFakeClaudeOAuth(),
				logService: new NullLogService(),
				legacyCswapDirs: [path.join(dirs.home, 'missing'), cswapDir],
			}));

			const state = await service.getState(undefined);
			await service.pollDue();
			const statAfter = await fs.promises.stat(sequencePath);
			assert.deepStrictEqual({
				legacy: state.claude.legacyAccounts,
				unchanged: await fs.promises.readFile(sequencePath, 'utf8') === sequence && statAfter.mtimeMs === statBefore.mtimeMs,
				entries: await fs.promises.readdir(cswapDir),
			}, {
				legacy: [{ email: 'bob@example.com', organizationName: 'Bob Org' }],
				unchanged: true,
				entries: ['sequence.json'],
			});
		} finally {
			await dirs.dispose();
		}
	});
});
