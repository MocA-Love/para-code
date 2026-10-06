/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisNewWorkflowRunReadState, paradisReadClaudeWorkflowRun } from '../../node/paradisClaudeWorkflowFiles.js';

const allowAll = async () => true;

suite('paradisClaudeWorkflowFiles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the journal by appends, new children once, a huge result line by its head, and the result file once', async () => {
		const base = await realpath(await mkdtemp(join(tmpdir(), 'paradis-workflow-files-')));
		try {
			const root = join(base, 'session-1.jsonl');
			const run = join(base, 'session-1', 'subagents', 'workflows', 'wf_abc-123');
			await mkdir(run, { recursive: true });
			await mkdir(join(base, 'session-1', 'workflows'), { recursive: true });
			await writeFile(root, '');
			const key = `v2:${'0'.repeat(64)}`;
			await writeFile(join(run, 'journal.jsonl'), `{"type":"launched"}\n{"type":"started","key":"${key}","agentId":"achild1","label":"find:a","phase":"Find"}\n{"type":"start`);
			await writeFile(join(run, 'agent-achild1.jsonl'), '{}\n');
			await writeFile(join(run, 'agent-achild1.meta.json'), '{"agentType":"workflow-subagent","description":"find:a","workflowPhase":"Find"}');
			await writeFile(join(run, 'agent-achild2.jsonl'), '{}\n');
			await symlink(join(run, 'agent-achild1.meta.json'), join(run, 'agent-achild2.meta.json'));
			const state = paradisNewWorkflowRunReadState();
			const first = await paradisReadClaudeWorkflowRun(root, 'wf_abc-123', state, true, allowAll);
			// 書きかけの行の続きと、読む量（512KB）を超える result の行と、その次の行
			await appendFile(join(run, 'journal.jsonl'), `ed","key":"${key}","agentId":"achild2"}\n{"type":"result","key":"${key}","agentId":"achild1","result":"${'x'.repeat(600 * 1024)}"}\n{"type":"failed","key":"${key}","agentId":"achild2"}\n`);
			const second = await paradisReadClaudeWorkflowRun(root, 'wf_abc-123', state, true, allowAll);
			const third = await paradisReadClaudeWorkflowRun(root, 'wf_abc-123', state, true, allowAll);
			await writeFile(join(base, 'session-1', 'workflows', 'wf_abc-123.json'), JSON.stringify({ status: 'completed', workflowName: 'w', phases: [{ title: 'Find' }], workflowProgress: [], totalTokens: 5 }));
			const fourth = await paradisReadClaudeWorkflowRun(root, 'wf_abc-123', state, false, allowAll);
			const fifth = await paradisReadClaudeWorkflowRun(root, 'wf_abc-123', state, false, allowAll);
			const denied = await paradisReadClaudeWorkflowRun(root, 'wf_abc-123', paradisNewWorkflowRunReadState(), true, async () => false);
			const badRun = await paradisReadClaudeWorkflowRun(root, '../x', paradisNewWorkflowRunReadState(), true, allowAll);
			assert.deepStrictEqual({
				first: { journal: first.journal, children: first.children.map(child => ({ ...child, startedAt: typeof child.startedAt })), more: first.more },
				second: { journal: second.journal, children: second.children, more: second.more },
				third: { journal: third.journal, more: third.more },
				fourth: { journal: fourth.journal, result: fourth.result?.file, more: fourth.more },
				fifth: fifth.result,
				denied, badRun,
			}, {
				first: {
					journal: [{ type: 'started', agentId: 'achild1', label: 'find:a', phase: 'Find' }],
					// シンボリックリンクの meta は読まない（ラベルが無いだけ）
					children: [{ agentId: 'achild1', label: 'find:a', phase: 'Find', startedAt: 'number' }, { agentId: 'achild2', startedAt: 'number' }],
					more: false,
				},
				// 長い行の手前で止め、次の回に長い行を頭だけで読んで残りを飛ばす
				second: { journal: [{ type: 'started', agentId: 'achild2' }], children: [], more: true },
				third: { journal: [{ type: 'result', agentId: 'achild1' }], more: true },
				fourth: { journal: [{ type: 'failed', agentId: 'achild2' }], result: { status: 'completed', name: 'w', phases: [{ title: 'Find' }], agents: [], totalTokens: 5 }, more: false },
				fifth: undefined,
				denied: { journal: [], children: [], more: false },
				badRun: { journal: [], children: [], more: false },
			});
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
