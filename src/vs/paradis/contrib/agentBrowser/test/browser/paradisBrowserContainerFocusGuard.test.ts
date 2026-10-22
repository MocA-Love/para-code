/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisBrowserContainerFocusGuard, paradisWatchBrowserContainerFocus } from '../../browser/paradisBrowserContainerFocusGuard.js';

suite('Paradis browser container focus guard', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('decides each focus path', () => {
		const results: Record<string, boolean> = {};

		// The page had focus, the user pressed outside the container, then the document came back.
		let guard = new ParadisBrowserContainerFocusGuard();
		guard.noteDeliberateFocus();
		guard.noteDocumentBlur();
		guard.notePointerDown(false);
		results.pressOutsideThenFocus = guard.noteContainerFocusEvent(true);

		// Same, but the focus event arrives before the press: the pending page focus is cancelled.
		guard = new ParadisBrowserContainerFocusGuard();
		guard.noteDocumentBlur();
		results.focusThenPressOutside = guard.noteContainerFocusEvent(true);
		results.focusThenPressOutsideCancels = guard.notePointerDown(false);

		// Pressing the container itself still focuses the page.
		guard = new ParadisBrowserContainerFocusGuard();
		guard.noteDocumentBlur();
		guard.notePointerDown(true);
		results.pressInside = guard.noteContainerFocusEvent(true);

		// Coming back without a press (Cmd+Tab) still focuses the page.
		guard = new ParadisBrowserContainerFocusGuard();
		guard.noteDocumentBlur();
		results.reactivateWithoutPress = guard.noteContainerFocusEvent(true);

		// A deliberate focus after the press outside (keyboard, editor focus) is not held back.
		guard = new ParadisBrowserContainerFocusGuard();
		guard.noteDocumentBlur();
		guard.notePointerDown(false);
		guard.noteDeliberateFocus();
		results.deliberateAfterPress = guard.noteContainerFocusEvent(true);

		// A press outside followed by focus moving within the document (address bar, suggestion click).
		guard = new ParadisBrowserContainerFocusGuard();
		guard.noteDocumentBlur();
		guard.notePointerDown(false);
		guard.noteFocusElsewhere();
		results.focusMovedThenContainer = guard.noteContainerFocusEvent(true);

		// A container focus while the document has no focus leaves the blurred state for the real return.
		guard = new ParadisBrowserContainerFocusGuard();
		guard.noteDocumentBlur();
		guard.notePointerDown(false);
		results.focusWithoutDocumentFocus = guard.noteContainerFocusEvent(false);
		results.laterReturn = guard.noteContainerFocusEvent(true);

		// Showing the page again after a press outside does not focus it; after a press inside it does.
		guard = new ParadisBrowserContainerFocusGuard();
		guard.notePointerDown(false);
		results.showAfterPressOutside = guard.mayFocusOnShow();
		guard.notePointerDown(true);
		results.showAfterPressInside = guard.mayFocusOnShow();

		// A press outside with no pending re-activation focus cancels nothing.
		guard = new ParadisBrowserContainerFocusGuard();
		results.pressOutsideCancelsNothing = guard.notePointerDown(false);

		assert.deepStrictEqual(results, {
			pressOutsideThenFocus: false,
			focusThenPressOutside: true,
			focusThenPressOutsideCancels: true,
			pressInside: true,
			reactivateWithoutPress: true,
			deliberateAfterPress: true,
			focusMovedThenContainer: true,
			focusWithoutDocumentFocus: true,
			laterReturn: false,
			showAfterPressOutside: false,
			showAfterPressInside: true,
			pressOutsideCancelsNothing: false,
		});
	});

	test('reads presses, window blur and focus elsewhere from the window', () => {
		const root = mainWindow.document.createElement('div');
		root.className = 'browser-root';
		const toolbarButton = mainWindow.document.createElement('a');
		const container = mainWindow.document.createElement('div');
		const inner = mainWindow.document.createElement('span');
		const outside = mainWindow.document.createElement('button');
		container.appendChild(inner);
		root.append(toolbarButton, container);
		mainWindow.document.body.append(root, outside);
		try {
			const guard = new ParadisBrowserContainerFocusGuard();
			const cancels: string[] = [];
			store.add(paradisWatchBrowserContainerFocus(mainWindow, container, guard, () => cancels.push('cancel')));
			const results: Record<string, boolean | number> = {};

			mainWindow.dispatchEvent(new FocusEvent('blur'));
			outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			results.ignoredAfterPressOutside = guard.noteContainerFocusEvent(true);

			guard.noteDeliberateFocus(); // the page took focus again
			mainWindow.dispatchEvent(new FocusEvent('blur'));
			results.allowedBeforePress = guard.noteContainerFocusEvent(true);
			outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			results.cancelled = cancels.length;

			mainWindow.dispatchEvent(new FocusEvent('blur'));
			inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			results.allowedAfterPressInside = guard.noteContainerFocusEvent(true);

			mainWindow.dispatchEvent(new FocusEvent('blur'));
			outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			toolbarButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			results.allowedAfterPressOnToolbar = guard.noteContainerFocusEvent(true);

			mainWindow.dispatchEvent(new FocusEvent('blur'));
			outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
			results.allowedAfterFocusElsewhere = guard.noteContainerFocusEvent(true);

			assert.deepStrictEqual(results, {
				ignoredAfterPressOutside: false,
				allowedBeforePress: true,
				cancelled: 1,
				allowedAfterPressInside: true,
				allowedAfterPressOnToolbar: true,
				allowedAfterFocusElsewhere: true,
			});
		} finally {
			root.remove();
			outside.remove();
		}
	});
});
