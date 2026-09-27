/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCsvIndexer, type ParadisCsvDocument } from '../../common/csv/paradisCsv.js';
import { ParadisCsvTableView } from '../../browser/csv/paradisCsvTableView.js';

function csv(text: string): ParadisCsvDocument {
	const indexer = new ParadisCsvIndexer(text, ',');
	while (!indexer.step(1_000_000)) {
		// keep stepping
	}
	return indexer.finish();
}

interface Harness {
	readonly view: ParadisCsvTableView;
	readonly grid: HTMLElement;
	readonly clipboard: string[];
	readonly notices: string[];
}

function createHarness(store: Pick<DisposableStore, 'add'>): Harness {
	const parent = mainWindow.document.createElement('div');
	parent.style.cssText = 'position: fixed; left: 0; top: 0; width: 640px; height: 320px;';
	mainWindow.document.body.appendChild(parent);
	store.add(toDisposable(() => parent.remove()));
	const clipboard: string[] = [];
	const notices: string[] = [];
	const view = store.add(new ParadisCsvTableView(parent, {
		writeClipboard: async text => { clipboard.push(text); },
		notify: message => notices.push(message),
		onDidChangeState: () => { },
	}));
	view.element.style.cssText = 'position: absolute; inset: 0;';
	const grid = view.element.querySelector<HTMLElement>('.paradis-csv-grid')!;
	grid.style.cssText = 'position: absolute; inset: 0; overflow: auto;';
	return { view, grid, clipboard, notices };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await timeout(0);
	}
}

function cell(grid: HTMLElement, row: number, column: number): HTMLElement | null {
	return grid.querySelector<HTMLElement>(`.paradis-spreadsheet-virtual-cell[data-row="${row}"][data-column="${column}"]`);
}

function describeCell(grid: HTMLElement, row: number, column: number): string {
	const element = cell(grid, row, column);
	if (!element) {
		return '<missing>';
	}
	const classes = [...element.classList].filter(name => name.startsWith('paradis-csv-')).sort();
	return `${element.textContent}|${classes.join(' ')}`;
}

function key(grid: HTMLElement, key: string, modifiers: { shift?: boolean; primary?: boolean; alt?: boolean } = {}): boolean {
	const event = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		shiftKey: !!modifiers.shift,
		altKey: !!modifiers.alt,
		metaKey: !!modifiers.primary && isMacintosh,
		ctrlKey: !!modifiers.primary && !isMacintosh,
	});
	// Report whether the key reached the rest of the workbench (bubbled past the grid).
	let bubbled = false;
	const listener = () => bubbled = true;
	grid.parentElement!.addEventListener('keydown', listener);
	grid.dispatchEvent(event);
	grid.parentElement!.removeEventListener('keydown', listener);
	return bubbled;
}

function mouseDown(target: HTMLElement): void {
	const rect = target.getBoundingClientRect();
	const init = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
	target.dispatchEvent(new MouseEvent('mousedown', init));
	mainWindow.dispatchEvent(new MouseEvent('mouseup', init));
}

