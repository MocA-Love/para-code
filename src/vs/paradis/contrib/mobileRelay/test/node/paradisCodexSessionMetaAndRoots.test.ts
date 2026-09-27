/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsAllowedTranscriptPathForTest, paradisReadCodexRolloutSessionMetaForTest } from '../../node/paradisMobileAgentChat.js';

suite('ParadisMobileAgentChat rollout head and allowed roots', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads a Codex session_meta line longer than 16KB to its end, and gives up past the cap', async () => {
		const root = await mkdtemp(join(tmpdir(), 'paradis-session-meta-'));
		try {
			// codex-cli 0.155.1 の先頭行は base_instructions を含んで 22,116 バイト（フェーズ6の実機確認）
			const meta = (extra: string, source?: object) => JSON.stringify({
				timestamp: '2026-09-27T10:00:00.000Z', type: 'session_meta',
				payload: { id: 'thread-1', cwd: '/repo', originator: 'codex_cli_rs', cli_version: '0.155.1', base_instructions: { text: extra }, ...(source !== undefined ? { source } : {}) },
			});
			const long = join(root, 'rollout-long.jsonl');
			await writeFile(long, `${meta('x'.repeat(22_000))}\n{"type":"turn_context"}\n`);
			const subagent = join(root, 'rollout-sub.jsonl');
			await writeFile(subagent, `${meta('y'.repeat(30_000), { subagent: { thread_spawn: { parent_thread_id: 'thread-0', depth: 1 } } })}\n`);
			const tooLong = join(root, 'rollout-too-long.jsonl');
			await writeFile(tooLong, `${meta('z'.repeat(1024 * 1024 + 10))}\n`);
			assert.deepStrictEqual({
				long: await paradisReadCodexRolloutSessionMetaForTest(long),
				subagent: (await paradisReadCodexRolloutSessionMetaForTest(subagent))?.subagent,
				tooLong: await paradisReadCodexRolloutSessionMetaForTest(tooLong),
			}, {
				long: { cwd: '/repo', sessionId: 'thread-1' },
				subagent: true,
				tooLong: undefined,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('accepts transcripts under a config dir reached through a symlink, but not a symlink that escapes it', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-roots-')));
		const previous = process.env['CLAUDE_CONFIG_DIR'];
		try {
			const real = join(root, 'real-claude');
			await mkdir(join(real, 'projects', 'repo'), { recursive: true });
			const linked = join(root, 'linked-claude');
			await symlink(real, linked);
			const outside = join(root, 'outside.jsonl');
			await writeFile(outside, '{}\n');
			await writeFile(join(real, 'projects', 'repo', 'session.jsonl'), '{}\n');
			await symlink(outside, join(real, 'projects', 'repo', 'escape.jsonl'));
			process.env['CLAUDE_CONFIG_DIR'] = linked;
			assert.deepStrictEqual({
				viaLink: await paradisIsAllowedTranscriptPathForTest(join(linked, 'projects', 'repo', 'session.jsonl')),
				viaRealPath: await paradisIsAllowedTranscriptPathForTest(join(real, 'projects', 'repo', 'session.jsonl')),
				escape: await paradisIsAllowedTranscriptPathForTest(join(linked, 'projects', 'repo', 'escape.jsonl')),
				outside: await paradisIsAllowedTranscriptPathForTest(outside),
			}, { viaLink: true, viaRealPath: true, escape: false, outside: false });
		} finally {
			if (previous === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previous;
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});
