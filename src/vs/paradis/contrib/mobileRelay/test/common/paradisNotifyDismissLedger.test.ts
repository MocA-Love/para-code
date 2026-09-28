/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_NOTIFY_DISMISS_MAX_IDS, PARADIS_NOTIFY_DISMISS_TTL_MS, ParadisNotifyDismissLedger, paradisNotifyDismissOpened, paradisWithNotifyDismiss } from '../../common/paradisNotifyDismissLedger.js';

suite('ParadisNotifyDismissLedger (W2-27)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a pane acknowledgement settles only non-prompt notifications sent before it', () => {
		const ledger = new ParadisNotifyDismissLedger();
		ledger.record('q1', 'tok-a', 'agent-question', 100);
		ledger.record('d1', 'tok-a', 'agent-done', 200);
		ledger.record('x1', 'tok-b', 'agent-done', 250);
		ledger.markAcknowledged('tok-a', 300);
		ledger.record('d2', 'tok-a', 'agent-done', 400);
		// 許可・質問は確認済みにしても消させない（ID を指定した dismiss でだけ消す）。確認の後の通知も対象外
		assert.deepStrictEqual({ dismissable: ledger.dismissable(500), settled: ['d1', 'q1', 'd2', 'nope', undefined].map(id => ledger.isSettled(id)) }, { dismissable: ['d1'], settled: [true, false, false, false, false] });
	});

	test('only an opened dismiss settles a prompt or an unknown notification; clear-all settles the rest', () => {
		const ledger = new ParadisNotifyDismissLedger();
		ledger.record('q1', 'tok-a', 'agent-question', 100);
		ledger.record('q2', 'tok-a', 'agent-question', 100);
		ledger.record('d1', 'tok-a', 'agent-done', 100);
		ledger.markDismissed('q1', 150, true);
		// 「すべて消去」・旧アプリ（opened なし）: 質問と、覚えていない通知は消させない
		ledger.markDismissed('q2', 151, false);
		ledger.markDismissed('d1', 152, false);
		ledger.markDismissed('unknown-old', 153, false);
		ledger.markDismissed('unknown-opened', 160, true);
		assert.deepStrictEqual(ledger.dismissable(200), ['unknown-opened', 'd1', 'q1']);
	});

	test('is bounded in count and age and never lists the notification being sent', () => {
		const ledger = new ParadisNotifyDismissLedger();
		for (let i = 0; i < PARADIS_NOTIFY_DISMISS_MAX_IDS + 5; i++) {
			ledger.markDismissed(`n${i}`, 1_000 + i, true);
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
			opened: [paradisNotifyDismissOpened(new TextEncoder().encode('{"t":"dismiss","id":"x","opened":true}')), paradisNotifyDismissOpened(new TextEncoder().encode('{"t":"dismiss","id":"x"}')), paradisNotifyDismissOpened(new Uint8Array([0xff]))],
			withTags: JSON.parse(new TextDecoder().decode(paradisWithNotifyDismiss(bytes, ['a'.repeat(32)]))).dismiss,
			untouched: paradisWithNotifyDismiss(bytes, []) === bytes,
			malformed: paradisWithNotifyDismiss(new Uint8Array([0xff]), ['x']).length,
		}, { opened: [true, false, false], withTags: ['a'.repeat(32)], untouched: true, malformed: 1 });
	});
});
