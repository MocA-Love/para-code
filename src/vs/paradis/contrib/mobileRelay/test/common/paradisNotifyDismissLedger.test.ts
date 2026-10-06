/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT, PARADIS_NOTIFY_DISMISS_MAX_IDS, PARADIS_NOTIFY_DISMISS_RETENTION_MS, PARADIS_NOTIFY_DISMISS_TTL_MS, ParadisNotifyDismissLedger, paradisDecodeNotifyDismissSync, paradisEncodeNotifyDismissLog, paradisNotifyAnswerFromHook, paradisNotifyDismissOpened, paradisNotifyInteractionId, paradisWithNotifyDismiss } from '../../common/paradisNotifyDismissLedger.js';

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

	test('settles prompts when an answer is established, by interaction id or by the end of the turn (Q241 A)', () => {
		const ledger = new ParadisNotifyDismissLedger();
		ledger.record('a1', 'tok-a', 'agent-question', 100, 'tool-1');
		ledger.record('a2', 'tok-a', 'agent-question', 110, 'tool-2');
		ledger.record('d1', 'tok-a', 'agent-done', 120);
		ledger.record('b1', 'tok-b', 'agent-question', 130, 'tool-1');
		const byId = ledger.markAnswered('tok-a', 'tool-1', 200);
		const again = ledger.markAnswered('tok-a', 'tool-1', 210);
		ledger.record('a3', 'tok-a', 'agent-question', 400, 'tool-3');
		// ターンの終わりは、その時刻より前の許可・質問だけ（完了や後から出た質問は片付けない）
		const byTurnEnd = ledger.markAnswered('tok-a', undefined, 300);
		assert.deepStrictEqual({ byId, again, byTurnEnd, settled: ['a1', 'a2', 'd1', 'b1', 'a3'].map(id => ledger.isSettled(id)) }, {
			byId: ['a1'], again: [], byTurnEnd: ['a2'], settled: [true, true, false, false, false],
		});
	});

	test('numbers each settlement once and returns the ones after a cursor', () => {
		const ledger = new ParadisNotifyDismissLedger({ newLedgerId: () => 'ledger-0001' });
		ledger.record('d1', 'tok-a', 'agent-done', 100);
		ledger.record('d2', 'tok-a', 'agent-done', 110);
		ledger.markDismissed('d2', 200, true);
		ledger.markDismissed('d2', 210, true);
		ledger.markAcknowledged('tok-a', 300);
		ledger.markDismissed('n9', 400, true);
		assert.deepStrictEqual({
			all: ledger.since(undefined, 0),
			after1: ledger.since('ledger-0001', 1).ids,
			otherLedger: ledger.since('ledger-9999', 2).ids,
			future: ledger.since('ledger-0001', 99).ids,
		}, {
			all: { ledger: 'ledger-0001', seq: 3, ids: ['d2', 'd1', 'n9'] },
			after1: ['d1', 'n9'],
			otherLedger: ['d2', 'd1', 'n9'],
			future: ['d2', 'd1', 'n9'],
		});
	});

	test('survives a restart: restores settlements and merges events that happened before the file was read', () => {
		const tokenKey = (token: string) => token.split('').reverse().join('');
		const before = new ParadisNotifyDismissLedger({ tokenKey, newLedgerId: () => 'ledger-0001' });
		before.record('q1', 'tok-a', 'agent-question', 100, 'tool-1');
		before.record('d1', 'tok-a', 'agent-done', 110);
		before.markDismissed('d1', 200, true);
		const file = before.serialize(300);
		const after = new ParadisNotifyDismissLedger({ tokenKey, newLedgerId: () => 'ledger-new1' });
		// 読み終える前に起きた片付け
		after.markDismissed('n2', 250, true);
		after.restore(file, 300);
		const answered = after.markAnswered('tok-a', 'tool-1', 400);
		assert.deepStrictEqual({
			rawTokenOnDisk: file.includes('tok-a'),
			log: after.since(undefined, 0),
			answered,
			dismissable: after.dismissable(500),
			broken: (() => { const ledger = new ParadisNotifyDismissLedger({ newLedgerId: () => 'ledger-kept' }); ledger.restore('{', 0); ledger.restore('{"v":1,"ledger":"x","seq":0}', 0); return ledger.ledgerId; })(),
		}, {
			rawTokenOnDisk: false,
			log: { ledger: 'ledger-0001', seq: 3, ids: ['d1', 'n2', 'q1'] },
			answered: ['q1'],
			dismissable: ['q1', 'n2', 'd1'],
			broken: 'ledger-kept',
		});
	});

	test('keeps at most 200 entries for 7 days', () => {
		const ledger = new ParadisNotifyDismissLedger();
		for (let i = 0; i < PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT + 3; i++) {
			ledger.markDismissed(`n${i}`, 1_000 + i, true);
		}
		const kept = ledger.since(undefined, 0).ids;
		const restored = new ParadisNotifyDismissLedger();
		restored.restore(ledger.serialize(1_000 + PARADIS_NOTIFY_DISMISS_RETENTION_MS + 100), 1_000 + PARADIS_NOTIFY_DISMISS_RETENTION_MS + 100);
		assert.deepStrictEqual({ count: kept.length, oldest: kept[0], afterAWeek: restored.since(undefined, 0).ids.length }, {
			count: PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT, oldest: 'n3', afterAWeek: PARADIS_NOTIFY_DISMISS_LEDGER_LIMIT + 3 - 100,
		});
	});

	test('reads answers from hook events and the dismiss-sync wire shapes', () => {
		const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
		assert.deepStrictEqual({
			hooks: [
				paradisNotifyAnswerFromHook('PostToolUse', 'tool-1'),
				paradisNotifyAnswerFromHook('PermissionDenied', undefined),
				paradisNotifyAnswerFromHook('Stop', undefined),
				paradisNotifyAnswerFromHook('UserPromptSubmit', 'x'),
				paradisNotifyAnswerFromHook('PermissionRequest', 'tool-1'),
				paradisNotifyAnswerFromHook('PreToolUse', 'tool-1'),
			],
			interactionId: [paradisNotifyInteractionId(bytes({ kind: 'agent-question', interactionId: 'tool-1' })), paradisNotifyInteractionId(bytes({ kind: 'agent-done' })), paradisNotifyInteractionId(new Uint8Array([0xff]))],
			sync: [paradisDecodeNotifyDismissSync(bytes({ t: 'dismiss-sync', ledger: 'ledger-0001', after: 4 })), paradisDecodeNotifyDismissSync(bytes({ t: 'dismiss-sync', ledger: 'bad id', after: -1 })), paradisDecodeNotifyDismissSync(bytes({ t: 'dismiss', id: 'x' }))],
			log: JSON.parse(new TextDecoder().decode(paradisEncodeNotifyDismissLog({ ledger: 'ledger-0001', seq: 2, ids: ['a'] }))),
		}, {
			hooks: [{ interactionId: 'tool-1' }, undefined, { interactionId: undefined }, { interactionId: undefined }, undefined, undefined],
			interactionId: ['tool-1', undefined, undefined],
			sync: [{ ledger: 'ledger-0001', after: 4 }, { ledger: undefined, after: 0 }, undefined],
			log: { t: 'dismiss-log', ledger: 'ledger-0001', seq: 2, ids: ['a'] },
		});
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