suite('ParadisCsvTableView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('renders a frozen header, row numbers and right-aligned numbers', async () => {
		const { view, grid } = createHarness(store);
		view.setDocument(csv('id,name,amount\n1,Acme,21600\n2,"Blue, Sky",36000\n'), false);
		view.layout();
		await settle();
		deepStrictEqual([
			describeCell(grid, 0, 0),
			describeCell(grid, 0, 2),
			describeCell(grid, 1, 0),
			describeCell(grid, 2, 2),
			describeCell(grid, 2, 3),
		], [
			'|paradis-csv-corner',
			'name|paradis-csv-header',
			'1|paradis-csv-rownum paradis-csv-rownum-selected',
			'Blue, Sky|',
			'36000|paradis-csv-number',
		]);
	});

	test('sorts by clicking a header and copies the selected range as TSV', async () => {
		const { view, grid, clipboard } = createHarness(store);
		view.setDocument(csv('name,amount\ncarol,30\nalice,"1,000"\nbob,5\n'), false);
		view.layout();
		await settle();

		const header = cell(grid, 0, 2)!;
		const headerRect = header.getBoundingClientRect();
		header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: headerRect.left + headerRect.width / 2, clientY: headerRect.top + 4 }));
		mainWindow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
		await settle();
		const sortedAscending = [1, 2, 3].map(row => cell(grid, row, 1)?.textContent);

		// Select from the first data cell to the bottom-right with the keyboard, then copy.
		key(grid, 'ArrowDown');
		key(grid, 'Home');
		key(grid, 'End', { shift: true });
		key(grid, 'ArrowDown', { shift: true, primary: true });
		key(grid, 'c', { primary: true });
		await settle();

		deepStrictEqual({ sortedAscending, sort: view.sortState, clipboard }, {
			sortedAscending: ['bob', 'carol', 'alice'],
			sort: { column: 1, direction: 'asc', pending: false },
			clipboard: ['bob\t5\ncarol\t30\nalice\t1,000'],
		});
	});

	test('highlights find results and moves the selection to the current match', async () => {
		const { view, grid } = createHarness(store);
		view.setDocument(csv('city,region\nTokyo,Kanto\nOsaka,Kansai\nKyoto,Kansai\n'), false);
		view.layout();
		await settle();

		key(grid, 'f', { primary: true });
		const input = view.element.querySelector<HTMLInputElement>('.paradis-office-find-widget input')!;
		input.value = 'kansai';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();

		deepStrictEqual([describeCell(grid, 2, 2), describeCell(grid, 3, 2), describeCell(grid, 1, 2)], [
			'Kansai|paradis-csv-active paradis-csv-match-current paradis-csv-selected',
			'Kansai|paradis-csv-match',
			'Kanto|',
		]);
	});
	test('keeps the sort and re-sorts new rows when the same file is reloaded', async () => {
		const { view, grid } = createHarness(store);
		view.setDocument(csv('name,n\nb,2\na,3\n'), false);
		view.layout();
		await settle();
		mouseDown(cell(grid, 0, 2)!);
		await settle();
		view.setDocument(csv('name,n\nb,2\na,3\nc,1\n'), true);
		view.layout();
		await settle();
		deepStrictEqual({ sort: view.sortState, names: [1, 2, 3].map(row => cell(grid, row, 1)?.textContent) }, {
			sort: { column: 1, direction: 'asc', pending: false },
			names: ['c', 'b', 'a'],
		});
	});

	test('selects whole rows from the row numbers and leaves Alt and Ctrl/Cmd+PageUp to the workbench', async () => {
		const { view, grid, clipboard } = createHarness(store);
		view.setDocument(csv('a,b,c\n1,2,3\n4,"x\ty",6\n'), false);
		view.layout();
		await settle();
		mouseDown(cell(grid, 2, 0)!);
		key(grid, 'c', { primary: true });
		await settle();
		deepStrictEqual({
			clipboard,
			altReachesWorkbench: key(grid, 'ArrowRight', { alt: true }),
			tabSwitchReachesWorkbench: key(grid, 'PageDown', { primary: true }),
			plainReachesWorkbench: key(grid, 'ArrowRight'),
		}, {
			clipboard: ['4\t"x\ty"\t6'],
			altReachesWorkbench: true,
			tabSwitchReachesWorkbench: true,
			plainReachesWorkbench: false,
		});
	});

	test('searches again after sorting so the highlights stay in place', async () => {
		const { view, grid } = createHarness(store);
		view.setDocument(csv('k,v\nb,hit\na,miss\n'), false);
		view.layout();
		await settle();
		key(grid, 'f', { primary: true });
		const input = view.element.querySelector<HTMLInputElement>('.paradis-office-find-widget input')!;
		input.value = 'hit';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		mouseDown(cell(grid, 0, 1)!);
		await settle();
		deepStrictEqual([describeCell(grid, 2, 2), describeCell(grid, 1, 2)], [
			'hit|paradis-csv-active paradis-csv-match-current paradis-csv-selected',
			'miss|',
		]);
	});
});
