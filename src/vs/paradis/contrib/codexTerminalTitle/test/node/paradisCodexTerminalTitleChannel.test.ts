/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCodexTerminalTitleService } from '../../node/paradisCodexTerminalTitleChannel.js';

const nodeRequire = createRequire(import.meta.url);

suite('ParadisCodexTerminalTitleService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const threadId = '019f4d58-4ce0-7f50-89a8-d2bbec6b2743';
	const vscodeThreadId = '019f4d58-4ce0-7f50-89a8-d2bbec6b2744';
	const execThreadId = '019f4d58-4ce0-7f50-89a8-d2bbec6b2745';
	let codexHome: string;

	setup(async () => {
		codexHome = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-title-'));
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
		try {
			database.exec(`
				CREATE TABLE threads (
					id TEXT PRIMARY KEY,
					source TEXT NOT NULL,
					cwd TEXT NOT NULL,
					title TEXT NOT NULL,
					first_user_message TEXT NOT NULL,
					preview TEXT NOT NULL,
					rollout_path TEXT NOT NULL,
					archived INTEGER NOT NULL
				)
			`);
			const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
			insert.run(threadId, 'cli', '/workspace/original', 'Fix terminal titles', '', '', '/outside/not-used.jsonl', 0);
			insert.run(vscodeThreadId, 'vscode', '/workspace/original', 'Refactor the tree view', '', '', '/outside/not-used.jsonl', 0);
			insert.run(execThreadId, 'exec', '/workspace/original', 'Run the linter', '', '', '/outside/not-used.jsonl', 0);
		} finally {
			database.close();
		}
	});

	teardown(async () => {
		await fs.rm(codexHome, { recursive: true, force: true });
	});

	test('requires cwd equality for a new Codex session', async () => {
		const service = new ParadisCodexTerminalTitleService(new NullLogService(), codexHome);
		assert.deepStrictEqual(await service.findThreadPrompt({ threadId, cwd: '/workspace/other', invocation: 'start' }), {});
		assert.deepStrictEqual(await service.findThreadPrompt({ threadId, cwd: '/workspace/original', invocation: 'start' }), { prompt: 'Fix terminal titles' });
	});

	test('allows a resumed Codex session to originate in another cwd', async () => {
		const service = new ParadisCodexTerminalTitleService(new NullLogService(), codexHome);
		assert.deepStrictEqual(await service.findThreadPrompt({ threadId, cwd: '/workspace/other', invocation: 'resume' }), { prompt: 'Fix terminal titles' });
	});

	test('accepts a thread recorded from an integrated terminal (source vscode)', async () => {
		const service = new ParadisCodexTerminalTitleService(new NullLogService(), codexHome);
		assert.deepStrictEqual(await service.findThreadPrompt({ threadId: vscodeThreadId, cwd: '/workspace/original', invocation: 'start' }), { prompt: 'Refactor the tree view' });
	});

	test('rejects non-interactive thread sources', async () => {
		const service = new ParadisCodexTerminalTitleService(new NullLogService(), codexHome);
		assert.deepStrictEqual(await service.findThreadPrompt({ threadId: execThreadId, cwd: '/workspace/original', invocation: 'start' }), {});
	});

	test('rejects non-canonical thread ids', async () => {
		const service = new ParadisCodexTerminalTitleService(new NullLogService(), codexHome);
		assert.deepStrictEqual(await service.findThreadPrompt({ threadId: '../state_5.sqlite', cwd: '/workspace/original', invocation: 'start' }), {});
	});
});
