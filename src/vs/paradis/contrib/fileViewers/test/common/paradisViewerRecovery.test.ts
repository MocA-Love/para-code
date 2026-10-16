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

	test('a timeout before any signal waits once more instead of rebuilding, then counts as before', () => {
		const policy = new ParadisViewerRecoveryPolicy(2, 60_000, () => 1_000);

		assert.deepStrictEqual(
			[policy.recordTimeout(false), policy.recordTimeout(false), policy.recordTimeout(false), policy.recordTimeout(false)],
			['extend', 'retry', 'retry', 'fallback'],
		);
	});

	test('a timeout after a signal never waits longer', () => {
		const policy = new ParadisViewerRecoveryPolicy(2, 60_000, () => 1_000);

		assert.deepStrictEqual(
			[policy.recordTimeout(true), policy.recordTimeout(true), policy.recordTimeout(true)],
			['retry', 'retry', 'fallback'],
		);
	});

	test('tells whether a render arrived during the extra wait, and gives the next render its own extra wait', () => {
		const policy = new ParadisViewerRecoveryPolicy(2, 60_000, () => 1_000);
		const states: { extending: boolean; rescued?: boolean; action?: string }[] = [];

		policy.renderStarted();
		states.push({ extending: policy.extending, rescued: policy.recordSuccess() });
		policy.renderStarted();
		states.push({ extending: policy.extending, action: policy.recordTimeout(false) });
		states.push({ extending: policy.extending, rescued: policy.recordSuccess() });
		policy.renderStarted();
		states.push({ extending: policy.extending, action: policy.recordTimeout(false) });
		// 延長の後に描き直しが始まった（ファイルが変わった等）。待っているのはもう延長ではない。
		policy.renderStarted();
		states.push({ extending: policy.extending, action: policy.recordTimeout(false) });
		policy.reset();
		states.push({ extending: policy.extending, action: policy.recordTimeout(false) });

		assert.deepStrictEqual(states, [
			{ extending: false, rescued: false },
			{ extending: false, action: 'extend' },
			{ extending: true, rescued: true },
			{ extending: false, action: 'extend' },
			{ extending: false, action: 'retry' },
			{ extending: false, action: 'extend' },
		]);
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
