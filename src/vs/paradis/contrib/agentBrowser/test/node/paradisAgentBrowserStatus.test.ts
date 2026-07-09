/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisShouldSweepStaleWorkingStatus } from '../../common/paradisAgentStatusStale.js';

suite('ParadisAgentBrowserStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not complete a normal long-running tool', () => {
		assert.strictEqual(paradisShouldSweepStaleWorkingStatus('working', false, 0, 16 * 60 * 1000), false);
	});

	test('completes only a stale Stop background-task fallback', () => {
		assert.deepStrictEqual({
			beforeTimeout: paradisShouldSweepStaleWorkingStatus('working', true, 0, 15 * 60 * 1000),
			afterTimeout: paradisShouldSweepStaleWorkingStatus('working', true, 0, 15 * 60 * 1000 + 1),
			review: paradisShouldSweepStaleWorkingStatus('review', true, 0, 16 * 60 * 1000),
		}, { beforeTimeout: false, afterTimeout: true, review: false });
	});
});
