// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	humanAskAnswerRequest,
	humanAskQuestionAnswer,
	humanAskRefusalText,
	parseHumanAskAnswerReply,
	parseHumanAskSummary,
	parseHumanAsksReply,
	type HumanAskAnswer,
} from './humanAsks.js';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../protocol/test/golden/human-asks.json', import.meta.url)), 'utf8')) as {
	summary: unknown;
	reply: { signature: string; asks: unknown[] };
	answerRequest: { opId: string; key: string; answer: HumanAskAnswer };
	answerReplies: unknown[];
};

describe('humanAsks', () => {
	it('PC のゴールデン（human-asks.json）を何も落とさずに読み、同じ形の要求を作る', () => {
		expect({
			summary: parseHumanAskSummary(golden.summary),
			reply: parseHumanAsksReply(golden.reply),
			request: humanAskAnswerRequest(golden.answerRequest.opId, golden.answerRequest.key, golden.answerRequest.answer),
			replies: golden.answerReplies.map(parseHumanAskAnswerReply),
		}).toEqual({
			summary: golden.summary,
			reply: { signature: golden.reply.signature, asks: golden.reply.asks },
			request: { t: 'humanAskAnswer', opId: golden.answerRequest.opId, key: golden.answerRequest.key, answer: golden.answerRequest.answer },
			replies: [{ ok: true }, { ok: true, duplicate: true }, { ok: false, reason: 'gone' }],
		});
	});

	it('読めない 1 件だけを捨て、読めない応答と件数は undefined にする', () => {
		const good = golden.reply.asks[0];
		const reply = parseHumanAsksReply({ signature: 's', asks: [good, { key: 'x' }, { ...(good as object), source: 'mail' }, { ...(good as object), questions: [{ id: 'q', text: 't', options: [{ id: '0' }] }] }] });
		expect({
			kept: reply?.asks.length,
			noSignature: parseHumanAsksReply({ asks: [] }),
			badSummary: [parseHumanAskSummary({ count: -1, signature: 's' }), parseHumanAskSummary({ count: 1 }), parseHumanAskSummary(undefined)],
			unknownReason: parseHumanAskAnswerReply({ ok: false, reason: 'boom' }),
		}).toEqual({ kept: 1, noSignature: undefined, badSummary: [undefined, undefined, undefined], unknownReason: { ok: false, reason: 'unavailable' } });
	});

	it('質問カードの答えを台帳の 1 問の答えにする（書けない問いの文・範囲外の番号は送らない）', () => {
		const question = { id: 'q1', text: 'どれ?', options: [{ id: '0', label: 'A' }, { id: '1', label: 'B' }], allowText: false, multiSelect: true };
		const single = { id: 'q0', text: '残す?', options: [{ id: '0', label: '残す' }], allowText: true };
		expect({
			option: humanAskQuestionAnswer(single, { kind: 'option', index: 0 }),
			outOfRange: humanAskQuestionAnswer(single, { kind: 'option', index: 3 }),
			multi: humanAskQuestionAnswer(question, { kind: 'multi', indices: [1, 0] }),
			multiOnSingle: humanAskQuestionAnswer(single, { kind: 'multi', indices: [0] }),
			text: humanAskQuestionAnswer(single, { kind: 'text', optionCount: 1, text: ' 理由 ' }),
			textNotAllowed: humanAskQuestionAnswer(question, { kind: 'text', optionCount: 2, text: 'x' }),
			gone: humanAskRefusalText('gone'),
		}).toEqual({
			option: { questionId: 'q0', optionIds: ['0'] },
			outOfRange: undefined,
			multi: { questionId: 'q1', optionIds: ['1', '0'] },
			multiOnSingle: undefined,
			text: { questionId: 'q0', text: '理由' },
			textNotAllowed: undefined,
			gone: 'PC で回答済み、または対象外になりました',
		});
	});
});
