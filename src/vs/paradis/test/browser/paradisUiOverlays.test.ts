/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IContextMenuDelegate } from '../../../base/browser/contextmenu.js';
import { mainWindow } from '../../../base/browser/window.js';
import { toAction } from '../../../base/common/actions.js';
import { Codicon } from '../../../base/common/codicons.js';
import { AppResourcePath, FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IContextMenuService, IContextViewDelegate, IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { PARADIS_MENU_CLASS, paradisMenuItem, showParadisMenu } from '../../browser/paradisMenu.js';
import { paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../browser/paradisModal.js';
import { showParadisPopover } from '../../browser/paradisPopover.js';

const STYLESHEETS: AppResourcePath[] = [
	'vs/paradis/browser/media/paradisTokens.css',
	'vs/paradis/browser/media/paradisModal.css',
];

function loadStylesheet(path: AppResourcePath): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri(path).toString(true);
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error(`could not load ${path}`)), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

suite('Paradis UI overlays (dialog, menu, pop-up)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let links: HTMLLinkElement[] = [];

	setup(async () => {
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		links = await Promise.all(STYLESHEETS.map(loadStylesheet));
	});

	teardown(() => {
		workbench.remove();
		for (const link of links) {
			link.remove();
		}
		links = [];
	});

	test('dialog: the header bar is 52px with the title and the actions; the box uses the outer radius', () => {
		const box = mainWindow.document.createElement('div');
		box.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		workbench.appendChild(box);
		const head = renderParadisModalHead(box, 'コマンドプリセット');
		const close = mainWindow.document.createElement('button');
		head.actions.appendChild(close);
		assert.deepStrictEqual({
			title: [head.title.tagName, head.title.textContent],
			height: head.element.getBoundingClientRect().height,
			actionsLast: head.element.lastElementChild === head.actions,
			radius: mainWindow.getComputedStyle(box).borderTopLeftRadius,
		}, {
			title: ['H2', 'コマンドプリセット'],
			height: 52,
			actionsLast: true,
			radius: '12px',
		});
	});

	test('menu: items get the icon and danger classes; the menu carries the kit class', () => {
		const shown: IContextMenuDelegate[] = [];
		const contextMenuService = { showContextMenu: (delegate: IContextMenuDelegate) => shown.push(delegate) } as unknown as IContextMenuService;
		const edit = paradisMenuItem(toAction({ id: 'edit', label: '編集', run: () => { } }), { icon: Codicon.edit });
		const remove = paradisMenuItem(toAction({ id: 'delete', label: '削除...', run: () => { } }), { icon: Codicon.trash, danger: true });
		const anchor = mainWindow.document.createElement('button');
		showParadisMenu(contextMenuService, { anchor, actions: [edit, remove] });
		assert.deepStrictEqual({
			edit: edit.class,
			remove: remove.class,
			menuClass: shown[0].getMenuClassName?.(),
			anchor: shown[0].getAnchor() === anchor,
			actions: shown[0].getActions().map(action => action.id),
		}, {
			edit: 'paradis-menu-icon codicon codicon-edit',
			remove: 'paradis-menu-icon codicon codicon-trash paradis-menu-danger',
			menuClass: PARADIS_MENU_CLASS,
			anchor: true,
			actions: ['edit', 'delete'],
		});
	});

	test('pop-up: opens in the context view under its button with a header, Escape closes it and focus goes back to the button', () => {
		let delegate: IContextViewDelegate | undefined;
		const container = mainWindow.document.createElement('div');
		workbench.appendChild(container);
		let rendered: { dispose(): void } | null = null;
		const contextViewService = {
			showContextView: (d: IContextViewDelegate) => {
				delegate = d;
				rendered = d.render(container);
				return { close: () => { } };
			},
			// 本家の ContextView と同じ順: onHide を呼んでから箱を隠し、描いたものを捨てる
			hideContextView: () => {
				delegate?.onHide?.();
				container.replaceChildren();
				rendered?.dispose();
				rendered = null;
			},
		} as unknown as IContextViewService;
		const anchor = mainWindow.document.createElement('button');
		workbench.appendChild(anchor);
		let hidden = 0;
		const popover = store.add(showParadisPopover(contextViewService, {
			anchor,
			title: 'ポート',
			render: body => {
				const button = body.appendChild(mainWindow.document.createElement('button'));
				button.textContent = '開く';
				return button;
			},
			onHide: () => hidden++,
		}));
		const box = container.querySelector<HTMLElement>('.paradis-popover')!;
		const opened = {
			anchor: delegate?.getAnchor() === anchor,
			role: box.getAttribute('role'),
			label: box.getAttribute('aria-label'),
			head: box.querySelector('.paradis-popover-head')?.textContent,
			focus: mainWindow.document.activeElement?.textContent,
		};
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		popover.dispose();
		assert.deepStrictEqual({ opened, closed: container.childElementCount, hidden, focusBack: mainWindow.document.activeElement === anchor }, {
			opened: { anchor: true, role: 'dialog', label: 'ポート', head: 'ポート', focus: '開く' },
			closed: 0,
			hidden: 1,
			focusBack: true,
		});
	});
});
