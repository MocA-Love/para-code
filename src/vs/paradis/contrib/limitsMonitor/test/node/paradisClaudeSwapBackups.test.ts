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
import { IParadisKeychain, ParadisKeychainError } from '../../node/paradisClaudeKeychain.js';
import { ParadisClaudeSwapBackupReader } from '../../node/paradisClaudeSwapBackups.js';
import { ParadisMemoryKeychain, paradisCreateClaudeTestHome, paradisTestCredentials } from './paradisClaudeTestUtils.js';

suite('ParadisClaudeSwapBackupReader', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	test('collects the refresh tokens of every claude-swap backup location and treats none found as unknown', async () => {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const dataDir = path.join(dirs.home, '.claude-swap-backup');
		const credentialsDir = path.join(dataDir, 'credentials');
		await fs.promises.mkdir(credentialsDir, { recursive: true });
		const encode = (json: string) => Buffer.from(json, 'utf8').toString('base64');
		await fs.promises.writeFile(path.join(credentialsDir, '.creds-2-bob@example.com.enc'), encode(paradisTestCredentials('a1', 'file-r', 10)));
		await fs.promises.writeFile(path.join(credentialsDir, '.creds-2-bob@example.com.enc.prev'), encode(paradisTestCredentials('a0', 'file-prev', 5)));
		const keychain = new ParadisMemoryKeychain();
		keychain.set('claude-swap', 'account-2-bob@example.com', paradisTestCredentials('a2', 'keychain-r', 20));
		keychain.set('claude-swap', 'account-2-bob@example.com.prev', 'not json');
		// 古い版（python の keyring）の置き場所と、番号の代わりに None の付いた別名
		keychain.set('claude-code', 'account-2-bob@example.com', paradisTestCredentials('a3', 'legacy-r', 30));
		keychain.set('claude-code', 'account-None-carol@example.com', paradisTestCredentials('a4', 'alias-r', 40));
		const reader = new ParadisClaudeSwapBackupReader(keychain);
		const tokens = async (target: ParadisClaudeSwapBackupReader, slot: string, email: string) => (await target.readBackups(dataDir, slot, email))?.map(backup => `${backup.refreshToken}@${backup.expiresAt}`);

		const found = await tokens(reader, '2', 'bob@example.com');
		const alias = await tokens(reader, '3', 'carol@example.com');
		// sequence.json に載っているのに1つも見つからない（置き場所を知らない版かもしれない）
		const missing = await tokens(reader, '4', 'dave@example.com');
		const withoutKeychain = await tokens(new ParadisClaudeSwapBackupReader(undefined), '2', 'bob@example.com');
		// 番号やメールがパスとして怪しいときは読まない（読めない扱い）
		const badSlot = await tokens(reader, '../2', 'bob@example.com');
		const badEmail = await tokens(reader, '2', '../bob@example.com');
		keychain.locked = true;
		const locked = await tokens(reader, '2', 'bob@example.com');

		assert.deepStrictEqual({ found, alias, missing, withoutKeychain, badSlot, badEmail, locked }, {
			found: ['file-r@10', 'keychain-r@20', 'legacy-r@30', 'file-prev@5'],
			alias: ['alias-r@40'],
			missing: undefined,
			withoutKeychain: ['file-r@10', 'file-prev@5'],
			badSlot: undefined,
			badEmail: undefined,
			locked: undefined,
		});
	});
	// 古い版（python の keyring）の項目は読むと許可の確認が出ることがある。断られたらその起動の間は読みに行かない。
	test('stops reading the legacy keyring service for the session after it fails', async () => {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const reads: string[] = [];
		const memory = new ParadisMemoryKeychain();
		memory.set('claude-swap', 'account-2-bob@example.com', paradisTestCredentials('a1', 'keychain-r', 10));
		const keychain: IParadisKeychain = {
			read: async (service, account) => {
				reads.push(service);
				if (service === 'claude-code') {
					throw new ParadisKeychainError('denied');
				}
				return memory.read(service, account);
			},
			write: (service, account, value) => memory.write(service, account, value),
			delete: (service, account) => memory.delete(service, account),
		};
		const reader = new ParadisClaudeSwapBackupReader(keychain);
		const dataDir = path.join(dirs.home, '.claude-swap-backup');

		const first = await reader.readBackups(dataDir, '2', 'bob@example.com');
		const second = await reader.readBackups(dataDir, '2', 'bob@example.com');
		assert.deepStrictEqual({ first, second, legacyReads: reads.filter(service => service === 'claude-code').length }, {
			first: undefined,
			second: undefined,
			legacyReads: 1,
		});
	});
});
