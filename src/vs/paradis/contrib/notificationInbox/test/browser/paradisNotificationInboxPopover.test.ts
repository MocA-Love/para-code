/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ParadisNotificationInboxPopover, paradisInboxPopoverPlacement } from '../../browser/paradisNotificationInboxPopover.js';
import { IParadisInboxEntry, IParadisInboxSnapshot, IParadisNotificationInboxService } from '../../common/paradisNotificationInbox.js';

function entry(id: string, extra: Partial<IParadisInboxEntry>): IParadisInboxEntry {
	return { id, kind: 'review', paneKey: `pane-${id}`, instanceId: 1, windowId: 1, space: 'para-code', delivery: 'notified', at: Date.now(), read: false, live: true, ...extra };
}

suite('Paradis notification inbox popover', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('fits the popover into narrow windows instead of running off the right edge', () => {
		assert.deepStrictEqual([
			// 広いウィンドウ: ベルの右端にそろえる・ベルが無ければ右上
			paradisInboxPopoverPlacement(1200, 900),
			paradisInboxPopoverPlacement(1200, undefined),
			// ズームした最小幅のウィンドウ（CSS で 333px）: 両端の余白を残して縮める
			paradisInboxPopoverPlacement(333, 300),
			paradisInboxPopoverPlacement(333, undefined),
		], [
			{ left: 520, width: 380 },
			{ left: 812, width: 380 },
			{ left: 8, width: 317 },
			{ left: 8, width: 317 },
		]);
	});

	test('lists entries with their state and routes clicks to the pane or to read', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });

		const snapshot: IParadisInboxSnapshot = {
			entries: [
				entry('2', { kind: 'permission', tab: 'claude', message: 'Bash: npm test -- auth' }),
				entry('1', { kind: 'review', worktree: 'fix-login', read: true, live: false }),
			],
			attentionPaneCount: 1,
			unreadCount: 1,
			revision: 3,
		};
		const calls: string[] = [];
		const inboxService = {
			onDidChange: Event.None,
			snapshot,
			reveal: async (target: IParadisInboxEntry) => { calls.push(`reveal:${target.id}`); },
			markRead: async (ids: readonly string[]) => { calls.push(`read:${ids.join(',')}`); },
			markAllRead: async () => { calls.push('readAll'); },
		} as unknown as IParadisNotificationInboxService;

		const popover = store.add(new ParadisNotificationInboxPopover(
			{ anchor: undefined, onClose: () => calls.push('close') },
			{ activeContainer: container } as unknown as ILayoutService,
			inboxService,
			{} as IContextMenuService,
			new TestConfigurationService(),
			{} as ICommandService,
			NullHoverService,
		));

		const rows = [...container.getElementsByClassName('pnip-row')] as HTMLElement[];
		// 時刻（「now」など）は環境の言語で変わるので比べない。
		const text = (row: HTMLElement, className: string) => (row.getElementsByClassName(className)[0] as HTMLElement | undefined)?.textContent;
		const rendered = rows.map(row => ({
			classes: [...row.classList].filter(name => name !== 'pnip-row' && name !== 'paradis-focus-subtle').sort(),
			kind: text(row, 'pnip-kind'),
			space: text(row, 'pnip-space'),
			detail: text(row, 'pnip-detail'),
			message: text(row, 'pnip-message') ?? text(row, 'pnip-note'),
			ariaLabel: row.getAttribute('aria-label'),
			role: row.getAttribute('role'),
			tabIndex: row.tabIndex,
		}));
		const listRole = container.getElementsByClassName('pnip-list')[0].getAttribute('role');
		rows[0].click();
		rows[1].click();

		assert.deepStrictEqual({ listRole, rendered, calls }, {
			// Tab は一覧で 1 回だけ止まる（今の行だけ tabIndex = 0）
			listRole: 'listbox',
			rendered: [
				{ classes: ['unread'], kind: '許可待ち', space: 'para-code', detail: 'claude', message: 'Bash: npm test -- auth', ariaLabel: '未読 許可待ち para-code ／ claude Bash: npm test -- auth', role: 'option', tabIndex: 0 },
				// 「完了」は札にせず時刻の横に出す
				{ classes: ['closed'], kind: undefined, space: 'para-code', detail: 'fix-login', message: 'このペインは閉じています', ariaLabel: '既読 完了 para-code (fix-login) ', role: 'option', tabIndex: -1 },
			],
			calls: ['close', 'reveal:2', 'read:1'],
		});
		popover.dispose();
	});
});
