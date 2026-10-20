/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisOrderMobileCanvasHostDirs, paradisPickMobileCanvasHost } from '../../node/paradisMobileCanvasHostClient.js';

suite('ParadisMobileCanvasHostPick', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	interface ICandidate { readonly name: string; readonly version: string; readonly running: boolean }

	function pick(candidates: ICandidate[], expected: string | undefined): Promise<string | undefined> {
		return paradisPickMobileCanvasHost(candidates, expected, async candidate => candidate.running).then(found => found?.name);
	}

	test('host directories are ordered by protocol number, newest first', () => {
		assert.deepStrictEqual(paradisOrderMobileCanvasHostDirs(['v2', 'v10', 'tmp', 'v9', '.DS_Store']), ['v10', 'v9', 'v2', '.DS_Store', 'tmp']);
	});

	test('a stale record of another version does not hide the running host', async () => {
		const staleNewer: ICandidate = { name: 'stale', version: '0.2.0', running: false };
		const runningOther: ICandidate = { name: 'other', version: '0.1.15', running: true };
		const runningOurs: ICandidate = { name: 'ours', version: '0.1.16', running: true };
		assert.deepStrictEqual({
			// The first record left behind by a version that is no longer running is skipped.
			skipsStale: await pick([staleNewer, runningOurs], '0.1.16'),
			prefersSameVersion: await pick([runningOther, runningOurs], '0.1.16'),
			fallsBackToRunning: await pick([staleNewer, runningOther], '0.1.16'),
			anyVersionWhenUnknown: await pick([staleNewer, runningOther, runningOurs], undefined),
			nothingRunning: await pick([staleNewer], '0.1.16'),
		}, {
			skipsStale: 'ours',
			prefersSameVersion: 'ours',
			fallsBackToRunning: 'other',
			anyVersionWhenUnknown: 'other',
			nothingRunning: undefined,
		});
	});
});
