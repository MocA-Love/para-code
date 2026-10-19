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
import { ParadisClaudeSwapBackupReader } from '../../node/paradisClaudeSwapBackups.js';
import { ParadisMemoryKeychain, paradisCreateClaudeTestHome, paradisTestCredentials } from './paradisClaudeTestUtils.js';

suite('ParadisClaudeSwapBackupReader', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	test('collects the refresh tokens of the current and previous claude-swap backups from files and the keychain', async () => {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const dataDir = path.join(dirs.home, '.claude-swap-backup');
		const credentialsDir = path.join(dataDir, 'credentials');
		await fs.promises.mkdir(credentialsDir, { recursive: true });
		const encode = (json: string) => Buffer.from(json, 'utf8').toString('base64');
		await fs.promises.writeFile(path.join(credentialsDir, '.creds-2-bob@example.com.enc'), encode(paradisTestCredentials('a1', 'file-r', 1)));
		await fs.promises.writeFile(path.join(credentialsDir, '.creds-2-bob@example.com.enc.prev'), encode(paradisTestCredentials('a0', 'file-prev', 1)));
		const keychain = new ParadisMemoryKeychain();
		keychain.set('claude-swap', 'account-2-bob@example.com', paradisTestCredentials('a2', 'keychain-r', 1));
		keychain.set('claude-swap', 'account-2-bob@example.com.prev', 'not json');
		const reader = new ParadisClaudeSwapBackupReader(keychain);

		const found = await reader.readRefreshTokens(dataDir, '2', 'bob@example.com');
		const missing = await reader.readRefreshTokens(dataDir, '3', 'carol@example.com');
		const withoutKeychain = await new ParadisClaudeSwapBackupReader(undefined).readRefreshTokens(dataDir, '2', 'bob@example.com');
		// 番号やメールがパスとして怪しいときは読まない（読めない扱い）
		const badSlot = await reader.readRefreshTokens(dataDir, '../2', 'bob@example.com');
		const badEmail = await reader.readRefreshTokens(dataDir, '2', '../bob@example.com');
		keychain.locked = true;
		const locked = await reader.readRefreshTokens(dataDir, '2', 'bob@example.com');

		assert.deepStrictEqual({ found, missing, withoutKeychain, badSlot, badEmail, locked }, {
			found: ['file-r', 'keychain-r', 'file-prev'],
			missing: [],
			withoutKeychain: ['file-r', 'file-prev'],
			badSlot: undefined,
			badEmail: undefined,
			locked: undefined,
		});
	});
});
