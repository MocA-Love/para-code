/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { AppResourcePath, FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { PARADIS_CARD_CLASS, PARADIS_CARD_VALUE_CLASS, PARADIS_TABLE_CLASS } from '../../browser/paradisCard.js';
import { renderParadisProgress } from '../../browser/paradisProgress.js';
import { ParadisSegmented } from '../../browser/paradisSegmented.js';
import { PARADIS_TABS_CLASS, paradisTabClasses, paradisTabsWheelScrollLeft } from '../../browser/paradisTabs.js';

const STYLESHEETS: AppResourcePath[] = [
	'vs/paradis/browser/media/paradisTokens.css',
	'vs/paradis/browser/media/paradisTabs.css',
	'vs/paradis/browser/media/paradisSegmented.css',
	'vs/paradis/browser/media/paradisCard.css',
	'vs/paradis/browser/media/paradisProgress.css',
];

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

suite('Paradis UI data parts (tabs, segmented, card, table, progress)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let links: HTMLLinkElement[] = [];

	setup(async () => {
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		links = await Promise.all(STYLESHEETS.map(loadStylesheet));
	});

	teardown(() => {
		workbench.remove();
		for (const link of links) {
			link.remove();
		}
		links = [];
	});

	test('tabs: 32px tabs, the selected one draws the 2px accent line', () => {
		workbench.style.setProperty('--vscode-paradis-accent', 'rgb(9, 175, 217)');
		const list = mainWindow.document.createElement('div');
		list.className = PARADIS_TABS_CLASS;
		workbench.appendChild(list);
		const make = (selected: boolean) => {
			const tab = mainWindow.document.createElement('button');
			tab.classList.add(...paradisTabClasses());
			tab.setAttribute('aria-selected', String(selected));
			tab.textContent = 'tab';
			list.appendChild(tab);
			const line = mainWindow.getComputedStyle(tab, '::after');
			return { height: tab.getBoundingClientRect().height, line: `${line.height} ${line.backgroundColor}` };
		};
		assert.deepStrictEqual([make(true), make(false)], [
			{ height: 32, line: '2px rgb(9, 175, 217)' },
			{ height: 32, line: 'auto rgba(0, 0, 0, 0)' },
		]);
	});

	test('tabs: a vertical wheel scrolls an overflowing tab list sideways, other wheels and the ends are left to the default', () => {
		const wheel = (deltaY: number, options: { deltaX?: number; shiftKey?: boolean; lines?: boolean } = {}) => ({ deltaY, deltaX: options.deltaX ?? 0, shiftKey: options.shiftKey ?? false, deltaMode: options.lines ? 1 : 0 });
		// scrollWidth 500, clientWidth 200: scrollLeft runs from 0 to 300.
		const scroll = (scrollLeft: number, w: ReturnType<typeof wheel>, scrollWidth = 500) => paradisTabsWheelScrollLeft(scrollLeft, scrollWidth, 200, w);
		assert.deepStrictEqual({
			down: scroll(0, wheel(100)),
			up: scroll(150, wheel(-100)),
			clampedAtEnd: scroll(250, wheel(100)),
			lines: scroll(0, wheel(3, { lines: true })),
			atEnd: scroll(300, wheel(100)),
			atStart: scroll(0, wheel(-100)),
			horizontalSwipe: scroll(0, wheel(100, { deltaX: 40 })),
			shift: scroll(0, wheel(100, { shiftKey: true })),
			fits: scroll(0, wheel(100), 200),
		}, {
			down: 100,
			up: 50,
			clampedAtEnd: 300,
			lines: 48,
			atEnd: undefined,
			atStart: undefined,
			horizontalSwipe: undefined,
			shift: undefined,
			fits: undefined,
		});
	});

	test('segmented: pressed buttons (not tabs), only user presses fire, the value can be cleared and items disabled', () => {
		const seg = store.add(new ParadisSegmented(workbench, {
			ariaLabel: '期間',
			value: '30d',
			items: [{ value: 'today', label: '今日' }, { value: '7d', label: '7日間' }, { value: '30d', label: '30日間' }],
		}));
		const changes: string[] = [];
		store.add(seg.onDidChange(value => changes.push(value)));
		const buttons = [...seg.element.children] as HTMLButtonElement[];
		const pressed = () => buttons.map(button => button.getAttribute('aria-pressed'));
		const initial = pressed();
		buttons[0].click();
		buttons[0].click();
		const afterClick = pressed();
		seg.value = undefined;
		const cleared = pressed();
		seg.setItemEnabled('7d', false, '短すぎます');
		buttons[1].click();
		assert.deepStrictEqual({
			role: seg.element.getAttribute('role'),
			label: seg.element.getAttribute('aria-label'),
			height: seg.element.getBoundingClientRect().height,
			initial, afterClick, cleared, changes,
			disabled: [buttons[1].getAttribute('aria-disabled'), buttons[1].title],
		}, {
			role: 'group',
			label: '期間',
			height: 28,
			initial: ['false', 'false', 'true'],
			afterClick: ['true', 'false', 'false'],
			cleared: ['false', 'false', 'false'],
			changes: ['today'],
			disabled: ['true', '短すぎます'],
		});
	});

	test('card and table: the inner radius and the 26px number; 28px rows with numbers at the right', () => {
		const card = mainWindow.document.createElement('div');
		card.className = PARADIS_CARD_CLASS;
		const value = mainWindow.document.createElement('div');
		value.className = PARADIS_CARD_VALUE_CLASS;
		value.textContent = '$55';
		card.appendChild(value);
		const table = mainWindow.document.createElement('table');
		table.className = PARADIS_TABLE_CLASS;
		const row = table.createTBody().insertRow();
		row.insertCell().textContent = 'para-code';
		const num = row.insertCell();
		num.className = 'num';
		num.textContent = '12';
		workbench.append(card, table);
		assert.deepStrictEqual({
			radius: mainWindow.getComputedStyle(card).borderTopLeftRadius,
			lineHeight: mainWindow.getComputedStyle(value).lineHeight,
			rowHeight: row.getBoundingClientRect().height,
			numAlign: mainWindow.getComputedStyle(num).textAlign,
		}, { radius: '8px', lineHeight: '32px', rowHeight: 28, numAlign: 'right' });
	});

	test('progress: 4px, role progressbar with the value, clamped, and the warning tone', () => {
		const progress = renderParadisProgress(workbench, { ariaLabel: '5時間ブロック', value: 0.833 });
		const read = () => ({ now: progress.element.getAttribute('aria-valuenow'), width: (progress.element.firstElementChild as HTMLElement).style.width, warning: progress.element.classList.contains('warning') });
		const first = read();
		progress.update(1.4, 'warning');
		const over = read();
		assert.deepStrictEqual({
			role: progress.element.getAttribute('role'),
			label: progress.element.getAttribute('aria-label'),
			height: progress.element.getBoundingClientRect().height,
			first, over,
		}, {
			role: 'progressbar',
			label: '5時間ブロック',
			height: 4,
			first: { now: '83', width: '83.3%', warning: false },
			over: { now: '100', width: '100%', warning: true },
		});
	});
});
