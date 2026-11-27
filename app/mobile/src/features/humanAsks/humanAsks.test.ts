// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { questionAllowsFreeText } from '../../agentQuestionMod.js';
import {
	humanAskActionSheet,
	humanAskAnswerRequest,
	humanAskAnswerStands,
	humanAskDuplicateOutcome,
	humanAskQuestionAnswer,
	humanAskQuestionMessages,
	humanAskRefusalText,
	parseHumanAskAnswerReply,
	parseHumanAskSummary,
	parseHumanAsksReply,
	type HumanAsk,
	type HumanAskAction,
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
	it('書けない問いの質問カードには「その他（入力して回答）」を出さない', () => {
		const messages = humanAskQuestionMessages({
			key: 'bot:i.e',
			questions: [
				{ id: 'q0', text: '残す?', options: [{ id: '0', label: '残す', recommended: true }], allowText: true },
				{ id: 'q1', text: 'どれ?', options: [{ id: '0', label: 'A', detail: '速い' }, { id: '1', label: 'B' }], allowText: false, multiSelect: true },
			],
		});
		expect(messages.map(message => ({ freeText: questionAllowsFreeText(message), options: message.options, multi: message.multiSelect === true, group: message.questionGroup }))).toEqual([
			{ freeText: true, options: [{ label: '残す', description: 'おすすめ' }], multi: false, group: 'bot:i.e' },
			{ freeText: false, options: [{ label: 'A', description: '速い' }, { label: 'B' }], multi: true, group: 'bot:i.e' },
		]);
	});

	it('duplicate が返ったら一覧を取り直して確かめ、まだ待っている・取れないときは「答えた」にしない', () => {
		const waiting = [{ key: 'board:b1', busy: false }];
		expect({
			gone: humanAskDuplicateOutcome([], 'board:b1'),
			delivering: humanAskDuplicateOutcome([{ key: 'board:b1', busy: true }], 'board:b1'),
			stillWaiting: humanAskDuplicateOutcome(waiting, 'board:b1'),
			listFailed: humanAskDuplicateOutcome(undefined, 'board:b1'),
		}).toEqual({
			gone: { ok: true },
			delivering: { ok: false, reason: 'busy' },
			stillWaiting: { ok: false, reason: 'unconfirmed' },
			listFailed: { ok: false, reason: 'unconfirmed' },
		});
	});

	it('ボードの承認・止まったのボタンは、PC が載せた確認の文のシートを挟んでから送る（承認のボタンは 1 押しで送らない）', () => {
		// PC の形（src/vs/paradis/contrib/taskBoard/common/paradisTaskBoardAsks.ts の承認 :192・止まった :197、確認の文 :144〜155）
		const approve: HumanAskAction = { id: 'approve', label: '承認して次へ', allowText: true };
		const sendBack: HumanAskAction = { id: 'sendBack', label: '差し戻す', allowText: true, confirm: { title: '差し戻す', body: '実装からやり直します', ok: '差し戻す' } };
		const complete: HumanAskAction = { id: 'complete', label: '完了扱いにする', confirm: { title: '#415 を完了にしますか', body: 'PR はマージしません。ボード上で完了として扱い、作業場所を返します。', ok: '完了にする' } };
		const nudge: HumanAskAction = { id: 'nudge', label: '報告を促す' };
		const approval = { kind: 'approval' as const, preface: 'レビューの結果を確かめてください' };
		const stalled = { kind: 'stalled' as const };
		expect({
			approve: humanAskActionSheet(approval, approve),
			sendBack: humanAskActionSheet(approval, sendBack),
			complete: humanAskActionSheet(stalled, complete),
			nudge: humanAskActionSheet(stalled, nudge),
			// PC が確認を載せていない承認のボタンも、確認のシートを挟む
			approvalWithoutConfirm: humanAskActionSheet(approval, { id: 'x', label: '承認する' }),
			approvalButtonsSentDirectly: [approve, sendBack, { id: 'x', label: '承認する' }].filter(action => humanAskActionSheet(approval, action).kind === 'send'),
		}).toEqual({
			approve: { kind: 'text', title: '承認して次へ', ok: '承認して次へ' },
			sendBack: { kind: 'text', title: '差し戻す', body: '実装からやり直します', ok: '差し戻す' },
			complete: { kind: 'confirm', title: '#415 を完了にしますか', body: 'PR はマージしません。ボード上で完了として扱い、作業場所を返します。', ok: '完了にする' },
			nudge: { kind: 'send' },
			approvalWithoutConfirm: { kind: 'confirm', title: '承認する', body: 'レビューの結果を確かめてください', ok: '承認する' },
			approvalButtonsSentDirectly: [],
		});
	});

	it('答えたあと PC が届けられずに待ちへ戻したら「答えた」を下ろし、答え直せるようにする', () => {
		const waiting = parseHumanAsksReply(golden.reply)?.asks[0] as HumanAsk;
		const answeredOn = { ...waiting, busy: false, failed: false };
		const failedBefore = { ...waiting, busy: false, failed: true };
		expect({
			sameAsk: humanAskAnswerStands(answeredOn, answeredOn),
			delivering: humanAskAnswerStands(answeredOn, { ...waiting, busy: true, failed: false }),
			failedBack: humanAskAnswerStands(answeredOn, { ...waiting, busy: false, failed: true }),
			// 前にも届けられなかった 1 件へ答え直した場合も、取り直した一覧で failed なら下ろす
			failedAgain: humanAskAnswerStands(failedBefore, { ...waiting, busy: false, failed: true }),
			waitingNotFailed: humanAskAnswerStands(answeredOn, { ...waiting, busy: false, failed: false }),
		}).toEqual({ sameAsk: true, delivering: true, failedBack: false, failedAgain: false, waitingNotFailed: true });
	});
});
