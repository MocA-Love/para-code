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

	test('a second clip is dropped while the first send is in flight', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-1', 1_000);

		assert.deepStrictEqual({
			firstStarted: subscriptions.beginSend('mobile-1') !== undefined,
			secondStarted: subscriptions.beginSend('mobile-1') !== undefined,
		}, { firstStarted: true, secondStarted: false });
	});

	test('a stale completion after drop does not release the replacement send', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-1', 1_000);
		const staleSend = subscriptions.beginSend('mobile-1')!;

		subscriptions.drop('mobile-1');
		subscriptions.start('mobile-1', 'sid-2', 2_000);
		const replacementSend = subscriptions.beginSend('mobile-1')!;
		subscriptions.endSend(staleSend);

		assert.strictEqual(subscriptions.beginSend('mobile-1'), undefined);
		subscriptions.endSend(replacementSend);
		assert.notStrictEqual(subscriptions.beginSend('mobile-1'), undefined);
	});

	test('a stale completion after clear does not release the replacement send', () => {
		const subscriptions = new ParadisVoiceSubscriptions(TTL_MS);
		subscriptions.start('mobile-1', 'sid-1', 1_000);
		const staleSend = subscriptions.beginSend('mobile-1')!;

		subscriptions.clear();
		subscriptions.start('mobile-1', 'sid-2', 2_000);
		const replacementSend = subscriptions.beginSend('mobile-1')!;
		subscriptions.endSend(staleSend);

		assert.strictEqual(subscriptions.beginSend('mobile-1'), undefined);
		subscriptions.endSend(replacementSend);
		assert.notStrictEqual(subscriptions.beginSend('mobile-1'), undefined);
	});

});
