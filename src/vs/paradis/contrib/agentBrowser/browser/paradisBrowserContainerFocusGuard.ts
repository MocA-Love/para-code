/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { addDisposableListener, EventType, isAncestor } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Decides when the integrated browser's placeholder container must not hand focus to the page.
 *
 * While the page (a native view over the workbench) has focus, the workbench document keeps the
 * container as its active element. When the user then clicks something else in the workbench, the
 * document regains focus and Chromium delivers `focus` to that container again. Upstream treats that
 * as "focus the page" (10ms later), so a click on a spot that does not take DOM focus right away
 * (tab bar, toolbar, sash, status bar, ...) sends focus straight back into the page.
 *
 * The guard separates that re-activation focus (the first `focus` the container gets after the
 * document lost focus) from a deliberate one: it is only ignored when the user's last pointer press
 * in the workbench was outside the container and nothing focused the browser on purpose since.
 */
export class ParadisBrowserContainerFocusGuard {

	/** The workbench document lost focus and no element in it has received focus since. */
	private _documentBlurred = false;
	/** The user's last pointer press in the workbench landed outside the container. */
	private _leftByPointer = false;
	/** The pending container-to-page focus was started by a re-activation focus. */
	private _pendingFromReactivation = false;

	/** The workbench document lost focus (window blur), e.g. because the page took it. */
	noteDocumentBlur(): void {
		this._documentBlurred = true;
	}

	/** An element other than the container received focus. */
	noteFocusElsewhere(): void {
		this._documentBlurred = false;
		this._pendingFromReactivation = false;
	}

	/**
	 * The container received a `focus` event.
	 * @param documentHasFocus the workbench document has focus now. A `focus` while it has none (the
	 * container focused programmatically while the page holds focus) is not the user coming back, so it
	 * leaves the blurred state for the real re-activation.
	 * @returns whether the page may be focused from it.
	 */
	noteContainerFocusEvent(documentHasFocus: boolean): boolean {
		if (!documentHasFocus) {
			return true;
		}
		const reactivation = this._documentBlurred;
		this._documentBlurred = false;
		if (reactivation && this._leftByPointer) {
			return false;
		}
		this._pendingFromReactivation = reactivation;
		return true;
	}

	/**
	 * A pointer was pressed in the workbench document.
	 * @returns whether a pending page focus that came from a re-activation focus has to be cancelled.
	 */
	notePointerDown(insideContainer: boolean): boolean {
		this._leftByPointer = !insideContainer;
		const cancel = !insideContainer && this._pendingFromReactivation;
		if (cancel) {
			this._pendingFromReactivation = false;
		}
		return cancel;
	}

	/** Focus was asked for on purpose (editor focus, keyboard navigation) or the page took it. */
	noteDeliberateFocus(): void {
		this._leftByPointer = false;
	}

	/** The pending page focus ran or was cancelled. */
	notePendingFocusSettled(): void {
		this._pendingFromReactivation = false;
	}

	/** Whether showing the page again may focus it because the container is the active element. */
	mayFocusOnShow(): boolean {
		return !this._leftByPointer;
	}
}

/** The browser editor's root element (toolbar and container), see `BrowserEditor.createEditor`. */
const PARADIS_BROWSER_EDITOR_ROOT_SELECTOR = '.browser-root';

/**
 * Feeds the guard from the target window: pointer presses in the capture phase (so a handler that
 * stops propagation cannot hide them), window blur, and focus reaching any other element.
 * `onCancelPendingFocus` is called when a press outside the container has to cancel a page focus
 * started by a re-activation focus.
 */
export function paradisWatchBrowserContainerFocus(targetWindow: Window, container: HTMLElement, guard: ParadisBrowserContainerFocusGuard, onCancelPendingFocus: () => void): IDisposable {
	const store = new DisposableStore();
	// A press on the browser editor's own toolbar (back, reload, address bar, ...) counts as inside:
	// those buttons do not take DOM focus and rely on the re-delivered focus to hand focus back to the
	// page, as before. Hosts outside the browser editor (canvases) only count the container itself.
	const isInContainer = (target: EventTarget | null) => {
		if (!target || typeof (target as Partial<Node>).nodeType !== 'number') {
			return false;
		}
		const region = container.closest(PARADIS_BROWSER_EDITOR_ROOT_SELECTOR) ?? container;
		return isAncestor(target as Node, region);
	};
	store.add(addDisposableListener(targetWindow, EventType.POINTER_DOWN, (event: PointerEvent) => {
		if (guard.notePointerDown(isInContainer(event.target))) {
			onCancelPendingFocus();
		}
	}, true));
	store.add(addDisposableListener(targetWindow, EventType.BLUR, (event: FocusEvent) => {
		if (event.target === targetWindow) {
			guard.noteDocumentBlur();
		}
	}));
	store.add(addDisposableListener(targetWindow.document, EventType.FOCUS_IN, (event: FocusEvent) => {
		if (event.target !== container) {
			guard.noteFocusElsewhere();
		}
	}, true));
	return store;
}
