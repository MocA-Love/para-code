/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_NOTIFY_DISMISS_MAX_IDS, PARADIS_NOTIFY_DISMISS_TTL_MS, ParadisNotifyDismissLedger, paradisWithNotifyDismiss } from '../../common/paradisNotifyDismissLedger.js';

suite('ParadisNotifyDismissLedger (W2-27)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a pane acknowledgement settles only the notifications sent before it', () => {
		const ledger = new ParadisNotifyDismissLedger();
		ledger.record('q1', 'tok-a', 100);
		ledger.record('d1', 'tok-a', 200);
		ledger.record('x1', 'tok-b', 250);
		ledger.markAcknowledged('tok-a', 300);
		// 確認の後に出た許可・質問は、未回答なので消させない
		ledger.record('q2', 'tok-a', 400);
		assert.deepStrictEqual(ledger.dismissable(500), ['q1', 'd1']);
	});

	test('a dismiss from a phone settles that one notification, even one sent before a PC restart', () => {
		const ledger = new ParadisNotifyDismissLedger();
		ledger.record('q1', 'tok-a', 100);
		ledger.markDismissed('q1', 150);
		ledger.markDismissed('unknown', 160);
		assert.deepStrictEqual(ledger.dismissable(200), ['unknown', 'q1']);
	});

	test('is bounded in count and age and never lists the notification being sent', () => {
		const ledger = new ParadisNotifyDismissLedger();
		for (let i = 0; i < PARADIS_NOTIFY_DISMISS_MAX_IDS + 5; i++) {
			ledger.markDismissed(`n${i}`, 1_000 + i);
		}
		const now = 1_000 + PARADIS_NOTIFY_DISMISS_MAX_IDS + 5;
		assert.deepStrictEqual({
			count: ledger.dismissable(now).length,
			newestFirst: ledger.dismissable(now)[0],
			except: ledger.dismissable(now, `n${PARADIS_NOTIFY_DISMISS_MAX_IDS + 4}`).includes(`n${PARADIS_NOTIFY_DISMISS_MAX_IDS + 4}`),
			expired: ledger.dismissable(1_000 + PARADIS_NOTIFY_DISMISS_TTL_MS + PARADIS_NOTIFY_DISMISS_MAX_IDS + 5).length,
		}, { count: PARADIS_NOTIFY_DISMISS_MAX_IDS, newestFirst: `n${PARADIS_NOTIFY_DISMISS_MAX_IDS + 4}`, except: false, expired: 0 });
	});

	test('adds the tags to the push body only', () => {
		const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'agent-done', id: 'n', title: 't', body: 'b', at: 1 }));
		assert.deepStrictEqual({
			withTags: JSON.parse(new TextDecoder().decode(paradisWithNotifyDismiss(bytes, ['a'.repeat(32)]))).dismiss,
			untouched: paradisWithNotifyDismiss(bytes, []) === bytes,
			malformed: paradisWithNotifyDismiss(new Uint8Array([0xff]), ['x']).length,
		}, { withTags: ['a'.repeat(32)], untouched: true, malformed: 1 });
	});
});
