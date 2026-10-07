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
	readonly mv: HTMLElement | null;
	readonly t: string;
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
			traits = run({ kind: 'move', x: 10, y: 10, label: 'a', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
			aboveModal = pageState()?.h?.matches(':popover-open') === true;
		} finally {
			dialog.close();
			dialog.remove();
		}
		run({ kind: 'remove' });

		doc.documentElement.style.transform = 'translateX(1px)';
		const blocked = run({ kind: 'move', x: 10, y: 10, label: 'a', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
		const drawn = pageState()?.h ?? null;

		assert.deepStrictEqual(
			{ aboveModal, traits: (traits as { blocked?: unknown }).blocked, blocked: (blocked as { blocked?: unknown }).blocked, drawn },
			{ aboveModal: true, traits: false, blocked: true, drawn: null },
		);
	});

	test('moves play keyframes without rewriting the style attribute, and the name tag shows the state', async () => {
		const doc = mainWindow.document;
		const input = doc.createElement('input');
		input.type = 'password';
		doc.body.appendChild(input);
		try {
			run({ kind: 'move', x: 10, y: 10, label: 'Claude', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
			const mover = pageState()!.mv!;
			let styleWrites = 0;
			const observer = new MutationObserver(records => { styleWrites += records.length; });
			observer.observe(mover, { attributes: true, attributeFilter: ['style'] });
			run({ kind: 'move', x: 200, y: 40, label: 'Claude', durationMs: 120, frames: [{ x: 10, y: 10, r: 0, o: 0 }, { x: 120, y: 20, r: 20, o: 0.5 }, { x: 200, y: 40, r: 0, o: 1 }] });
			run({ kind: 'move', x: 300, y: 40, label: 'Claude', durationMs: 120, frames: [{ x: 200, y: 40, r: 0, o: 0 }, { x: 300, y: 40, r: 0, o: 1 }] });
			await Promise.resolve();
			observer.disconnect();
			const animated = mover.getAnimations().some(animation => animation.playState === 'running');
			run({ kind: 'status', label: 'Claude', status: 'script', text: 'Running a script' });
			const scripted = pageState()!.t;
			input.focus();
			run({ kind: 'focus', label: 'Claude', texts: { typing: 'Typing', secret: 'Typing (hidden)', page: 'Typing to the page' } });
			const typed = pageState()!.t;
			assert.deepStrictEqual(
				{ styleWrites, animated, scripted, typed },
				{ styleWrites: 0, animated: true, scripted: 'Claude \u00b7 Running a script', typed: 'Claude \u00b7 Typing (hidden)' },
			);
		} finally {
			input.remove();
		}
	});

	test('a tool state before any cursor leaves no element on the page, and comes back with the first move', () => {
		run({ kind: 'status', label: 'Claude', status: 'script', text: 'Running a script' });
		const before = pageState()?.h ?? null;
		run({ kind: 'move', x: 10, y: 10, label: 'Claude', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
		const shown = pageState()!.t;
		run({ kind: 'status', label: 'Claude', status: 'idle', text: '' });
		assert.deepStrictEqual({ before, shown, after: pageState()!.t }, { before: null, shown: 'Claude \u00b7 Running a script', after: 'Claude' });
	});
});
