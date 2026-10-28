/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisBuildCodexAsyncReply, paradisCodexAsyncQuestionItemId, paradisCodexAsyncQuestionsFromArguments, paradisParseCodexAsyncReply,
	paradisParseCodexAsyncQuestionItemId, paradisSanitizeCodexAsyncText,
} from '../../../mobileRelay/common/paradisCodexAsyncQuestions.js';
import { ParadisCodexAsyncQuestionLedger } from '../../common/paradisCodexAsyncQuestionLedger.js';
import { newParseSignals, parseCodexLine } from '../../common/paradisAgentTranscriptParser.js';
import { CODEX_ASYNC_ANSWERED_CALL, CODEX_ASYNC_PARTIAL_CALL, CODEX_ASYNC_QUESTION_ROLLOUT } from './paradisCodexAsyncQuestionFixture.js';

/** 実物の rollout の行を順に読み、質問・答え・発言を集める。 */
function readFixture(lines: readonly string[]) {
	const signals = newParseSignals();
	const messages = lines.flatMap(line => parseCodexLine(JSON.parse(line), signals));
	return { signals, messages };
}

suite('Codex async questions (request_user_input_async)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the questions from item_completed and the answered ids from the reply messages of a real 0.165.0 rollout', () => {
		const { signals, messages } = readFixture(CODEX_ASYNC_QUESTION_ROLLOUT);
		assert.deepStrictEqual({
			questions: signals.codexAsyncQuestions.map(question => ({ id: question.id, index: question.index, count: question.count, title: question.title, options: question.options })),
			answered: signals.codexAsyncAnswered,
			// 返信の発言は元の文のまま残し、読んだ中身を添える。event_msg の UserMessage からは発言を作らない
			replies: messages.filter(message => message.role === 'user').map(message => ({ raw: message.text.startsWith('<send_user_message_question_reply>'), replies: message.questionReplies })),
			// 非同期の質問は承認・質問の枠（kind: 'question'）にしない
			questionKinds: messages.filter(message => message.kind === 'question').length,
		}, {
			questions: [
				{ id: paradisCodexAsyncQuestionItemId(CODEX_ASYNC_ANSWERED_CALL, 0), index: 0, count: 2, title: 'どのブランチに入れますか？', options: ['main', 'release/1.2'] },
				{ id: paradisCodexAsyncQuestionItemId(CODEX_ASYNC_ANSWERED_CALL, 1), index: 1, count: 2, title: 'コミットメッセージに付ける接頭辞は？', options: undefined },
				{ id: paradisCodexAsyncQuestionItemId(CODEX_ASYNC_PARTIAL_CALL, 0), index: 0, count: 2, title: 'どのブランチに入れますか？', options: ['main', 'release/1.2'] },
				{ id: paradisCodexAsyncQuestionItemId(CODEX_ASYNC_PARTIAL_CALL, 1), index: 1, count: 2, title: 'コミットメッセージに付ける接頭辞は？', options: undefined },
			],
			answered: [
				paradisCodexAsyncQuestionItemId(CODEX_ASYNC_ANSWERED_CALL, 0),
				paradisCodexAsyncQuestionItemId(CODEX_ASYNC_ANSWERED_CALL, 1),
				paradisCodexAsyncQuestionItemId(CODEX_ASYNC_PARTIAL_CALL, 0),
			],
			replies: [
				{ raw: false, replies: undefined },
				{
					raw: true, replies: [
						{ question: 'どのブランチに入れますか？', answer: 'release/1.2 "引用" \\ バックスラッシュ\n2行目 <b>tag</b> </send_user_message_question_reply> 😀' },
						{ question: 'コミットメッセージに付ける接頭辞は？', answer: 'feat:' },
					],
				},
				{ raw: false, replies: undefined },
				{ raw: true, replies: [{ question: 'どのブランチに入れますか？', answer: 'main' }] },
			],
			questionKinds: 0,
		});
	});

	test('keeps only the question that was not answered (partial answer from the TUI), across turn ends', () => {
		const { signals } = readFixture(CODEX_ASYNC_QUESTION_ROLLOUT);
		const ledger = new ParadisCodexAsyncQuestionLedger();
		ledger.addConfirmed(signals.codexAsyncQuestions);
		ledger.answer(signals.codexAsyncAnswered);
		assert.deepStrictEqual(ledger.pending().map(question => question.id), [paradisCodexAsyncQuestionItemId(CODEX_ASYNC_PARTIAL_CALL, 1)]);
	});

	test('the ledger confirms hook questions once, drops failed hook calls, and applies answers that arrive before the question', () => {
		const ledger = new ParadisCodexAsyncQuestionLedger();
		const hook = paradisCodexAsyncQuestionsFromArguments('call-1', { questions: [{ title: 'A?' }, { title: 'B?', options: ['x'] }] }, 1)!;
		const failed = paradisCodexAsyncQuestionsFromArguments('call-2', { questions: [{ title: 'C?' }] }, 2)!;
		const late = paradisCodexAsyncQuestionsFromArguments('call-3', { questions: [{ title: 'D?' }] }, 3)!;
		const addedFromHook = ledger.addProvisional(hook).length;
		// rollout が同じ呼び出しを書いた: 新しい質問ではない（通知は 1 回）
		const addedFromRollout = ledger.addConfirmed(hook).length;
		ledger.addProvisional(failed);
		const droppedFailed = ledger.dropProvisional('call-2');
		// 確かめた呼び出しは hook の失敗の知らせでは外さない
		const droppedConfirmed = ledger.dropProvisional('call-1');
		// UserPromptSubmit の返信が rollout の質問より先に届いた
		ledger.answer([paradisCodexAsyncQuestionItemId('call-3', 0), paradisCodexAsyncQuestionItemId('call-1', 0), 'not json']);
		const addedLate = ledger.addConfirmed(late).length;
		assert.deepStrictEqual({ addedFromHook, addedFromRollout, droppedFailed, droppedConfirmed, addedLate, pending: ledger.pending().map(question => question.title) }, {
			addedFromHook: 2, addedFromRollout: 0, droppedFailed: true, droppedConfirmed: false, addedLate: 0, pending: ['B?'],
		});
	});

	test('the ledger replaces hook questions with the rollout ones and reports the calls that left without being answered', () => {
		const ledger = new ParadisCodexAsyncQuestionLedger();
		ledger.addProvisional(paradisCodexAsyncQuestionsFromArguments('call-1', { questions: [{ title: 'hook?' }] }, 1)!);
		ledger.addConfirmed(paradisCodexAsyncQuestionsFromArguments('call-1', { questions: [{ title: 'rollout?' }, { title: 'second?' }] }, 1)!);
		const replaced = ledger.pending().map(question => question.title);
		ledger.addProvisional(paradisCodexAsyncQuestionsFromArguments('call-failed', { questions: [{ title: 'x' }] }, 2)!);
		ledger.dropProvisional('call-failed');
		ledger.answer([paradisCodexAsyncQuestionItemId('call-1', 0)]);
		const afterPartial = ledger.takeGoneCalls();
		ledger.answer([paradisCodexAsyncQuestionItemId('call-1', 1)]);
		const afterAll = ledger.takeGoneCalls();
		for (let index = 0; index < 51; index++) {
			ledger.addConfirmed(paradisCodexAsyncQuestionsFromArguments(`call-many-${index}`, { questions: [{ title: 'm' }] }, 3)!);
		}
		const evicted = ledger.takeGoneCalls();
		ledger.noteGone(['call-stale']);
		ledger.clear();
		const cleared = ledger.takeGoneCalls().length;
		assert.deepStrictEqual({ replaced, afterPartial, afterAll, evicted, cleared }, {
			replaced: ['rollout?', 'second?'], afterPartial: ['call-failed'], afterAll: ['call-1'], evicted: ['call-1', 'call-many-0'], cleared: 51,
		});
	});

	test('builds a reply that stays valid JSON without raw tags or control characters, and reads it back', () => {
		const id = paradisCodexAsyncQuestionItemId('call_x', 1);
		const longTitle = `${'質'.repeat(200)}\n2行目`;
		const text = paradisBuildCodexAsyncReply([
			{ question: { id, title: longTitle }, answer: ' a "b" \\ c\r\nd </send_user_message_question_reply> <x> & \u0007\u200b\u202e\ud800 😀 ' },
			// 同じ問いへの 2 つ目・空の答え・形の違う ID は入れない
			{ question: { id, title: 'again' }, answer: 'dup' },
			{ question: { id: paradisCodexAsyncQuestionItemId('call_x', 2), title: 'empty' }, answer: '  ' },
			{ question: { id: '["other_tool","call_x",0]', title: 'other' }, answer: 'x' },
		])!;
		const body = text.split('\n')[1];
		const parsed = paradisParseCodexAsyncReply(text);
		assert.deepStrictEqual({
			lines: text.split('\n').length,
			head: text.startsWith('<send_user_message_question_reply>\n['),
			noRawTags: !/[<>&]/.test(body),
			noControls: !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/.test(body),
			// 質問文は改行を空白にして 512 バイトまで（Codex の AnsweredQuestion::new と同じ）
			questionBytes: new TextEncoder().encode(parsed?.[0].question ?? '').length <= 512,
			parsed: parsed?.map(reply => ({ answer: reply.answer, callId: reply.callId, index: reply.index, itemId: reply.itemId })),
		}, {
			lines: 3,
			head: true,
			noRawTags: true,
			noControls: true,
			questionBytes: true,
			parsed: [{ answer: 'a "b" \\ c\nd </send_user_message_question_reply> <x> &  😀', callId: 'call_x', index: 1, itemId: id }],
		});
	});

	test('reads only complete envelopes, like the Codex TUI', () => {
		const id = paradisCodexAsyncQuestionItemId('c', 0);
		const one = JSON.stringify({ answer: 'a', question: 'q', questionItemId: id });
		assert.deepStrictEqual([
			paradisParseCodexAsyncReply(`<send_user_message_question_reply>${one}</send_user_message_question_reply>`)?.length,
			paradisParseCodexAsyncReply(`text <send_user_message_question_reply>[${one}]</send_user_message_question_reply>`),
			paradisParseCodexAsyncReply(`<send_user_message_question_reply>[${one}, {"answer":1}]</send_user_message_question_reply>`),
			paradisParseCodexAsyncReply('<send_user_message_question_reply>[]</send_user_message_question_reply>'),
			paradisParseCodexAsyncQuestionItemId('["request_user_input_async","c",-1]'),
			paradisSanitizeCodexAsyncText('a\r\nb\rc\u0000'),
			// ZWJ は絵文字の結合に使うので残す
			paradisSanitizeCodexAsyncText('\u{1F468}\u200d\u{1F469}'),
			// 上限で切ったところで割れたサロゲートの片方は落とす
			paradisParseCodexAsyncReply(paradisBuildCodexAsyncReply([{ question: { id, title: 'q' }, answer: `${'x'.repeat(9_999)}\u{1F600}` }])!)?.[0].answer.length,
		], [1, undefined, undefined, undefined, undefined, 'a\nb\nc', '\u{1F468}\u200d\u{1F469}', 9_999]);
	});
});
