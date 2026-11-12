/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisModalFocus } from '../../browser/paradisModalFocus.js';

interface ITestModal {
	readonly backdrop: HTMLElement;
	readonly modal: HTMLElement;
	readonly focus: ParadisModalFocus;
	escapes: number;
	closes: number;
	close(): void;
}

suite('ParadisModalFocus', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let fixtures: DisposableStore;
	let outside: HTMLInputElement;

	setup(() => {
		fixtures = store.add(new DisposableStore());
		outside = mainWindow.document.createElement('input');
		mainWindow.document.body.appendChild(outside);
	});

	teardown(() => {
		outside.remove();
	});

	function open(nested?: boolean): ITestModal {
		const backdrop = mainWindow.document.createElement('div');
		const modal = mainWindow.document.createElement('div');
		modal.tabIndex = -1;
		backdrop.appendChild(modal);
		mainWindow.document.body.appendChild(backdrop);
		const result = { backdrop, modal, escapes: 0, closes: 0 } as unknown as { -readonly [K in keyof ITestModal]: ITestModal[K] };
		result.close = () => {
			result.closes++;
			backdrop.remove();
			result.focus.dispose();
		};
		result.focus = fixtures.add(new ParadisModalFocus({
			backdrop,
			modal,
			onEscape: () => { result.escapes++; },
			close: () => result.close(),
			nested,
		}));
		modal.focus();
		return result;
	}

	function pressEscape(target: EventTarget, init: KeyboardEventInit = {}): void {
		target.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 27, bubbles: true, ...init }));
	}

	function pressTab(shiftKey = false): KeyboardEvent {
		const event = new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, shiftKey, bubbles: true, cancelable: true });
		(mainWindow.document.activeElement ?? mainWindow.document.body).dispatchEvent(event);
		return event;
	}

	test('Tab and Shift+Tab wrap at the ends of the modal instead of leaving it for the workbench behind', () => {
		const modal = open();
		const buttons = ['First', 'Disabled', 'Last'].map(label => {
			const button = mainWindow.document.createElement('button');
			button.textContent = label;
			modal.modal.appendChild(button);
			return button;
		});
		buttons[1].disabled = true;
		const name = (element: Element | null) => element === modal.modal ? 'modal' : element?.textContent ?? 'none';
		const fromModal = pressTab().defaultPrevented;
		const afterTabFromModal = name(mainWindow.document.activeElement);
		buttons[2].focus();
		const fromLast = pressTab().defaultPrevented;
		const afterTabFromLast = name(mainWindow.document.activeElement);
		const fromFirst = pressTab(true).defaultPrevented;
		const afterShiftTabFromFirst = name(mainWindow.document.activeElement);
		buttons[0].focus();
		const middle = pressTab().defaultPrevented;
		assert.deepStrictEqual({ fromModal, afterTabFromModal, fromLast, afterTabFromLast, fromFirst, afterShiftTabFromFirst, middle }, {
			fromModal: true,
			afterTabFromModal: 'First',
			fromLast: true,
			afterTabFromLast: 'First',
			fromFirst: true,
			afterShiftTabFromFirst: 'Last',
			middle: false,
		});
		modal.close();
	});

	test('returns focus to where it was before the modal opened', () => {
		outside.focus();
		const modal = open();
		assert.strictEqual(mainWindow.document.activeElement, modal.modal);
		modal.close();
		assert.strictEqual(mainWindow.document.activeElement, outside);
	});

	test('leaves focus where it is when it already moved out of the modal before closing', () => {
		const opened = mainWindow.document.createElement('input');
		mainWindow.document.body.appendChild(opened);
		outside.focus();
		const modal = open();
		// a button in the modal opened an editor, which took focus, and then the modal closed
		opened.focus();
		modal.close();
		const focused = mainWindow.document.activeElement;
		opened.remove();
		assert.strictEqual(focused, opened);
	});

	test('handles Escape from inside the modal and after focus fell to the body, but not from elsewhere or while composing', () => {
		const modal = open();
		pressEscape(modal.modal);
		(mainWindow.document.activeElement as HTMLElement | null)?.blur();
		pressEscape(mainWindow.document.body);
		outside.focus();
		pressEscape(outside);
		modal.modal.focus();
		pressEscape(modal.modal, { isComposing: true });
		assert.strictEqual(modal.escapes, 2);
		modal.close();
	});

	test('puts focus back on the same button after the content is re-rendered', async () => {
		const modal = open();
		const render = () => {
			modal.modal.textContent = '';
			const button = mainWindow.document.createElement('button');
			button.textContent = 'Run now';
			modal.modal.appendChild(button);
			return button;
		};
		const pressed = render();
		pressed.focus();
		// The test window may not have OS focus, in which case the browser does not fire focusin by itself.
		pressed.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		const replacement = render();
		await Promise.resolve();
		assert.strictEqual(mainWindow.document.activeElement, replacement);
		modal.close();
	});

	test('opening another modal closes the previous one, and only the newest handles Escape', () => {
		const first = open();
		const second = open();
		pressEscape(second.modal);
		assert.deepStrictEqual({ firstClosed: first.closes, firstEscapes: first.escapes, secondEscapes: second.escapes }, { firstClosed: 1, firstEscapes: 0, secondEscapes: 1 });
		second.close();
	});

	test('a nested box leaves the modal under it open and takes Escape, and the next modal closes both', () => {
		const hub = open();
		const nested = open(true);
		pressEscape(nested.modal);
		const whileNested = { hubClosed: hub.closes, hubEscapes: hub.escapes, nestedEscapes: nested.escapes };
		const next = open();
		assert.deepStrictEqual({ whileNested, hubClosed: hub.closes, nestedClosed: nested.closes }, {
			whileNested: { hubClosed: 0, hubEscapes: 0, nestedEscapes: 1 },
			hubClosed: 1,
			nestedClosed: 1,
		});
		next.close();
	});
});
