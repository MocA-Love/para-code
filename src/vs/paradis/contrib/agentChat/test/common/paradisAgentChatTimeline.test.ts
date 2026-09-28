/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentChatMessage } from '../../common/paradisAgentChat.js';
import { paradisAgentChatEditDiff, paradisBuildAgentChatItems, paradisPendingCodexQuestion, paradisDescribeAgentChatTool, paradisGroupAgentChatItems, paradisIsPendingApprovalItem, paradisIsPendingQuestionItem, paradisLineDiffRows, paradisParseApplyPatch, paradisSummarizeAgentChatGroup, ParadisAgentChatEntry } from '../../common/paradisAgentChatTimeline.js';

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
	test('drops the empty twin of a question card and finds a Codex request_user_input that still waits for an answer', () => {
		const question = (rev: number, id: string, group: string) => message(rev, { role: 'assistant', kind: 'question', text: 'Q?', toolUseId: id, questionGroup: group, options: [{ label: 'A' }] });
		const pendingTwin = paradisBuildAgentChatItems([question(0, 'toolu_real', 'toolu_real'), question(1, 'live:1', 'liveg:1')], { kind: 'question', id: 'liveg:1' });
		const answeredTwin = paradisBuildAgentChatItems([question(0, 'toolu_real', 'toolu_real'), question(1, 'live:1', 'liveg:1'), message(2, { role: 'tool', kind: 'tool_result', text: 'A', toolUseId: 'live:1' })], null);
		const askedAgain = paradisBuildAgentChatItems([question(0, 'live:1', 'liveg:1'), message(1, { role: 'tool', kind: 'tool_result', text: 'A', toolUseId: 'live:1' }), question(2, 'live:2', 'liveg:2')], { kind: 'question', id: 'liveg:2' });
		const codexCall = message(3, { role: 'assistant', kind: 'tool_use', tool: 'request_user_input', text: '{}', toolUseId: 'call_1' });
		assert.deepStrictEqual({
			pendingTwin: pendingTwin.map(item => item.kind === 'questions' ? item.group : item.kind),
			answeredTwin: answeredTwin.map(item => item.kind === 'questions' ? [item.group, item.answered] : item.kind),
			askedAgain: askedAgain.map(item => item.kind === 'questions' ? [item.group, item.answered] : item.kind),
			codexPending: paradisPendingCodexQuestion([codexCall])?.toolUseId,
			codexAnswered: paradisPendingCodexQuestion([codexCall, message(4, { role: 'tool', kind: 'tool_result', text: 'answer', toolUseId: 'call_1' })]),
		}, {
			pendingTwin: ['liveg:1'],
			answeredTwin: [['liveg:1', true]],
			askedAgain: [['liveg:1', true], ['liveg:2', false]],
			codexPending: 'call_1',
			codexAnswered: undefined,
		});
	});

	test('folds runs of tool calls and thinking into groups, keeping text, cards, web searches and single steps outside', () => {
		const messages: IParadisAgentChatMessage[] = [
			message(0, { role: 'user', kind: 'text', text: '直して' }),
			message(1, { role: 'assistant', kind: 'thinking', text: '読む' }),
			message(2, { role: 'assistant', kind: 'tool_use', tool: 'Read', text: '{"file_path":"/repo/a.ts"}', toolUseId: 't1' }),
			message(3, { role: 'tool', kind: 'tool_result', text: 'x', toolUseId: 't1' }),
			message(4, { role: 'assistant', kind: 'tool_use', tool: 'Bash', text: '{"command":"npm test"}', toolUseId: 't2' }),
			message(5, { role: 'tool', kind: 'tool_result', text: 'boom', toolUseId: 't2', isError: true }),
			message(6, { role: 'assistant', kind: 'tool_use', tool: 'Edit', text: '{"file_path":"/repo/a.ts","old_string":"a","new_string":"b"}', toolUseId: 't3' }),
			message(7, { role: 'assistant', kind: 'tool_use', tool: 'Read', text: '{"file_path":"/repo/b.ts"}', toolUseId: 't4' }),
			message(8, { role: 'assistant', kind: 'text', text: '途中経過' }),
			message(9, { role: 'assistant', kind: 'thinking', text: 'ひとつだけ' }),
			message(10, { role: 'assistant', kind: 'text', text: '次へ' }),
			message(11, { role: 'assistant', kind: 'tool_use', tool: 'Grep', text: '{"pattern":"x"}', toolUseId: 't5' }),
			message(12, { role: 'tool', kind: 'tool_result', text: 'a.ts', toolUseId: 't5' }),
			message(13, { role: 'assistant', kind: 'tool_use', tool: 'web_search', text: 'vscode', toolUseId: 't6' }),
			message(14, { role: 'assistant', kind: 'tool_use', tool: 'approval_request', text: 'Bash: ls', toolUseId: 'old' }),
			message(15, { role: 'assistant', kind: 'tool_use', tool: 'Bash', text: '{"command":"ls"}', toolUseId: 't7' }),
			message(16, { role: 'tool', kind: 'tool_result', text: 'a.ts', toolUseId: 't7' }),
			message(17, { role: 'assistant', kind: 'tool_use', tool: 'approval_request', text: 'Bash: rm -rf dist', toolUseId: 'now' }),
		];
		const interaction = { kind: 'approval' as const, id: 'now' };
		const items = paradisBuildAgentChatItems(messages, interaction);
		const shape = (entries: ParadisAgentChatEntry[]) => entries.map(entry => entry.kind === 'item' ? entry.item.key : [entry.key, entry.items.map(item => item.key), [...entry.pinned]]);
		const busy = paradisGroupAgentChatItems(items, { interaction, busy: true });
		const firstGroup = busy[1].kind === 'group' ? busy[1].items : [];
		assert.deepStrictEqual({
			busy: shape(busy),
			idlePinned: paradisGroupAgentChatItems(items, { interaction, busy: false }).flatMap(entry => entry.kind === 'group' ? [...entry.pinned] : []),
			// 答え終えた承認はまとまりに入り、回答待ちの承認がまとまりを区切る。回答待ちが無くなれば、同じ行はまとまりに入る。
			resolved: shape(paradisGroupAgentChatItems(paradisBuildAgentChatItems(messages, null), { interaction: null, busy: false })).slice(-1),
			summary: paradisSummarizeAgentChatGroup(firstGroup),
		}, {
			busy: [
				'm0',
				['g:m1', ['m1', 'm2', 'm4', 'm6', 'm7'], ['m6', 'm7']],
				'm8',
				'm9',
				'm10',
				'm11',
				'm13',
				['g:m14', ['m14', 'm15'], []],
				'm17',
			],
			idlePinned: [],
			resolved: [['g:m14', ['m14', 'm15', 'm17'], []]],
			summary: { count: 5, names: ['考えた内容', 'Read', 'Bash', 'Edit'], failed: 1, files: [] },
		});
	});

	test('keeps a waiting Codex question outside even when the turn looks idle', () => {
		const messages: IParadisAgentChatMessage[] = [
			message(0, { role: 'user', kind: 'text', text: '計画して' }),
			message(1, { role: 'assistant', kind: 'thinking', text: '聞く' }),
			message(2, { role: 'assistant', kind: 'tool_use', tool: 'request_user_input', text: '{"questions":[]}', toolUseId: 'call_1' }),
		];
		const entries = paradisGroupAgentChatItems(paradisBuildAgentChatItems(messages, null), { interaction: null, busy: false, pendingCodexQuestion: paradisPendingCodexQuestion(messages) });
		assert.deepStrictEqual(entries.map(entry => entry.kind === 'item' ? entry.item.key : entry.key), ['m0', 'm1', 'm2']);
	});

	test('pins running tools only in the current turn, and rows the user has opened', () => {
		const messages: IParadisAgentChatMessage[] = [
			message(0, { role: 'user', kind: 'text', text: '前のターン' }),
			message(1, { role: 'assistant', kind: 'tool_use', tool: 'Bash', text: '{"command":"sleep 99"}', toolUseId: 'old' }),
			message(2, { role: 'assistant', kind: 'tool_use', tool: 'Read', text: '{"file_path":"/repo/a.ts"}', toolUseId: 'r1' }),
			message(3, { role: 'tool', kind: 'tool_result', text: 'x', toolUseId: 'r1' }),
			message(4, { role: 'user', kind: 'text', text: '今のターン' }),
			message(5, { role: 'assistant', kind: 'tool_use', tool: 'Read', text: '{"file_path":"/repo/b.ts"}', toolUseId: 'r2' }),
			message(6, { role: 'tool', kind: 'tool_result', text: 'y', toolUseId: 'r2' }),
			message(7, { role: 'assistant', kind: 'tool_use', tool: 'Bash', text: '{"command":"npm test"}', toolUseId: 'now' }),
		];
		const items = paradisBuildAgentChatItems(messages, null);
		const pinned = (expanded: ReadonlySet<string>) => paradisGroupAgentChatItems(items, { interaction: null, busy: true, expanded }).map(entry => entry.kind === 'group' ? [entry.key, [...entry.pinned]] : entry.item.key);
		assert.deepStrictEqual({ busy: pinned(new Set()), opened: pinned(new Set(['m2', 'm5'])) }, {
			busy: ['m0', ['g:m1', []], 'm4', ['g:m5', ['m7']]],
			opened: ['m0', ['g:m1', ['m2']], 'm4', ['g:m5', ['m5', 'm7']]],
		});
	});

	test('counts changed files once and leaves out failed edits', () => {
		const edit = (rev: number, id: string, path: string) => message(rev, { role: 'assistant', kind: 'tool_use', tool: 'Edit', text: JSON.stringify({ file_path: path, old_string: 'a', new_string: 'b' }), toolUseId: id });
		const messages: IParadisAgentChatMessage[] = [
			edit(0, 'e1', '/repo/src/login.ts'),
			message(1, { role: 'tool', kind: 'tool_result', text: 'String to replace not found in file.', toolUseId: 'e1', isError: true }),
			edit(2, 'e2', '/repo/src/login.ts'),
			message(3, { role: 'tool', kind: 'tool_result', text: 'ok', toolUseId: 'e2' }),
			edit(4, 'e3', '/repo/src/login.ts'),
			message(5, { role: 'tool', kind: 'tool_result', text: 'ok', toolUseId: 'e3' }),
			edit(6, 'e4', '/repo/src/failed-only.ts'),
			message(7, { role: 'tool', kind: 'tool_result', text: 'boom', toolUseId: 'e4', isError: true }),
			message(8, { role: 'assistant', kind: 'tool_use', tool: 'apply_patch', text: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch', toolUseId: 'p1' }),
			message(9, { role: 'tool', kind: 'tool_result', text: 'Success', toolUseId: 'p1' }),
		];
		assert.deepStrictEqual(paradisSummarizeAgentChatGroup(paradisBuildAgentChatItems(messages, null)), {
			count: 5, names: ['Edit', 'Patch'], failed: 2, files: ['/repo/src/login.ts', 'src/a.ts', 'src/b.ts'],
		});
	});
});
