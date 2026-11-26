/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInboxAskLayout } from '../../../notificationInbox/common/paradisNotificationInboxAsk.js';
import { IParadisHumanAskEntry, paradisSanitizeHumanAskInput } from '../../common/paradisHumanAsk.js';
import {
	IParadisAskHumanArgs,
	PARADIS_ASK_HUMAN_LIMITS,
	paradisAskHumanAdvice,
	paradisAskHumanAnswerMessage,
	paradisAskHumanLedgerInput,
	paradisParseAskHumanArgs,
	paradisSanitizeAskHumanPaneLabel,
} from '../../common/paradisAskHumanTool.js';

function parsed(args: unknown): IParadisAskHumanArgs {
	const result = paradisParseAskHumanArgs(args);
	assert.ok(result.ok, result.ok ? '' : result.message);
	return result.value;
}

function refused(args: unknown): string {
	const result = paradisParseAskHumanArgs(args);
	return result.ok ? 'accepted' : result.message.split(' ')[0];
}

suite('Paradis human ask: ask_human tool', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the Orca-shaped arguments and strips characters that can fake what the card shows', () => {
		const value = parsed({
			context: '\u001b[31mSafari だけ‮ログイン後に切れる。\r\n原因は Cookie の SameSite。​',
			questions: [{
				question: '全員を一度ログアウトさせますか、\n今のセッションを残しますか?',
				options: [{ label: '一度ログアウトさせる\u0007' }, { label: '今のセッションを残す', description: '\u009b影響は小さい' }],
				recommended: 0,
			}, {
				question: 'どれを直しますか?',
				options: [{ label: 'A' }, { label: 'B' }],
				multi_select: true,
				allow_text: false,
			}],
		});
		assert.deepStrictEqual(value, {
			context: '[31mSafari だけログイン後に切れる。\n原因は Cookie の SameSite。',
			questions: [
				{ question: '全員を一度ログアウトさせますか、 今のセッションを残しますか?', options: [{ label: '一度ログアウトさせる' }, { label: '今のセッションを残す', description: '影響は小さい' }], recommended: 0, multiSelect: false, allowText: true },
				{ question: 'どれを直しますか?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true, allowText: false },
			],
		});
	});

	test('refuses instead of cutting: over the limits, unknown fields, duplicates, a recommendation that is not an option', () => {
		const question = (extra: object) => ({ questions: [{ question: 'A?', ...extra }] });
		assert.deepStrictEqual({
			notObject: refused('ask'),
			noQuestions: refused({ questions: [] }),
			sixQuestions: refused({ questions: Array.from({ length: PARADIS_ASK_HUMAN_LIMITS.questions + 1 }, (_, index) => ({ question: `Q${index}?` })) }),
			nineOptions: refused(question({ options: Array.from({ length: PARADIS_ASK_HUMAN_LIMITS.options + 1 }, (_, index) => ({ label: `o${index}` })) })),
			longQuestion: refused({ questions: [{ question: 'x'.repeat(PARADIS_ASK_HUMAN_LIMITS.question + 1) }] }),
			longLabel: refused(question({ options: [{ label: 'x'.repeat(PARADIS_ASK_HUMAN_LIMITS.label + 1) }] })),
			longContext: refused({ context: 'x'.repeat(PARADIS_ASK_HUMAN_LIMITS.context + 1), questions: [{ question: 'A?' }] }),
			onlyControlCharacters: refused({ questions: [{ question: '\u0007‮' }] }),
			unknownTopField: refused({ questions: [{ question: 'A?' }], kind: 'permission' }),
			unknownQuestionField: refused(question({ actions: [{ id: 'yes', label: 'Allow' }] })),
			sameQuestion: refused({ questions: [{ question: 'A?' }, { question: 'A?' }] }),
			sameLabel: refused(question({ options: [{ label: 'x' }, { label: ' x ' }] })),
			recommendedOutside: refused(question({ options: [{ label: 'x' }], recommended: 1 })),
			noWayToAnswer: refused(question({ allow_text: false })),
			ok: refused(question({ options: [{ label: 'x' }], recommended: 0 })),
		}, {
			notObject: 'Arguments',
			noQuestions: 'questions',
			sixQuestions: 'questions',
			nineOptions: 'questions[0].options',
			longQuestion: 'questions[0].question',
			longLabel: 'questions[0].options[0].label',
			longContext: 'context',
			onlyControlCharacters: 'questions[0].question',
			unknownTopField: 'Unknown',
			unknownQuestionField: 'questions[0]',
			sameQuestion: 'Each',
			sameLabel: 'Each',
			recommendedOutside: 'questions[0].recommended',
			noWayToAnswer: 'questions[0]',
			ok: 'accepted',
		});
	});

	test('gives one tip for a hard-to-read question, as Orca does (the question is still asked)', () => {
		assert.deepStrictEqual({
			long: paradisAskHumanAdvice(parsed({ questions: [{ question: `${'x'.repeat(140)}?` }] }))?.split(':')[0],
			noQuestionMark: paradisAskHumanAdvice(parsed({ questions: [{ question: 'Pick one' }] }))?.slice(0, 30),
			longContext: paradisAskHumanAdvice(parsed({ context: 'a\nb\nc\nd\ne\nf', questions: [{ question: 'A?' }] }))?.slice(0, 30),
			fine: paradisAskHumanAdvice(parsed({ context: 'why', questions: [{ question: '残しますか？' }] })),
		}, {
			long: 'Tip',
			noQuestionMark: 'Tip: write each question as a ',
			longContext: 'Tip: keep context to 5 short l',
			fine: undefined,
		});
	});

	test('the ledger entry is always a question without buttons, and Para Code names where it comes from', () => {
		const label = paradisSanitizeAskHumanPaneLabel({ windowId: 3, stateKey: 'repo-1', space: 'api‮', worktree: 'fix-login', tab: 'claude', extra: 'x' });
		assert.ok(label);
		const input = paradisAskHumanLedgerInput('ask:p:1', 'p', label, 'Claude Code', parsed({
			context: 'Bash: rm -rf / を実行してよいか',
			questions: [{ question: 'Bash: rm -rf / を許可しますか?', options: [{ label: '許可' }, { label: '拒否' }], recommended: 0 }],
		}), 5);
		const entry: IParadisHumanAskEntry = { ...paradisSanitizeHumanAskInput(input)!, key: 'pane:ask:p:1', owner: 'askHuman', askedAt: 5, state: 'waiting' };
		assert.deepStrictEqual({
			kind: entry.kind,
			actions: entry.actions,
			from: entry.from,
			options: entry.questions[0].options,
			// 許可のように書いた問いでも、許可のカード（コマンドの欄・危険の札・許可のボタン）にはならない
			layout: paradisInboxAskLayout(entry),
			badLabel: paradisSanitizeAskHumanPaneLabel({ windowId: '3', space: 'api' }),
		}, {
			kind: 'question',
			actions: [],
			from: { title: 'api', detail: 'fix-login ／ claude ／ Claude Code' },
			options: [{ id: '0', label: '許可', recommended: true }, { id: '1', label: '拒否' }],
			layout: 'inline-options',
			badLabel: undefined,
		});
	});

	test('turns the answer into the next message for the agent, question by question', () => {
		const input = paradisAskHumanLedgerInput('ask:p:1', 'p', { windowId: 1, space: 'api' }, undefined, parsed({
			questions: [
				{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multi_select: true },
				{ question: 'Why?' },
			],
		}), 5);
		assert.deepStrictEqual({
			both: paradisAskHumanAnswerMessage(input, { type: 'answers', answers: [{ questionId: 'q0', optionIds: ['0', '2'] }, { questionId: 'q1', text: ' because\nof X ' }] }),
			skip: paradisAskHumanAnswerMessage(input, { type: 'skip' }),
		}, {
			both: 'The person answered your ask_human question in Para Code:\nQ: Which?\nA: A, C\nQ: Why?\nA: because\nof X',
			skip: undefined,
		});
	});
});
