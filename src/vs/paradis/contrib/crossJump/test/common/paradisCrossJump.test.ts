/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentLiveEntry, ParadisAgentLiveStatus } from '../../../agentLiveWindow/common/paradisAgentLiveWindow.js';
import { paradisFormatCrossJumpAgo, paradisShouldOfferCrossJumpCreate, paradisSortCrossJumpAgents } from '../../common/paradisCrossJump.js';

function entry(token: string, status: ParadisAgentLiveStatus, since: number): IParadisAgentLiveEntry {
	return { token, instanceId: 1, stateKey: undefined, spaceName: 's', spaceColor: undefined, detail: '', title: token, status, since, lastOutputAt: 0 };
}

suite('paradisCrossJump', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('agents are ordered by attention first, then by the newest status change', () => {
		const sorted = paradisSortCrossJumpAgents([
			entry('idle', 'idle', 50),
			entry('review-old', 'review', 10),
			entry('working', 'working', 5),
			entry('review-new', 'review', 30),
			entry('question', 'question', 1),
			entry('permission', 'permission', 2),
			entry('unknown', 'later' as ParadisAgentLiveStatus, 99),
		]);
		assert.deepStrictEqual(sorted.map(e => e.token), ['permission', 'question', 'working', 'review-new', 'review-old', 'idle', 'unknown']);
	});

	test('elapsed time and the create row', () => {
		assert.deepStrictEqual({
			ago: [0, 59_000, 60_000, 59 * 60_000, 2 * 3600_000, 50 * 3600_000].map(paradisFormatCrossJumpAgo),
			create: [
				paradisShouldOfferCrossJumpCreate('', ['a']),
				paradisShouldOfferCrossJumpCreate('  ', ['a']),
				paradisShouldOfferCrossJumpCreate('Login', ['sample-login']),
				paradisShouldOfferCrossJumpCreate('login-v2', ['sample-login']),
			],
		}, {
			ago: ['今', '今', '1 分前', '59 分前', '2 時間前', '2 日前'],
			create: [false, false, false, true],
		});
	});
});
