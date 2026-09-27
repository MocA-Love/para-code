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
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ParadisNotificationInboxPopover } from '../../browser/paradisNotificationInboxPopover.js';
import { IParadisInboxEntry, IParadisInboxSnapshot, IParadisNotificationInboxService } from '../../common/paradisNotificationInbox.js';

function entry(id: string, extra: Partial<IParadisInboxEntry>): IParadisInboxEntry {
	return { id, kind: 'review', paneKey: `pane-${id}`, instanceId: 1, windowId: 1, space: 'para-code', delivery: 'notified', at: Date.now(), read: false, live: true, ...extra };
}

suite('Paradis notification inbox popover', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

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
		));

		const rows = [...container.getElementsByClassName('pnip-row')] as HTMLElement[];
		// 時刻（「now」など）は環境の言語で変わるので比べない。
		const text = (row: HTMLElement, className: string) => (row.getElementsByClassName(className)[0] as HTMLElement | undefined)?.textContent;
		const rendered = rows.map(row => ({
			classes: [...row.classList].filter(name => name !== 'pnip-row').sort(),
			kind: text(row, 'pnip-kind'),
			location: text(row, 'pnip-location'),
			detail: text(row, 'pnip-message') ?? text(row, 'pnip-note'),
		}));
		rows[0].click();
		rows[1].click();

		assert.deepStrictEqual({ rendered, calls }, {
			rendered: [
				{ classes: ['unread'], kind: '許可待ち', location: 'para-code ／ claude', detail: 'Bash: npm test -- auth' },
				{ classes: ['closed'], kind: '完了', location: 'para-code (fix-login)', detail: 'このペインは閉じています' },
			],
			calls: ['close', 'reveal:2', 'read:1'],
		});
		popover.dispose();
	});
});
