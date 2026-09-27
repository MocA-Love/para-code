/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentChatMessage } from '../../common/paradisAgentChat.js';
import { paradisAgentChatEditDiff, paradisBuildAgentChatItems, paradisDescribeAgentChatTool, paradisIsPendingApprovalItem, paradisIsPendingQuestionItem, paradisLineDiffRows, paradisParseApplyPatch } from '../../common/paradisAgentChatTimeline.js';

function message(rev: number, fields: Omit<IParadisAgentChatMessage, 'rev'>): IParadisAgentChatMessage {
	return { rev, ...fields };
}

suite('paradisAgentChatTimeline', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pairs tool calls with their results, groups questions into one card, and turns approval requests into cards', () => {
		const messages: IParadisAgentChatMessage[] = [
			message(0, { role: 'user', kind: 'text', text: 'README を直して' }),
			message(1, { role: 'assistant', kind: 'thinking', text: '読む' }),
			message(2, { role: 'assistant', kind: 'tool_use', tool: 'Read', text: '{"file_path":"/repo/README.md"}', toolUseId: 't1', ts: 1000 }),
			message(3, { role: 'assistant', kind: 'tool_use', tool: 'Bash', text: '{"command":"npm test"}', toolUseId: 't2' }),
			message(4, { role: 'tool', kind: 'tool_result', text: 'line1\nline2\n', toolUseId: 't1', ts: 2000 }),
			message(5, { role: 'assistant', kind: 'question', text: 'Q1?', toolUseId: 'q1', questionGroup: 'g', questionIndex: 0, questionCount: 2, options: [{ label: 'A' }] }),
			message(6, { role: 'assistant', kind: 'question', text: 'Q2?', toolUseId: 'q2', questionGroup: 'g', questionIndex: 1, questionCount: 2, options: [{ label: 'B' }] }),
			message(7, { role: 'tool', kind: 'tool_result', text: 'answered', toolUseId: 'q1' }),
			message(8, { role: 'assistant', kind: 'tool_use', tool: 'approval_request', text: 'Bash: rm -rf dist', toolUseId: 't3' }),
			message(9, { role: 'tool', kind: 'tool_result', text: 'orphan', toolUseId: 'missing' }),
			message(10, { role: 'assistant', kind: 'text', text: '直しました' }),
		];
		const items = paradisBuildAgentChatItems(messages);
		assert.deepStrictEqual(items.map(item => {
			switch (item.kind) {
				case 'tool': return [item.kind, item.use?.rev, item.result?.rev];
				case 'questions': return [item.kind, item.group, item.questions.map(question => question.rev), item.answered, item.answer];
				default: return [item.kind, item.message.rev];
			}
		}), [
			['user', 0],
			['thinking', 1],
			['tool', 2, 4],
			['tool', 3, undefined],
			['questions', 'g', [5, 6], true, 'answered'],
			['approval', 8],
			['tool', undefined, 9],
			['assistant', 10],
		]);
		assert.deepStrictEqual({
			pendingQuestion: paradisIsPendingQuestionItem({ ...items[4], answered: false } as typeof items[4], { kind: 'question', id: 'g' }),
			answeredQuestion: paradisIsPendingQuestionItem(items[4], { kind: 'question', id: 'g' }),
			pendingApproval: paradisIsPendingApprovalItem(items[5], { kind: 'approval', id: 't3' }),
			otherApproval: paradisIsPendingApprovalItem(items[5], { kind: 'approval', id: 'other' }),
		}, { pendingQuestion: true, answeredQuestion: false, pendingApproval: true, otherApproval: false });
	});

	test('describes tool rows the same way the mobile timeline does', () => {
		const read = paradisDescribeAgentChatTool(
			message(0, { role: 'assistant', kind: 'tool_use', tool: 'Read', text: '{"file_path":"/repo/src/login.ts"}', ts: 1000 }),
			message(1, { role: 'tool', kind: 'tool_result', text: 'a\nb\nc\n', ts: 1500 }),
		);
		const running = paradisDescribeAgentChatTool(message(2, { role: 'assistant', kind: 'tool_use', tool: 'Bash', text: '{"command":"npm   test\\n -- auth"}' }), undefined);
		const failed = paradisDescribeAgentChatTool(
			message(3, { role: 'assistant', kind: 'tool_use', tool: 'mcp__sentry__search_issues', text: '{"query":"login"}' }),
			message(4, { role: 'tool', kind: 'tool_result', text: 'boom', isError: true }),
		);
		assert.deepStrictEqual([read, running, failed], [
			{ label: 'Read', icon: 'file', arg: 'login.ts', meta: '3 行', state: 'done' },
			{ label: 'Bash', icon: 'terminal', arg: 'npm test -- auth', meta: undefined, state: 'running' },
			{ label: 'search_issues', namespace: 'sentry', arg: 'login', icon: 'extensions', meta: '失敗', state: 'failed' },
		]);
	});

	test('builds diff cards from Edit, MultiEdit, Write and Codex apply_patch inputs', () => {
		const edit = paradisAgentChatEditDiff('Edit', JSON.stringify({ file_path: '/repo/a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' }));
		const write = paradisAgentChatEditDiff('Write', JSON.stringify({ file_path: '/repo/b.ts', content: 'x\ny' }));
		const patch = paradisAgentChatEditDiff('apply_patch', '*** Begin Patch\n*** Update File: src/c.ts\n@@ function f\n-old\n+new\n context\n*** Add File: src/d.ts\n+added\n*** End Patch');
		const truncated = paradisAgentChatEditDiff('Edit', '{"file_path":"/repo/a.ts","old_string":"abc');
		assert.deepStrictEqual({ edit, write, patch, truncated }, {
			edit: { files: [{ path: '/repo/a.ts', rows: [{ kind: 'ctx', text: 'one' }, { kind: 'del', text: 'two' }, { kind: 'add', text: '2' }, { kind: 'ctx', text: 'three' }] }], added: 1, removed: 1 },
			write: { files: [{ path: '/repo/b.ts', rows: [{ kind: 'add', text: 'x' }, { kind: 'add', text: 'y' }] }], added: 2, removed: 0 },
			patch: {
				files: [
					{ path: 'src/c.ts', rows: [{ kind: 'hunk', text: 'function f' }, { kind: 'del', text: 'old' }, { kind: 'add', text: 'new' }, { kind: 'ctx', text: 'context' }] },
					{ path: 'src/d.ts', rows: [{ kind: 'add', text: 'added' }] },
				],
				added: 2, removed: 1,
			},
			truncated: undefined,
		});
	});

	test('keeps only a little unchanged context around distant changes', () => {
		const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
		const after = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'J'].join('\n');
		assert.deepStrictEqual(paradisLineDiffRows(before, after).map(row => `${row.kind}:${row.text}`), [
			'del:a', 'add:A', 'ctx:b', 'ctx:c', 'hunk:⋯', 'ctx:h', 'ctx:i', 'del:j', 'add:J',
		]);
		assert.deepStrictEqual(paradisParseApplyPatch('not a patch'), []);
	});
});
