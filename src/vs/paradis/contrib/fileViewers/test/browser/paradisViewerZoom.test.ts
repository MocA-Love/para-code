/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisViewerZoomControls, paradisViewerZoomScript } from '../../browser/paradisViewerZoom.js';

suite('ParadisViewerZoom', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('steps by 1.2, stays within -3..+5, and only reports real changes', () => {
		const changes: number[] = [];
		const zoom = disposables.add(new ParadisViewerZoomControls(() => changes.push(zoom.level)));
		const toolbar = mainWindow.document.createElement('div');
		zoom.createButtons(toolbar);
		const [zoomOut, percent, zoomIn] = Array.from(toolbar.querySelectorAll('button'));

		zoomIn.click();
		const afterOneStep = percent.textContent;
		for (let i = 0; i < 10; i++) {
			zoomIn.click();
		}
		const atMax = { level: zoom.level, zoomInDisabled: zoomIn.disabled };
		percent.click();
		for (let i = 0; i < 10; i++) {
			zoomOut.click();
		}

		deepStrictEqual({
			afterOneStep,
			atMax,
			atMin: { level: zoom.level, zoomOutDisabled: zoomOut.disabled, percent: percent.textContent },
			changes,
		}, {
			afterOneStep: '120%',
			atMax: { level: 5, zoomInDisabled: true },
			atMin: { level: -3, zoomOutDisabled: true, percent: '58%' },
			changes: [1, 2, 3, 4, 5, 0, -1, -2, -3],
		});
	});

	test('puts the nonce on the page script only when one is given', () => {
		deepStrictEqual([
			paradisViewerZoomScript('abc').startsWith('<script nonce="abc">'),
			paradisViewerZoomScript().startsWith('<script>'),
		], [true, true]);
	});
});
