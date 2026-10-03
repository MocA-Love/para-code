// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../store.js';
import { buildChatRows } from './chatRows.js';
import { questionRowOutcome, withQuestionOutcomes } from './questionOutcomes.js';

function message(rev: number, fields: Partial<AgentChatMessage>): AgentChatMessage {
	return { rev, role: 'assistant', kind: 'text', text: '', ...fields };
}

describe('withQuestionOutcomes', () => {
	it('取り下げた質問の行に結果を添え、その結果はツールの実行の行から外す。ふつうの回答と他のツールはそのまま', () => {
		const rows = withQuestionOutcomes(buildChatRows([
			message(0, { kind: 'question', text: 'Q1', toolUseId: 'q1', questionGroup: 'q1', questionIndex: 0, questionCount: 1 }),
			message(1, { role: 'tool', kind: 'tool_result', text: 'The user responded: 先に画面を見せて', toolUseId: 'q1' }),
			message(2, { kind: 'tool_use', tool: 'Read', text: 'a.ts', toolUseId: 'r1' }),
			message(3, { role: 'tool', kind: 'tool_result', text: 'ok', toolUseId: 'r1' }),
			message(4, { kind: 'question', text: 'Q2', toolUseId: 'q2', questionGroup: 'q2', questionIndex: 0, questionCount: 2 }),
			message(5, { kind: 'question', text: 'Q3', toolUseId: 'q2', questionGroup: 'q2', questionIndex: 1, questionCount: 2 }),
			message(6, { role: 'tool', kind: 'tool_result', text: '<tool_use_error>The user wants to clarify these questions.</tool_use_error>', toolUseId: 'q2', isError: true }),
			message(7, { kind: 'question', text: 'Q4', toolUseId: 'q4', questionGroup: 'q4', questionIndex: 0, questionCount: 1 }),
			message(8, { role: 'tool', kind: 'tool_result', text: 'Your questions have been answered: "Q4"="A".', toolUseId: 'q4' }),
		]));
		expect(rows.map(row => ({
			type: row.type,
			revs: row.type === 'msg' || row.type === 'question' ? [row.m.rev] : 'msgs' in row ? row.msgs.map(m => m.rev) : [],
			outcome: row.type === 'question' || row.type === 'questionGroup' ? questionRowOutcome(row) : undefined,
		}))).toEqual([
			{ type: 'question', revs: [0], outcome: { kind: 'withdrawnWithMessage', text: '先に画面を見せて' } },
			{ type: 'group', revs: [2, 3], outcome: undefined },
			{ type: 'questionGroup', revs: [4, 5], outcome: { kind: 'withdrawn' } },
			{ type: 'question', revs: [7], outcome: undefined },
			{ type: 'group', revs: [8], outcome: undefined },
		]);
	});
});
