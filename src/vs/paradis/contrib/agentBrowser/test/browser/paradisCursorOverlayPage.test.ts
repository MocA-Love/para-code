/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCursorOverlayCommand, paradisBuildCursorOverlayScript } from '../../common/paradisCursorOverlay.js';

/** The generated script keeps its state on the window under this key (the isolated world in the app). */
const STATE_KEY = '__paraCodeAgentCursorOverlay';

interface IPageState {
	readonly h: HTMLElement | null;
}

/** Runs the page-side script against this test document, the way the isolated world would. */
function run(command: ParadisCursorOverlayCommand): unknown {
	return new Function(`return ${paradisBuildCursorOverlayScript(command)};`)();
}

function pageState(): IPageState | undefined {
	return (mainWindow as unknown as Record<string, IPageState | undefined>)[STATE_KEY];
}

suite('Paradis Cursor Overlay page script', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		run({ kind: 'remove' });
		mainWindow.document.documentElement.style.removeProperty('transform');
	});

	test('the cursor joins the top layer above a modal dialog, and stays off a page whose <html> shifts fixed positions', () => {
		const doc = mainWindow.document;
		const dialog = doc.createElement('dialog');
		doc.body.appendChild(dialog);
		dialog.showModal();
		let aboveModal: boolean;
		let traits: unknown;
		try {
			traits = run({ kind: 'move', x: 10, y: 10, label: 'a', durationMs: 0 });
			aboveModal = pageState()?.h?.matches(':popover-open') === true;
		} finally {
			dialog.close();
			dialog.remove();
		}
		run({ kind: 'remove' });

		doc.documentElement.style.transform = 'translateX(1px)';
		const blocked = run({ kind: 'move', x: 10, y: 10, label: 'a', durationMs: 0 });
		const drawn = pageState()?.h ?? null;

		assert.deepStrictEqual(
			{ aboveModal, traits: (traits as { blocked?: unknown }).blocked, blocked: (blocked as { blocked?: unknown }).blocked, drawn },
			{ aboveModal: true, traits: false, blocked: true, drawn: null },
		);
	});
});
