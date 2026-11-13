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

	function open(nested?: boolean, parent: HTMLElement = mainWindow.document.body): ITestModal {
		const backdrop = mainWindow.document.createElement('div');
		const modal = mainWindow.document.createElement('div');
		modal.tabIndex = -1;
		backdrop.appendChild(modal);
		parent.appendChild(backdrop);
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

	test('Tab and Shift+Tab wrap inside the modal instead of moving to the workbench behind it', () => {
		const modal = open();
		const [first, disabled, last] = ['first', 'disabled', 'last'].map(label => {
			const button = mainWindow.document.createElement('button');
			button.textContent = label;
			modal.modal.appendChild(button);
			return button;
		});
		disabled.disabled = true;
		const pressTab = (shiftKey: boolean) => {
			const target = mainWindow.document.activeElement ?? mainWindow.document.body;
			const event = new KeyboardEvent('keydown', { keyCode: 9, shiftKey, bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		};
		last.focus();
		const fromLast = { prevented: pressTab(false), focused: mainWindow.document.activeElement };
		first.focus();
		const fromFirst = { prevented: pressTab(true), focused: mainWindow.document.activeElement };
		modal.modal.focus();
		const fromModal = { prevented: pressTab(true), focused: mainWindow.document.activeElement };
		first.focus();
		const forwardFromFirst = pressTab(false);
		outside.focus();
		const fromOutside = pressTab(false);
		assert.deepStrictEqual({ fromLast, fromFirst, fromModal, forwardFromFirst, fromOutside }, {
			fromLast: { prevented: true, focused: first },
			fromFirst: { prevented: true, focused: last },
			fromModal: { prevented: true, focused: last },
			forwardFromFirst: false,
			fromOutside: false,
		});
		modal.close();
	});

	test('makes the workbench behind inert while open (also under a nested box), but not the floating layers, and releases it before returning focus', () => {
		const workbench = mainWindow.document.createElement('div');
		const grid = workbench.appendChild(mainWindow.document.createElement('div'));
		grid.className = 'monaco-grid-view';
		const editor = grid.appendChild(mainWindow.document.createElement('input'));
		const quickInput = workbench.appendChild(mainWindow.document.createElement('div'));
		quickInput.className = 'quick-input-widget';
		const webview = workbench.appendChild(mainWindow.document.createElement('div'));
		webview.appendChild(mainWindow.document.createElement('div')).className = 'webview-overlay-content';
		mainWindow.document.body.appendChild(workbench);
		try {
			editor.focus();
			const hub = open(false, workbench);
			const whileOpen = { grid: grid.inert, webview: webview.inert, quickInput: quickInput.inert };
			const nested = open(true, workbench);
			nested.close();
			const afterNested = grid.inert;
			hub.close();
			assert.deepStrictEqual({ whileOpen, afterNested, afterClose: [grid.inert, webview.inert], focusReturned: mainWindow.document.activeElement === editor }, {
				whileOpen: { grid: true, webview: true, quickInput: false },
				afterNested: true,
				afterClose: [false, false],
				focusReturned: true,
			});
		} finally {
			workbench.remove();
		}
	});
});
