/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisVoiceSubscriptions } from '../../common/paradisVoiceSubscriptions.js';

const TTL_MS = 60_000;

suite('ParadisVoiceSubscriptions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('same SID start refreshes the subscription TTL', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-1', 1_000);
		subscriptions.start('mobile-1', 'sid-1', 41_000);

		assert.deepStrictEqual(
			subscriptions.recipients(101_000, () => true),
			[{ mobileId: 'mobile-1', sid: 'sid-1' }],
		);
	});

	test('stop with a different SID does not remove the current subscription', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-current', 1_000);

		assert.strictEqual(subscriptions.stop('mobile-1', 'sid-stale'), false);
		assert.deepStrictEqual(
			subscriptions.recipients(2_000, () => true),
			[{ mobileId: 'mobile-1', sid: 'sid-current' }],
		);
	});

	test('stop with the current SID removes the subscription', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-current', 1_000);

		assert.strictEqual(subscriptions.stop('mobile-1', 'sid-current'), true);
		assert.deepStrictEqual(subscriptions.recipients(2_000, () => true), []);
	});

	test('expired subscriptions are removed from later deliveries', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-1', 1_000);

		assert.deepStrictEqual(subscriptions.recipients(61_001, () => true), []);
		assert.deepStrictEqual(subscriptions.recipients(61_002, () => true), []);
	});

	test('offline subscriptions are excluded without being discarded', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-1', 1_000);

		assert.deepStrictEqual(subscriptions.recipients(2_000, () => false), []);
		assert.deepStrictEqual(
			subscriptions.recipients(3_000, () => true),
			[{ mobileId: 'mobile-1', sid: 'sid-1' }],
		);
	});

	test('isSubscribed follows the current SID and the TTL', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-1', 1_000);

		assert.deepStrictEqual([
			subscriptions.isSubscribed('mobile-1', 'sid-1', 2_000),
			subscriptions.isSubscribed('mobile-1', 'sid-other', 2_000),
			subscriptions.isSubscribed('mobile-1', 'sid-1', 61_001),
			subscriptions.isSubscribed('mobile-2', 'sid-1', 2_000),
		], [true, false, false, false]);
	});
});
