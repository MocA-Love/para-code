/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCodexRolloutIsSideChat, paradisCodexSessionMetaIsSideChat } from '../../node/paradisCodexSideChat.js';

suite('paradisCodexSideChat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// Codex 0.171.0-alpha.10 の SessionMeta の形（codex-rs/protocol/src/protocol.rs）から組み立てた先頭行。実物の記録ではない
	const meta = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-11-17T00:00:00.000Z', type: 'session_meta', payload: { id: '019a0000-0000-7000-8000-000000000002', session_id: '019a0000-0000-7000-8000-000000000002', cwd: '/work', ...payload } });

	test('tells a saved side chat from a regular fork and a main conversation by attached_thread', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-side-chat-'));
		try {
			const side = join(root, 'rollout-side.jsonl');
			const fork = join(root, 'rollout-fork.jsonl');
			const partial = join(root, 'rollout-partial.jsonl');
			await fs.writeFile(side, `${meta({ forked_from_id: '019a0000-0000-7000-8000-000000000001', attached_thread: true })}\n{"type":"event_msg"}\n`);
			await fs.writeFile(fork, `${meta({ forked_from_id: '019a0000-0000-7000-8000-000000000001' })}\n`);
			await fs.writeFile(partial, '{"type":"session_meta","payload":{');
			assert.deepStrictEqual({
				lines: [meta({ attached_thread: true }), meta({}), '{"type":"event_msg"}', 'not json'].map(paradisCodexSessionMetaIsSideChat),
				files: await Promise.all([side, fork, partial, join(root, 'missing.jsonl')].map(paradisCodexRolloutIsSideChat)),
			}, {
				lines: [true, false, undefined, undefined],
				files: [true, false, false, false],
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
