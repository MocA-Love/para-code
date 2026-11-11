/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ParadisCreateDictionaryDialog } from '../../electron-browser/paradisAivisDictionarySection.js';
import { ParadisSectionFocusCarrier, paradisSetFocusKey } from '../../electron-browser/paradisNotificationSettingsDomUtils.js';

suite('ParadisSectionFocusCarrier', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function renderSection(section: HTMLElement, keys: readonly string[]): HTMLButtonElement[] {
		section.textContent = '';
		return keys.map(key => {
			const button = mainWindow.document.createElement('button');
			button.textContent = key;
			paradisSetFocusKey(button, key);
			section.appendChild(button);
			return button;
		});
	}

	test('a redraw moves focus to the rebuilt button with the same key, or to the first button once the list is final', () => {
		const section = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(section);
		try {
			const carrier = new ParadisSectionFocusCarrier(section);
			renderSection(section, ['new', 'edit:a', 'edit:b'])[2].focus();
			carrier.capture();
			const rebuilt = renderSection(section, ['new', 'edit:a', 'edit:b']);
			carrier.restore(true);
			const sameKey = mainWindow.document.activeElement === rebuilt[2];

			// The list arrives later: nothing moves until the final call, then the first button takes focus
			rebuilt[1].focus();
			carrier.capture();
			const header = renderSection(section, ['new']);
			carrier.restore(false);
			const waited = mainWindow.document.activeElement === mainWindow.document.body;
			carrier.restore(true);
			const fallback = mainWindow.document.activeElement === header[0];

			assert.deepStrictEqual({ sameKey, waited, fallback }, { sameKey: true, waited: true, fallback: true });
		} finally {
			section.remove();
		}
	});

	test('closing a nested box whose opener was redrawn returns focus to the rebuilt button', () => {
		const root = mainWindow.document.createElement('div');
		const section = mainWindow.document.createElement('div');
		root.appendChild(section);
		mainWindow.document.body.appendChild(root);
		try {
			const carrier = new ParadisSectionFocusCarrier(section);
			renderSection(section, ['new'])[0].focus();
			const dialog = new ParadisCreateDictionaryDialog(upcastPartial<ILayoutService>({ activeContainer: root }), upcastPartial<ISharedProcessService>({}), 'key', () => { }, () => carrier.find('new'));
			// Saving redraws the section while the box is still open
			const rebuilt = renderSection(section, ['new']);
			dialog.dispose();
			assert.strictEqual(mainWindow.document.activeElement, rebuilt[0]);
		} finally {
			root.remove();
		}
	});
});
