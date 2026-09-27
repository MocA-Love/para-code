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

function play(statuses: readonly (ParadisAgentStatus | undefined)[]): { reports: string[]; state: IParadisRunWatchState } {
	let state = PARADIS_RUN_WATCH_INITIAL;
	const reports: string[] = [];
	for (const status of statuses) {
		const step = paradisAdvanceRunWatch(state, status);
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

	test('treats a status that disappears after work as completed, but not before any status', () => {
		assert.deepStrictEqual([play([undefined, undefined]).reports, play(['working', undefined]).reports], [[], ['completed']]);
	});

	test('explains why a run timed out', () => {
		assert.deepStrictEqual([
			paradisRunWatchTimeoutReason(play([]).state),
			paradisRunWatchTimeoutReason(play(['working']).state),
			paradisRunWatchTimeoutReason(play(['working', 'question']).state),
		], ['timeoutNoStatus', 'timeout', 'timeoutWhileWaiting']);
	});
});
