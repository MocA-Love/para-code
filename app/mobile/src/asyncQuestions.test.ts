// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { asyncAnswerText, buildAsyncReply, displaySentText, groupAsyncQuestions, parseAsyncQuestions, pickExpandedAsyncCall, questionRepliesOf } from './asyncQuestions.js';

const id = (callId: string, index: number) => JSON.stringify(['request_user_input_async', callId, index]);

/** PC が送る形（codex-cli 0.165.0 の実物の 2 問）。 */
const wire = [
	{ id: id('call_1', 0), callId: 'call_1', index: 0, count: 2, title: 'どのブランチに入れますか？', options: ['main', 'release/1.2'], at: 1 },
	{ id: id('call_1', 1), callId: 'call_1', index: 1, count: 2, title: 'コミットメッセージに付ける接頭辞は？', at: 1 },
	{ id: id('call_2', 0), callId: 'call_2', index: 0, count: 1, title: '次は？' },
];

describe('asyncQuestions', () => {
	test('reads the questions the PC sends and drops items whose id does not match', () => {
		const parsed = parseAsyncQuestions([...wire, { ...wire[0], index: 5 }, { id: 'x', callId: 'x', index: 0, title: 'y' }, null]);
		expect({ parsed: parsed?.map(question => question.id), groups: groupAsyncQuestions(parsed ?? []).map(group => group.length), missing: parseAsyncQuestions(undefined) })
			.toEqual({ parsed: wire.map(question => question.id), groups: [2, 1], missing: undefined });
	});

	test('sends only the answered questions, preferring typed text over the chosen option', () => {
		const questions = parseAsyncQuestions(wire)!.slice(0, 2);
		const partial = buildAsyncReply(questions, { [id('call_1', 0)]: { option: 1 } });
		const typed = asyncAnswerText(questions[0]!, { option: 0, text: '  hotfix ' });
		const none = buildAsyncReply(questions, { [id('call_1', 1)]: { text: '   ' } });
		expect({ ids: partial?.ids, replies: questionRepliesOf({ role: 'user', kind: 'text', text: partial?.text ?? '' }), typed, none }).toEqual({
			ids: [id('call_1', 0)],
			replies: [{ question: 'どのブランチに入れますか？', answer: 'release/1.2' }],
			typed: 'hotfix',
			none: undefined,
		});
	});

	test('shows a reply message as the question and the answer, from the PC field or the raw message', () => {
		const text = `<send_user_message_question_reply>\n[{"answer":"main","question":"Q?","questionItemId":${JSON.stringify(id('c', 0))}}]\n</send_user_message_question_reply>`;
		expect({
			field: questionRepliesOf({ role: 'user', kind: 'text', text: 'x', questionReplies: [{ question: 'Q1', answer: 'A1' }, { question: 1 }] }),
			raw: questionRepliesOf({ role: 'user', kind: 'text', text }),
			assistant: questionRepliesOf({ role: 'assistant', kind: 'text', text }),
			plain: questionRepliesOf({ role: 'user', kind: 'text', text: 'こんにちは' }),
			pending: displaySentText(text),
		}).toEqual({
			field: [{ question: 'Q1', answer: 'A1' }],
			raw: [{ question: 'Q?', answer: 'main' }],
			assistant: undefined,
			plain: undefined,
			pending: '回答: Q? → main',
		});
	});

	test('keeps the open group when Codex asks a newer one, and opens the newest when the open one is gone', () => {
		const groups = (calls: readonly string[]) => calls.map(callId => parseAsyncQuestions([{ id: id(callId, 0), callId, index: 0, count: 1, title: callId }])!);
		const first = pickExpandedAsyncCall(groups(['call_a']), undefined);
		// 組 A の「その他」を入力している途中に組 B が出た（新しい順なので B が先頭）
		const afterNewer = pickExpandedAsyncCall(groups(['call_b', 'call_a']), first);
		const afterAnswered = pickExpandedAsyncCall(groups(['call_b']), afterNewer);
		expect({ first, afterNewer, afterAnswered, none: pickExpandedAsyncCall([], 'call_a') }).toEqual({ first: 'call_a', afterNewer: 'call_a', afterAnswered: 'call_b', none: undefined });
	});
});
