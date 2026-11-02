/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { StandardKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IParadisPopoverRow, ParadisPopoverRows, paradisWatchPopoverDismiss } from '../../browser/paradisAnchoredPopover.js';

suite('Paradis anchored popover', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: HTMLElement;

	setup(() => {
		root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
	});

	teardown(() => {
		root.remove();
	});

	function make(tag: string, parent: HTMLElement = root): HTMLElement {
		const element = mainWindow.document.createElement(tag);
		parent.appendChild(element);
		return element;
	}

	test('closes on an outside press and only on the chosen events, never for its own scroll or the anchor', () => {
		const element = make('div');
		const inner = make('button', element);
		const anchor = make('button');
		const menu = make('div');
		menu.className = 'context-view';
		const outside = make('div');
		const closes: string[] = [];
		let last = '';
		store.add(paradisWatchPopoverDismiss(mainWindow, { element, anchor, close: () => closes.push(last), isAlsoInside: target => target === menu, closeOnScroll: true, closeOnResize: true }));
		const fire = (name: string, target: EventTarget, event: Event) => {
			last = name;
			target.dispatchEvent(event);
		};
		fire('inside press', inner, new MouseEvent('mousedown', { bubbles: true }));
		fire('anchor press', anchor, new MouseEvent('mousedown', { bubbles: true }));
		fire('menu press', menu, new MouseEvent('mousedown', { bubbles: true }));
		fire('own scroll', element, new Event('scroll'));
		fire('blur (not chosen)', mainWindow, new Event('blur'));
		fire('outside press', outside, new MouseEvent('mousedown', { bubbles: true }));
		fire('outside scroll', outside, new Event('scroll'));
		fire('resize', mainWindow, new Event('resize'));
		assert.deepStrictEqual(closes, ['outside press', 'outside scroll', 'resize']);
	});

	test('closes when the focus moves out, but not to the anchor', () => {
		const element = make('div');
		const anchor = make('button');
		const outside = make('button');
		let closes = 0;
		store.add(paradisWatchPopoverDismiss(mainWindow, { element, anchor, close: () => closes++, closeOnFocusOut: true }));
		element.dispatchEvent(new FocusEvent('focusout', { relatedTarget: anchor }));
		const toAnchor = closes;
		element.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside }));
		assert.deepStrictEqual([toAnchor, closes], [0, 1]);
	});

	test('rows move with the keys, wrap at the ends, run on Enter and Space, and Esc closes', () => {
		const ran: string[] = [];
		const rows = new ParadisPopoverRows<IParadisPopoverRow>();
		for (const name of ['a', 'b', 'c']) {
			const element = make('button');
			element.tabIndex = -1;
			if (name === 'b') {
				element.classList.add('is-selected');
			}
			rows.add({ element, run: () => ran.push(name) });
		}
		let closed = 0;
		const press = (key: string, keyCode: number, shiftKey = false) => rows.handleKeyDown(new StandardKeyboardEvent(new KeyboardEvent('keydown', { key, keyCode, shiftKey })), () => closed++);
		const focusedName = () => ['a', 'b', 'c'][rows.rows.findIndex(row => row.element.classList.contains('is-focused'))];
		const seen: string[] = [];
		rows.focusInitial();
		seen.push(focusedName());
		press('ArrowDown', 40); seen.push(focusedName());
		press('ArrowDown', 40); seen.push(focusedName());
		press('Tab', 9, true); seen.push(focusedName());
		press('Home', 36); seen.push(focusedName());
		press('End', 35); seen.push(focusedName());
		press('Enter', 13);
		press(' ', 32);
		press('Escape', 27);
		assert.deepStrictEqual({ seen, ran, closed, active: mainWindow.document.activeElement === rows.focused?.element }, {
			seen: ['b', 'c', 'a', 'c', 'a', 'c'],
			ran: ['c', 'c'],
			closed: 1,
			active: true,
		});
	});
});
