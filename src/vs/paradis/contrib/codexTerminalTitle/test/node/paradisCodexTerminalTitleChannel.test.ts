/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { nodeRequire } from '../../../../../base/common/amd.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCodexTerminalTitleService } from '../../node/paradisCodexTerminalTitleChannel.js';

suite('ParadisCodexTerminalTitleService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const threadId = '019f4d58-4ce0-7f50-89a8-d2bbec6b2743';
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
			database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
				.run(threadId, 'cli', '/workspace/original', 'Fix terminal titles', '', '', '/outside/not-used.jsonl', 0);
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

	test('rejects non-canonical thread ids', async () => {
		const service = new ParadisCodexTerminalTitleService(new NullLogService(), codexHome);
		assert.deepStrictEqual(await service.findThreadPrompt({ threadId: '../state_5.sqlite', cwd: '/workspace/original', invocation: 'start' }), {});
	});
});
