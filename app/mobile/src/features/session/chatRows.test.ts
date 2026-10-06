// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { AgentChatMessage } from '../../store.js';
import { buildChatRows, chatRowKey, splitPinnedQuestion } from './chatRows.js';

let rev = 0;
function msg(kind: AgentChatMessage['kind'], extra: Partial<AgentChatMessage> = {}): AgentChatMessage {
	rev++;
	return { rev, role: kind === 'text' ? 'assistant' : 'tool', kind, text: `${kind}-${rev}`, ...extra };
}

describe('会話の行の組み立て', () => {
	test('本文は1行ずつ、間の thinking とツールは1つの行にまとめる', () => {
		const rows = buildChatRows([
			msg('text'),
			msg('thinking'),
			msg('tool_use', { tool: 'Read', toolUseId: 'u1' }),
			msg('tool_result', { toolUseId: 'u1' }),
			msg('text'),
		]);
		expect(rows.map(row => row.type)).toEqual(['msg', 'group', 'msg']);
		const group = rows[1];
		expect(group?.type === 'group' ? group.msgs.map(m => m.kind) : []).toEqual(['thinking', 'tool_use', 'tool_result']);
	});

	test('同じ AskUserQuestion の複数の質問は1行にまとめ、結果があれば回答済み', () => {
		const rows = buildChatRows([
			msg('question', { questionGroup: 'q', questionCount: 2, questionIndex: 0, toolUseId: 'q' }),
			msg('question', { questionGroup: 'q', questionCount: 2, questionIndex: 1, toolUseId: 'q' }),
			msg('tool_result', { toolUseId: 'q' }),
		]);
		expect(rows[0]?.type).toBe('questionGroup');
		expect(rows[0]?.type === 'questionGroup' ? [rows[0].msgs.length, rows[0].answered] : []).toEqual([2, true]);
	});

	test('Web 検索は開始と結果を別の行にし、結果が届いたら開始の行は出さない', () => {
		const pending = buildChatRows([msg('tool_use', { tool: 'web_search', toolUseId: 'w' })]);
		expect(pending.map(row => row.type)).toEqual(['web']);
		const done = buildChatRows([
			msg('tool_use', { tool: 'web_search', toolUseId: 'w2' }),
			msg('text'),
			msg('tool_result', { toolUseId: 'w2' }),
		]);
		expect(done.map(row => row.type)).toEqual(['msg', 'web']);
	});

	test('いま待っている質問はコンポーザーの上に固定し、会話から外す', () => {
		const question = msg('question', { toolUseId: 'q1', options: [{ label: 'A' }] });
		const rows = buildChatRows([msg('text'), question]);
		const { pinned, listRows } = splitPinnedQuestion(rows, { kind: 'question', id: 'q1' }, 'question');
		expect(pinned?.type === 'question' ? pinned.m : undefined).toBe(question);
		expect(listRows.map(row => row.type)).toEqual(['msg']);
		// PC が別の質問を待っているなら固定しない。
		expect(splitPinnedQuestion(rows, { kind: 'question', id: 'other' }, 'question').pinned).toBeUndefined();
		// 承認を待っている間は質問を固定しない。
		expect(splitPinnedQuestion(rows, { kind: 'approval', id: 'q1' }, 'permission').pinned).toBeUndefined();
	});

	test('行の鍵はセッションごとに変わる', () => {
		const [row] = buildChatRows([msg('text')]);
		expect(row !== undefined ? chatRowKey(row, 'e1') : '').not.toBe(row !== undefined ? chatRowKey(row, 'e2') : '');
	});
	test('PC が追っている Workflow の起動だけを 1 枚のカードの行にし、起動の結果も寄せる（agent.workflows.v1）', () => {
		const messages = [
			msg('tool_use', { tool: 'Bash', toolUseId: 'b1' }),
			msg('tool_use', { tool: 'Workflow', toolUseId: 'wf1' }),
			msg('tool_result', { toolUseId: 'b1' }),
			msg('tool_result', { toolUseId: 'wf1' }),
			msg('tool_use', { tool: 'Workflow', toolUseId: 'wf-old' }),
			msg('tool_result', { toolUseId: 'wf-old' }),
		];
		const rows = buildChatRows(messages, new Set(['wf1']));
		const legacy = buildChatRows(messages);
		expect({
			types: rows.map(row => row.type),
			card: rows[1]?.type === 'workflow' ? [rows[1].toolUseId, rows[1].result?.toolUseId, chatRowKey(rows[1], 'e')] : [],
			legacy: legacy.map(row => row.type),
		}).toEqual({
			types: ['group', 'workflow', 'group'],
			card: ['wf1', 'wf1', 'e:wf:wf1'],
			legacy: ['group'],
		});
	});
});
