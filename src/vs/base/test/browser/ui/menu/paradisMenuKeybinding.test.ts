/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { $, append, getWindow } from '../../../../browser/dom.js';
import { Menu, unthemedMenuStyles } from '../../../../browser/ui/menu/menu.js';
import { toAction } from '../../../../common/actions.js';
import { ResolvedKeybinding } from '../../../../common/keybindings.js';
import { toDisposable } from '../../../../common/lifecycle.js';
import { upcastPartial } from '../../../common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../common/utils.js';

suite('Para Code Menu keybinding column', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	for (const shadowDom of [false, true]) {
		test(`hidden keybinding spans take no width in ${shadowDom ? 'shadow' : 'regular'} DOM`, () => {
			const host = append(document.body, $('div'));
			disposables.add(toDisposable(() => host.remove()));
			const root = (shadowDom ? host.attachShadow({ mode: 'open' }) : host).appendChild($('.context-view'));
			const withKey = toAction({ id: 'withKey', label: 'With Key', run: () => { } });
			const withoutKey = toAction({ id: 'withoutKey', label: 'Without Key', run: () => { } });
			disposables.add(new Menu(root, [withKey, withoutKey], {
				getKeyBinding: action => action.id === 'withKey' ? upcastPartial<ResolvedKeybinding>({ getLabel: () => 'Ctrl+K' }) : undefined
			}, unthemedMenuStyles));

			const window = getWindow(host);
			const keybindings = [...root.querySelectorAll<HTMLElement>('.keybinding')].map(element => ({
				text: element.textContent,
				hidden: element.hidden,
				display: window.getComputedStyle(element).display,
				hasWidth: element.offsetWidth > 0,
			}));
			assert.deepStrictEqual(keybindings, [
				{ text: 'Ctrl+K', hidden: false, display: 'block', hasWidth: true },
				{ text: '', hidden: true, display: 'none', hasWidth: false },
			]);
		});
	}
});
