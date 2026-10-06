/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Where a programmatic focus of a BrowserView came from, as far as Para Code knows. `container-focus`
 * is the workbench's `tryFocus()`, which focuses the page 10ms after its placeholder element gets
 * DOM focus; everything else is `other`.
 */
export type ParaBrowserViewFocusRequestOrigin = 'container-focus' | 'other';

type ParaBrowserViewFocusRequestListener = (view: object, origin: ParaBrowserViewFocusRequestOrigin) => void;

let listener: ParaBrowserViewFocusRequestListener | undefined;

/**
 * Receives every `BrowserView.focus()` that is about to focus the page (Para Code browser focus
 * diagnostics). One listener per process; setting another replaces it. Returns a function that removes it.
 */
export function paraSetBrowserViewFocusRequestListener(value: ParaBrowserViewFocusRequestListener): () => void {
	listener = value;
	return () => {
		if (listener === value) {
			listener = undefined;
		}
	};
}

/**
 * Called by `BrowserView.focus()` right before it focuses the page, so a focus that follows can be
 * told apart from one the page took itself. Never throws.
 */
export function paraNoteBrowserViewFocusRequest(view: object, origin: unknown): void {
	try {
		listener?.(view, origin === 'container-focus' ? 'container-focus' : 'other');
	} catch {
		// Diagnostics must never change focus behavior.
	}
}
