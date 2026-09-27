/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { paradisHttpUrlFromTerminalLinkText, ParadisTerminalLinkCommandId, paradisTrackTerminalLinkAtMouse } from '../../browser/paradisTerminalLinkMenu.contribution.js';
import { mainWindow } from '../../../../../base/browser/window.js';

function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T };
}

suite('ParadisTerminalLinkMenu', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('only treats http(s) links as URLs', () => {
		assert.deepStrictEqual([
			'https://github.com/example/app/pull/128/files?diff=split&w=1',
			' http://localhost:5173/ ',
			'HTTPS://EXAMPLE.COM',
			'file:///Users/example/app/src/index.ts',
			'/Users/example/app/src/index.ts:12',
			'http://',
			'localhost:5173',
			'',
			undefined,
		].map(paradisHttpUrlFromTerminalLinkText), [
			'https://github.com/example/app/pull/128/files?diff=split&w=1',
			'http://localhost:5173/',
			'HTTPS://EXAMPLE.COM',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('adds copy / open-in-browser to the top of the terminal context menu only over a URL', () => {
		const items = MenuRegistry.getMenuItems(MenuId.TerminalInstanceContext)
			.filter(isIMenuItem)
			.filter(item => item.command.id === ParadisTerminalLinkCommandId.CopyLink || item.command.id === ParadisTerminalLinkCommandId.OpenLinkInIntegratedBrowser);
		const visible = (values: Record<string, unknown>) => items
			.filter(item => item.when?.evaluate(context(values)) ?? true)
			.map(item => item.command.id);

		assert.deepStrictEqual({
			groups: [...new Set(items.map(item => item.group))],
			overUrl: visible({ paradisTerminalUrlLinkAtMouse: true }),
			elsewhere: visible({}),
		}, {
			groups: ['0_0_paradisLink'],
			overUrl: [ParadisTerminalLinkCommandId.CopyLink, ParadisTerminalLinkCommandId.OpenLinkInIntegratedBrowser],
			elsewhere: [],
		});
	});

	test('re-reads the link every time a menu opens, so a menu opened elsewhere does not keep the last URL', () => {
		const root = mainWindow.document.createElement('div');
		const terminal = root.appendChild(mainWindow.document.createElement('div'));
		const padding = root.appendChild(mainWindow.document.createElement('div'));
		let hovered: string | undefined;
		let url: string | undefined = 'stale';
		store.add(paradisTrackTerminalLinkAtMouse(root, terminal, () => hovered, value => url = value, true));
		const press = (target: HTMLElement, init: MouseEventInit) => {
			target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...init }));
			target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, ...init }));
			return url;
		};

		hovered = 'https://example.com/a';
		const rightClickOnLink = press(terminal, { button: 2 });
		const rightClickOnPadding = press(padding, { button: 2 });
		hovered = undefined;
		const rightClickOnPlainText = press(terminal, { button: 2 });
		hovered = 'https://example.com/b';
		const controlClickOnMac = press(terminal, { button: 0, ctrlKey: true });
		// Shift+右クリックは mousedown の直後にメニューが開く（contextmenu を待たない）
		hovered = 'https://example.com/c';
		terminal.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, shiftKey: true }));
		const shiftRightClickOnLink = url;
		padding.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, shiftKey: true }));
		const shiftRightClickOnPadding = url;
		terminal.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
		terminal.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
		const keyboardMenu = url;

		assert.deepStrictEqual({ rightClickOnLink, rightClickOnPadding, rightClickOnPlainText, controlClickOnMac, shiftRightClickOnLink, shiftRightClickOnPadding, keyboardMenu }, {
			rightClickOnLink: 'https://example.com/a',
			rightClickOnPadding: undefined,
			rightClickOnPlainText: undefined,
			controlClickOnMac: 'https://example.com/b',
			shiftRightClickOnLink: 'https://example.com/c',
			shiftRightClickOnPadding: undefined,
			keyboardMenu: undefined,
		});
	});
});
