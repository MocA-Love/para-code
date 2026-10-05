/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisClaudeWorkflowRunLastWrite, paradisDiscoverClaudeSubagentFiles, paradisFindClaudeSubagentTranscript, paradisParseClaudeSubagentTranscriptPath } from '../../node/paradisClaudeSubagentFiles.js';

const allowAll = async () => true;

suite('paradisClaudeSubagentFiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the agent, the run and the root session from a child transcript path', () => {
		assert.deepStrictEqual({
			plain: paradisParseClaudeSubagentTranscriptPath('/home/u/.claude/projects/p/s1/subagents/agent-a1.jsonl'),
			workflow: paradisParseClaudeSubagentTranscriptPath('/home/u/.claude/projects/p/s1/subagents/workflows/wf_1-2/agent-a2.jsonl'),
			root: paradisParseClaudeSubagentTranscriptPath('/home/u/.claude/projects/p/s1.jsonl'),
			tooDeep: paradisParseClaudeSubagentTranscriptPath('/home/u/.claude/projects/p/s1/subagents/workflows/wf_1/x/agent-a3.jsonl'),
		}, {
			plain: { rootTranscriptPath: '/home/u/.claude/projects/p/s1.jsonl', agentId: 'a1' },
			workflow: { rootTranscriptPath: '/home/u/.claude/projects/p/s1.jsonl', agentId: 'a2', runId: 'wf_1-2' },
			root: undefined,
			tooDeep: undefined,
		});
	});

	test('finds plain and Workflow children, skipping side questions, symlinks and other files', async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), 'paradis-subagent-files-')));
		try {
			const root = join(base, 'session-1.jsonl');
			const subagents = join(base, 'session-1', 'subagents');
			const run = join(subagents, 'workflows', 'wf_abc-123');
			await mkdir(run, { recursive: true });
			await writeFile(root, '');
			await writeFile(join(subagents, 'agent-plain1.jsonl'), '{}\n');
			await writeFile(join(subagents, 'agent-plain1.meta.json'), '{}');
			await writeFile(join(subagents, 'agent-aside_question-x.jsonl'), '{}\n');
			await writeFile(join(run, 'agent-wfchild1.jsonl'), '{}\n');
			await writeFile(join(run, 'agent-wfchild1.meta.json'), '{"agentType":"workflow-subagent","spawnDepth":1}');
			await writeFile(join(run, 'journal.jsonl'), '{"type":"started","agentId":"wfchild1"}\n');
			await symlink(join(subagents, 'agent-plain1.jsonl'), join(run, 'agent-linked.jsonl'));
			await utimes(join(subagents, 'agent-plain1.jsonl'), 1_000, 1_000);
			await utimes(join(run, 'agent-wfchild1.jsonl'), 2_000, 2_000);
			await utimes(join(run, 'journal.jsonl'), 3_000, 3_000);

			const files = await paradisDiscoverClaudeSubagentFiles(root, allowAll);
			assert.deepStrictEqual({
				files: files.map(file => ({ id: file.id, runId: file.runId })),
				found: await paradisFindClaudeSubagentTranscript(root, 'wfchild1', allowAll),
				missing: await paradisFindClaudeSubagentTranscript(root, 'nobody', allowAll),
				lastWrite: await paradisClaudeWorkflowRunLastWrite(root, 'wf_abc-123'),
				noRun: await paradisClaudeWorkflowRunLastWrite(root, 'wf_missing'),
			}, {
				files: [{ id: 'wfchild1', runId: 'wf_abc-123' }, { id: 'plain1', runId: undefined }],
				found: join(run, 'agent-wfchild1.jsonl'),
				missing: undefined,
				lastWrite: 3_000_000,
				noRun: undefined,
			});
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
