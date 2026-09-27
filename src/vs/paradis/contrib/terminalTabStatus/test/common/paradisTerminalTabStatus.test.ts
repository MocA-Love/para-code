/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisNextAttentionOnBell, paradisNextAttentionOnStatus } from '../../common/paradisTerminalTabStatus.js';

suite('paradisTerminalTabStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks a terminal that asks for permission, finishes work, or rings, unless the user is watching it', () => {
		assert.deepStrictEqual({
			asksPermission: paradisNextAttentionOnStatus('working', 'permission', undefined, false),
			asksQuestion: paradisNextAttentionOnStatus(undefined, 'question', undefined, false),
			finishesWithReview: paradisNextAttentionOnStatus('working', 'review', undefined, false),
			// 見ているスペースの完了はアプリがすぐ既読にするので、状態は「無し」へ落ちる。
			finishesAutoAcknowledged: paradisNextAttentionOnStatus('working', undefined, undefined, false),
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
});
