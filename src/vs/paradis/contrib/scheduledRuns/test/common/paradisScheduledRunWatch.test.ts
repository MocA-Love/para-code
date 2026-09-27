/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisRunWatchState, PARADIS_RUN_WATCH_INITIAL, paradisAdvanceRunWatch, paradisRunWatchTimeoutReason } from '../../common/paradisScheduledRunWatch.js';

/** 状態の列を流す。`'acked'` は「review を既読にして状態から外した」（状態は undefined）。 */
function play(statuses: readonly (ParadisAgentStatus | undefined | 'acked')[]): { reports: string[]; state: IParadisRunWatchState } {
	let state = PARADIS_RUN_WATCH_INITIAL;
	const reports: string[] = [];
	for (const status of statuses) {
		const step = status === 'acked' ? paradisAdvanceRunWatch(state, undefined, true) : paradisAdvanceRunWatch(state, status);
		state = step.state;
		if (step.report) {
			reports.push(step.report);
		}
	}
	return { reports, state };
}

suite('paradisScheduledRunWatch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('completes after the first turn, through a permission wait', () => {
		assert.deepStrictEqual(play([undefined, 'working', 'permission', 'permission', 'working', 'review', 'working']).reports, ['needsAttention', 'running', 'completed']);
	});

	test('completes when the review was acknowledged by the viewer before the watcher saw it', () => {
		assert.deepStrictEqual(play(['working', 'acked']).reports, ['completed']);
	});

	test('does not complete when the status disappears without an acknowledgement, since that also happens when polling fails', () => {
		assert.deepStrictEqual([play([undefined, undefined]).reports, play(['working', undefined, 'working']).reports, play(['working', undefined]).state.phase], [[], [], 'running']);
	});

	test('explains why a run timed out', () => {
		assert.deepStrictEqual([
			paradisRunWatchTimeoutReason(play([]).state),
			paradisRunWatchTimeoutReason(play(['working']).state),
			paradisRunWatchTimeoutReason(play(['working', 'question']).state),
		], ['timeoutNoStatus', 'timeout', 'timeoutWhileWaiting']);
	});
});
