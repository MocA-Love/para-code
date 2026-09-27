/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBrowserDownloadItem, ParadisBrowserDownloadState, paradisAggregateDownloadProgress, paradisHasNewlyFinished } from '../../common/paradisBrowserDownloads.js';

function item(id: string, state: ParadisBrowserDownloadState, receivedBytes = 0, totalBytes = 100): IParadisBrowserDownloadItem {
	return { id, filename: `${id}.bin`, savePath: `/dl/${id}.bin`, url: '', state, receivedBytes, totalBytes, openable: true, fromAgentSession: false, startTime: 0 };
}

suite('ParadisBrowserDownloads (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aggregates progress over running downloads only', () => {
		assert.deepStrictEqual([
			paradisAggregateDownloadProgress([]),
			paradisAggregateDownloadProgress([item('a', 'completed')]),
			paradisAggregateDownloadProgress([item('a', 'progressing', 25, 100), item('b', 'progressing', 75, 100), item('c', 'completed', 0, 1000)]),
			paradisAggregateDownloadProgress([item('a', 'progressing', 25, 100), item('b', 'progressing', 10, 0)]),
		], ['idle', 'idle', 0.5, undefined]);
	});

	test('marks completions and failures as unseen, but not cancellations', () => {
		const running = [item('a', 'progressing'), item('b', 'progressing')];
		assert.deepStrictEqual([
			paradisHasNewlyFinished(running, [item('a', 'completed'), item('b', 'progressing')]),
			paradisHasNewlyFinished(running, [item('a', 'cancelled'), item('b', 'progressing')]),
			paradisHasNewlyFinished(running, [item('a', 'progressing'), item('b', 'interrupted')]),
			paradisHasNewlyFinished([item('a', 'completed')], [item('a', 'completed')]),
			paradisHasNewlyFinished([], [item('fast', 'completed')]),
		], [true, false, true, false, true]);
	});
});
