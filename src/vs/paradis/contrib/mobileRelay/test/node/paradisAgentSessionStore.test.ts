/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisAgentSessionStore } from '../../node/paradisAgentSessionStore.js';

suite('ParadisAgentSessionStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function withTempFile(callback: (filePath: string) => Promise<void>): Promise<void> {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-sessions-'));
		try {
			await callback(join(dir, 'sessions.json'));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	test('persists and reloads agent sessions across restarts', async () => {
		await withTempFile(async filePath => {
			const store = new ParadisAgentSessionStore(filePath, new NullLogService());
			store.persist([
				{ token: 'pane-1', agent: 'claude', transcriptPath: '/home/user/.claude/projects/p/s.jsonl', sessionId: 'session-1', savedAt: Date.now() },
				{ token: 'pane-2', agent: 'codex', transcriptPath: '/home/user/.codex/sessions/r.jsonl', savedAt: Date.now() },
			]);
			await store.flush();
			const reloaded = await new ParadisAgentSessionStore(filePath, new NullLogService()).load();
			assert.deepStrictEqual(reloaded.map(entry => [entry.token, entry.agent, entry.transcriptPath, entry.sessionId]), [
				['pane-1', 'claude', '/home/user/.claude/projects/p/s.jsonl', 'session-1'],
				['pane-2', 'codex', '/home/user/.codex/sessions/r.jsonl', undefined],
			]);
		});
	});

	test('drops expired and malformed entries on load', async () => {
		await withTempFile(async filePath => {
			await fs.writeFile(filePath, JSON.stringify([
				{ token: 'fresh', agent: 'claude', transcriptPath: '/t/fresh.jsonl', savedAt: Date.now() },
				{ token: 'expired', agent: 'claude', transcriptPath: '/t/expired.jsonl', savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
				{ token: 'bad-agent', agent: 'other', transcriptPath: '/t/bad.jsonl', savedAt: Date.now() },
				{ token: '', agent: 'claude', transcriptPath: '/t/empty-token.jsonl', savedAt: Date.now() },
				'not-an-object',
			]));
			const reloaded = await new ParadisAgentSessionStore(filePath, new NullLogService()).load();
			assert.deepStrictEqual(reloaded.map(entry => entry.token), ['fresh']);
		});
	});

	test('returns an empty list when the file is missing or corrupted', async () => {
		await withTempFile(async filePath => {
			assert.deepStrictEqual(await new ParadisAgentSessionStore(filePath, new NullLogService()).load(), []);
			await fs.writeFile(filePath, '{broken json');
			assert.deepStrictEqual(await new ParadisAgentSessionStore(filePath, new NullLogService()).load(), []);
		});
	});
});
