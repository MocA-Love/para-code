/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisNotificationInboxLedger } from '../../common/paradisNotificationInboxLedger.js';
import { paradisRenderTrayBell, paradisSanitizeTrayState, paradisTrayMenuModel, paradisTrayStateFromSnapshot } from '../../common/paradisNotificationTray.js';

/** (x, y) の BGRA を [r, g, b, a] で返す。 */
function pixel(bitmap: Uint8Array, size: number, x: number, y: number): number[] {
	const offset = (y * size + x) * 4;
	return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]];
}

suite('Paradis notification tray', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the menu from the panes that need attention, newest first and at most five', () => {
		const ledger = new ParadisNotificationInboxLedger(() => Date.now());
		const tokens = ['a', 'b', 'c', 'd', 'e', 'f'];
		ledger.setLivePanes('window:1', tokens);
		for (const token of tokens) {
			ledger.record({ kind: 'permission', paneKey: token, instanceId: 1, windowId: 1, space: `space-${token}`, delivery: 'notified' });
		}
		ledger.record({ kind: 'review', paneKey: 'a', instanceId: 1, windowId: 1, space: 'space-a', tab: 'claude', delivery: 'notified' });

		const state = paradisSanitizeTrayState(JSON.parse(JSON.stringify(paradisTrayStateFromSnapshot(ledger.snapshot()))));
		const menu = paradisTrayMenuModel(state, true).map(item => item.kind === 'entry' ? `${item.kind}:${item.entryId}` : item.kind);

		assert.deepStrictEqual({ attentionCount: state.attentionCount, menu }, {
			attentionCount: 6,
			menu: ['header', 'entry:7', 'entry:6', 'entry:5', 'entry:4', 'entry:3', 'separator', 'openInbox', 'openApp', 'separator', 'hideIcon'],
		});
	});

	test('drops malformed tray state instead of breaking the menu', () => {
		assert.deepStrictEqual(paradisSanitizeTrayState({ attentionCount: -2, revision: 4, items: [{ entryId: 1 }, { entryId: 'x', kind: 'review', location: 'l', at: 1 }] }), {
			attentionCount: 0,
			items: [{ entryId: 'x', kind: 'review', location: 'l', at: 1 }],
			revision: 4,
		});
		assert.deepStrictEqual(paradisSanitizeTrayState(undefined), { attentionCount: 0, items: [], revision: 0 });
	});

	test('draws a bell with an optional red attention dot', () => {
		const size = 36;
		const plain = paradisRenderTrayBell(size, { r: 0, g: 0, b: 0 }, false);
		const attention = paradisRenderTrayBell(size, { r: 255, g: 255, b: 255 }, true);

		assert.deepStrictEqual({
			corner: pixel(plain, size, 0, 0),
			bellBody: pixel(plain, size, 18, 20),
			dot: pixel(attention, size, Math.round(0.8 * size), Math.round(0.2 * size)),
			bodyWithDot: pixel(attention, size, 18, 20),
		}, {
			corner: [0, 0, 0, 0],
			bellBody: [0, 0, 0, 255],
			dot: [0xe5, 0x53, 0x4b, 255],
			bodyWithDot: [255, 255, 255, 255],
		});
	});
});
