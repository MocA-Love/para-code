/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisActivityBusyIndicator } from '../../electron-browser/paradisActivityBusy.js';

suite('ParadisActivityBusyIndicator', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const doc = mainWindow.document;
		const panel = doc.createElement('div');
		const toolbar = panel.appendChild(doc.createElement('div'));
		const updated = toolbar.appendChild(doc.createElement('span'));
		const indicator = store.add(new ParadisActivityBusyIndicator(panel, toolbar, updated));
		const label = toolbar.querySelector<HTMLElement>('.paradis-activity-busy')!;
		const progress = panel.querySelector<HTMLElement>('.paradis-activity-progress .monaco-progress-container')!;
		const state = () => ({
			labelShown: label.style.display !== 'none',
			text: label.textContent,
			progressActive: progress.classList.contains('active'),
			labelBeforeUpdated: label.nextElementSibling === updated,
			progressFirst: panel.firstElementChild === progress.parentElement,
		});
		return { indicator, state };
	}

	test('shows the label and the progress line while re-reading, and hides both when done', () => {
		const { indicator, state } = setup();
		const idle = state();
		indicator.setBusy(true, 90, true);
		const busy = state();
		indicator.setBusy(false, 90, true);
		const done = state();
		assert.deepStrictEqual([idle, busy, done], [
			{ labelShown: false, text: '', progressActive: false, labelBeforeUpdated: true, progressFirst: true },
			{ labelShown: true, text: '90 日分を集計しています…', progressActive: true, labelBeforeUpdated: true, progressFirst: true },
			{ labelShown: false, text: '90 日分を集計しています…', progressActive: false, labelBeforeUpdated: true, progressFirst: true },
		]);
	});

	test('keeps only the progress line on the first load, when the body already says it is reading', () => {
		const { indicator, state } = setup();
		indicator.setBusy(true, 30, false);
		const { labelShown, progressActive } = state();
		indicator.setBusy(false, 30, false);
		assert.deepStrictEqual({ labelShown, progressActive }, { labelShown: false, progressActive: true });
	});
});
