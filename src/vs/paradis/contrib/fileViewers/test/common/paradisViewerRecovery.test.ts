/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisViewerContentTimeout, ParadisViewerRecoveryPolicy } from '../../common/paradisViewerRecovery.js';

suite('ParadisViewerRecoveryPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('retries twice, then falls back to Raw', () => {
		const policy = new ParadisViewerRecoveryPolicy(2, 60_000, () => 1_000);

		assert.deepStrictEqual(
			[policy.recordFailure(), policy.recordFailure(), policy.recordFailure(), policy.recordFailure()],
			['retry', 'retry', 'fallback', 'fallback'],
		);
	});

	test('a successful render clears earlier failures', () => {
		const policy = new ParadisViewerRecoveryPolicy(2, 60_000, () => 1_000);
		policy.recordFailure();
		policy.recordFailure();
		policy.recordSuccess();

		assert.deepStrictEqual([policy.recordFailure(), policy.recordFailure()], ['retry', 'retry']);
	});

	test('large documents get a longer grace period, capped so a hang is still caught', () => {
		assert.deepStrictEqual(
			[0, 1_000, 2_000_000, 6_500_000, 500_000_000].map(paradisViewerContentTimeout),
			[8_000, 8_000, 16_000, 32_000, 40_000],
		);
	});

	test('failures older than the window no longer count towards the fallback', () => {
		let now = 1_000;
		const policy = new ParadisViewerRecoveryPolicy(2, 60_000, () => now);
		policy.recordFailure();
		policy.recordFailure();

		now += 60_000;

		assert.deepStrictEqual([policy.recordFailure(), policy.recordFailure(), policy.recordFailure()], ['retry', 'retry', 'fallback']);
	});
});
