/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IQuickInput, QuickInputType } from '../../../../../platform/quickinput/common/quickInput.js';
import { paradisApplyQuickInputLook } from '../../browser/paradisQuickInputLook.js';

function loadStylesheet(path: AppResourcePath): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri(path).toString(true);
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error(`could not load ${path}`)), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

suite('Paradis quick input look', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let link: HTMLLinkElement;

	setup(async () => {
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		link = await loadStylesheet('vs/paradis/contrib/quickInputPosition/browser/media/paradisQuickInputLook.css');
	});

	teardown(() => {
		workbench.remove();
		link.remove();
	});

	/** 本家の器の代わり（クラスだけ）に、開いた入力の種類を当てて、印とヒントの見え方を読む。 */
	function apply(input: Partial<IQuickInput> | undefined) {
		const widget = mainWindow.document.createElement('div');
		widget.className = 'quick-input-widget';
		workbench.appendChild(widget);
		paradisApplyQuickInputLook(widget, input as IQuickInput | undefined);
		const hint = widget.lastElementChild as HTMLElement | null;
		const shown = (element: Element | null) => !!element && mainWindow.getComputedStyle(element).display !== 'none';
		return {
			centered: widget.classList.contains('paradis-quick-input-centered'),
			hint: shown(hint) ? [...hint!.children].filter(shown).map(child => child.textContent) : [],
		};
	}

	test('only the centered palette (not anchored, not ignoreFocusOut) gets the kit look and the hint; an input box hides "move"', () => {
		assert.deepStrictEqual({
			palette: apply({ type: QuickInputType.QuickPick, anchor: undefined, ignoreFocusOut: false }),
			inputBox: apply({ type: QuickInputType.InputBox, anchor: undefined, ignoreFocusOut: false }),
			anchored: apply({ type: QuickInputType.QuickPick, anchor: { x: 10, y: 10 }, ignoreFocusOut: false }),
			stepped: apply({ type: QuickInputType.QuickPick, anchor: undefined, ignoreFocusOut: true }),
		}, {
			palette: { centered: true, hint: ['↑↓ 移動', 'Enter 実行', 'Esc 閉じる'] },
			inputBox: { centered: true, hint: ['Enter 実行', 'Esc 閉じる'] },
			anchored: { centered: false, hint: [] },
			stepped: { centered: false, hint: [] },
		});
	});
});
