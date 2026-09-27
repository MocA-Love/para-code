/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisGuessAgentKindFromTitle, paradisNextAttentionOnBell, paradisNextAttentionOnStatus, paradisTerminalTabIconKind } from '../../common/paradisTerminalTabStatus.js';

suite('paradisTerminalTabStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks a terminal that asks for permission, finishes work, or rings, unless the user is watching it', () => {
		assert.deepStrictEqual({
			asksPermission: paradisNextAttentionOnStatus('working', 'permission', undefined, false),
			asksQuestion: paradisNextAttentionOnStatus(undefined, 'question', undefined, false),
			finishesWithReview: paradisNextAttentionOnStatus('working', 'review', undefined, false),
			// 見ているスペースの完了はアプリがすぐ既読にするので、状態は「無し」へ落ちる。
			finishesAutoAcknowledged: paradisNextAttentionOnStatus('working', undefined, undefined, false),
			// 許可待ちから直接終わった（見ているスペースではすぐ既読になり review を経ない）。
			finishesFromPermission: paradisNextAttentionOnStatus('permission', undefined, 'waiting', false),
			finishesFromQuestionWithReview: paradisNextAttentionOnStatus('question', 'review', 'waiting', false),
			watchedFinish: paradisNextAttentionOnStatus('working', 'review', undefined, true),
			watchedPermission: paradisNextAttentionOnStatus('working', 'permission', undefined, true),
			startsWorking: paradisNextAttentionOnStatus(undefined, 'working', undefined, false),
			bell: paradisNextAttentionOnBell(undefined, false),
			watchedBell: paradisNextAttentionOnBell(undefined, true),
		}, {
			asksPermission: 'waiting',
			asksQuestion: 'waiting',
			finishesWithReview: 'done',
			finishesAutoAcknowledged: 'done',
			finishesFromPermission: 'done',
			finishesFromQuestionWithReview: 'done',
			watchedFinish: undefined,
			watchedPermission: undefined,
			startsWorking: undefined,
			bell: 'bell',
			watchedBell: undefined,
		});
	});

	test('keeps a finished mark until the user acts, but drops a waiting mark once it is answered', () => {
		assert.deepStrictEqual({
			doneSurvivesNewWork: paradisNextAttentionOnStatus('review', 'working', 'done', false),
			// モバイルから答えた場合も、もう呼んでいないタブに赤い点を残さない。
			waitingAnswered: paradisNextAttentionOnStatus('permission', 'working', 'waiting', false),
			waitingBeatsDone: paradisNextAttentionOnStatus('working', 'permission', 'done', false),
			doneBeatsBell: paradisNextAttentionOnStatus('working', 'review', 'bell', false),
			bellDoesNotHideWaiting: paradisNextAttentionOnBell('waiting', false),
		}, {
			doneSurvivesNewWork: 'done',
			waitingAnswered: undefined,
			waitingBeatsDone: 'waiting',
			doneBeatsBell: 'done',
			bellDoesNotHideWaiting: 'waiting',
		});
	});

	test('does not count a pane that stopped for the user after a denied permission as finished, but still counts other finishes', () => {
		assert.deepStrictEqual({
			// 許可を拒否して止まった（idle の合図で状態が消えた）: 緑の点を付けず、赤い点も外す
			deniedFromPermission: paradisNextAttentionOnStatus('permission', undefined, 'waiting', false, true),
			// 答えた時点で作業中へ戻っていた（モバイルが繋がっている構成）ときの拒否
			deniedFromWorking: paradisNextAttentionOnStatus('working', undefined, undefined, false, true),
			// 前に付いていた完了の印は、拒否では消さない（ユーザーが触るまで残す）
			deniedKeepsEarlierDone: paradisNextAttentionOnStatus('permission', undefined, 'done', false, true),
			// 承認して作業が進んでから終わった通常の完了は、今までどおり点を付ける
			approvedThenFinished: paradisNextAttentionOnStatus('working', 'review', undefined, false, false),
			approvedThenAutoAcknowledged: paradisNextAttentionOnStatus('working', undefined, undefined, false, false),
			permissionThenAutoAcknowledged: paradisNextAttentionOnStatus('permission', undefined, 'waiting', false, false),
		}, {
			deniedFromPermission: undefined,
			deniedFromWorking: undefined,
			deniedKeepsEarlierDone: 'done',
			approvedThenFinished: 'done',
			approvedThenAutoAcknowledged: 'done',
			permissionThenAutoAcknowledged: 'done',
		});
	});

	test('picks the tab icon from the state first, then the agent logo, and leaves plain shells alone', () => {
		assert.deepStrictEqual({
			working: paradisTerminalTabIconKind('working', undefined, 'claude'),
			permission: paradisTerminalTabIconKind('permission', 'waiting', 'codex'),
			question: paradisTerminalTabIconKind('question', undefined, undefined),
			unseenDone: paradisTerminalTabIconKind(undefined, 'done', 'claude'),
			unacknowledgedReview: paradisTerminalTabIconKind('review', undefined, 'codex'),
			idleClaude: paradisTerminalTabIconKind(undefined, undefined, 'claude'),
			idleCodex: paradisTerminalTabIconKind(undefined, 'bell', 'codex'),
			plainShell: paradisTerminalTabIconKind(undefined, undefined, undefined),
			titleClaude: paradisGuessAgentKindFromTitle('Claude Code'),
			titleCodex: paradisGuessAgentKindFromTitle('codex | 0199'),
			titleShell: paradisGuessAgentKindFromTitle('zsh'),
		}, {
			working: 'working',
			permission: 'permission',
			question: 'question',
			unseenDone: 'done',
			unacknowledgedReview: 'done',
			idleClaude: 'claude',
			idleCodex: 'codex',
			plainShell: undefined,
			titleClaude: 'claude',
			titleCodex: 'codex',
			titleShell: undefined,
		});
	});
});
