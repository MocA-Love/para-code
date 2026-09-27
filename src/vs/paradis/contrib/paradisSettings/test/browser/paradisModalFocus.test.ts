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

	function open(): ITestModal {
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
});
