/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisPaletteKind } from '../../common/paradisCrossJump.js';
import { ParadisPaletteKindsBar } from '../../browser/paradisPaletteKinds.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';

suite('paradisPaletteKinds', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function widget(): HTMLElement {
		const element = mainWindow.document.createElement('div');
		element.className = 'quick-input-widget';
		const header = mainWindow.document.createElement('div');
		header.className = 'quick-input-header';
		const list = mainWindow.document.createElement('div');
		list.className = 'quick-input-list';
		element.append(header, list);
		return element;
	}

	test('the bar sits under the input band, shows the prefixes and counts, and leaves the widget on dispose', () => {
		const host = widget();
		const selected: ParadisPaletteKind[] = [];
		let help = 0;
		const bar = store.add(new ParadisPaletteKindsBar(host, { onSelect: kind => selected.push(kind), onHelp: () => help++ }, NullHoverService));
		bar.update({ selected: 'agent', counts: { all: 26, agent: 5, editor: 6, space: 15 }, attention: 1 });
		const buttons = [...bar.element.querySelectorAll<HTMLButtonElement>('.paradis-seg > button')];
		buttons[4].click();
		bar.element.querySelector<HTMLButtonElement>('.paradis-palette-help')!.click();
		const snapshot = {
			order: [...host.children].map(child => child.className),
			tabs: buttons.map(button => ({
				text: button.textContent,
				pressed: button.getAttribute('aria-pressed'),
				attention: button.querySelector('.paradis-palette-kind-count')!.classList.contains('attention'),
				tabIndex: button.tabIndex,
			})),
			selected,
			help,
		};
		bar.dispose();
		assert.deepStrictEqual({ ...snapshot, after: [...host.children].map(child => child.className) }, {
			order: ['quick-input-header', 'paradis-palette-kinds', 'quick-input-list'],
			tabs: [
				{ text: 'すべて26', pressed: 'false', attention: false, tabIndex: -1 },
				{ text: 'aエージェント1/5', pressed: 'true', attention: true, tabIndex: -1 },
				{ text: 'tタブ6', pressed: 'false', attention: false, tabIndex: -1 },
				{ text: 'sスペース15', pressed: 'false', attention: false, tabIndex: -1 },
				{ text: '>コマンド', pressed: 'false', attention: false, tabIndex: -1 },
			],
			selected: ['command'],
			help: 1,
			after: ['quick-input-header', 'quick-input-list'],
		});
	});
});
