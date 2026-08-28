/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ParadisOfficeAccessibility,
	applyParadisOfficeChangeLegendSemantics,
	paradisOfficeChangeLabel,
	wireParadisOfficeTableGrid,
	wireParadisOfficeTabList,
} from '../../browser/paradisOfficeAccessibility.js';
import type { ParadisOfficeChange } from '../../common/paradisOfficeProtocol.js';

function spreadsheetTable(document: Document, rows: number, columns: number): HTMLTableElement {
	const table = document.createElement('table');
	const head = table.createTHead().insertRow();
	head.insertCell().textContent = '';
	for (let column = 0; column < columns; column++) {
		head.insertCell().textContent = String.fromCharCode(65 + column);
	}
	const body = table.createTBody();
	for (let row = 0; row < rows; row++) {
		const tr = body.insertRow();
		tr.insertCell().textContent = String(row + 1);
		for (let column = 0; column < columns; column++) {
			tr.insertCell().textContent = `${row + 1}:${column + 1}`;
		}
	}
	return table;
}

function navigationKey(target: HTMLElement, key: string, ctrlKey = false): void {
	target.dispatchEvent(new mainWindow.KeyboardEvent('keydown', { key, ctrlKey, bubbles: true }));
}

function change(id: string, category: ParadisOfficeChange['category'], subjectKind: string): ParadisOfficeChange {
	return {
		id,
		category,
		subject: { kind: subjectKind, locator: 'logical:anchor' },
		before: { kind: 'scalar', valueType: 'text', value: '<script>before secret</script>' },
		after: { kind: 'scalar', valueType: 'text', value: '<img onerror=after-secret>' },
		certainty: 'exact',
		sourceParts: ['safe-part'],
	};
}

suite('ParadisOfficeAccessibility', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('moves a logical table grid with arrows, Home, End, Page, and document bounds', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('Office grid accessibility');
		const table = spreadsheetTable(document, 30, 4);
		document.body.appendChild(table);
		disposables.add(wireParadisOfficeTableGrid(table, {
			label: 'Budget sheet',
			rowCount: 30,
			columnCount: 4,
			pageSize: 10,
		}));

		const active = (): [number, number] => {
			const id = table.getAttribute('aria-activedescendant');
			const cell = id ? document.getElementById(id) : undefined;
			return [Number(cell?.getAttribute('aria-rowindex')), Number(cell?.getAttribute('aria-colindex'))];
		};

		strictEqual(table.getAttribute('role'), 'grid');
		strictEqual(table.getAttribute('aria-label'), 'Budget sheet');
		strictEqual(table.getAttribute('aria-rowcount'), '30');
		strictEqual(table.getAttribute('aria-colcount'), '4');
		deepStrictEqual(active(), [1, 1]);

		navigationKey(table, 'ArrowRight');
		navigationKey(table, 'ArrowDown');
		deepStrictEqual(active(), [2, 2]);
		navigationKey(table, 'End');
		deepStrictEqual(active(), [2, 4]);
		navigationKey(table, 'Home');
		deepStrictEqual(active(), [2, 1]);
		navigationKey(table, 'PageDown');
		deepStrictEqual(active(), [12, 1]);
		navigationKey(table, 'PageUp');
		deepStrictEqual(active(), [2, 1]);
		navigationKey(table, 'End', true);
		deepStrictEqual(active(), [30, 4]);
		navigationKey(table, 'Home', true);
		deepStrictEqual(active(), [1, 1]);
	});

	test('does not consume navigation keys from an interactive control inside a grid cell', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('Office grid control accessibility');
		const table = spreadsheetTable(document, 2, 2);
		const button = document.createElement('button');
		button.textContent = 'Inspect rule';
		table.tBodies[0].rows[0].cells[1].appendChild(button);
		document.body.appendChild(table);
		disposables.add(wireParadisOfficeTableGrid(table, { label: 'Rules', rowCount: 2, columnCount: 2 }));
		const before = table.getAttribute('aria-activedescendant');

		navigationKey(button, 'ArrowRight');

		strictEqual(table.getAttribute('aria-activedescendant'), before);
	});

	test('moves through merged spans and preserves source column gaps', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('Office merged grid accessibility');
		const table = spreadsheetTable(document, 1, 3);
		const row = table.tBodies[0].rows[0];
		row.cells[1].colSpan = 2;
		row.deleteCell(2);
		document.body.appendChild(table);
		disposables.add(wireParadisOfficeTableGrid(table, {
			label: 'Merged sheet',
			rowCount: 1,
			columnCount: 3,
		}));

		navigationKey(table, 'ArrowRight');
		navigationKey(table, 'ArrowRight');

		const active = document.getElementById(table.getAttribute('aria-activedescendant') ?? '');
		strictEqual(active?.textContent, '1:3');
		strictEqual(active?.getAttribute('aria-colindex'), '3');

		const gapped = spreadsheetTable(document, 1, 2);
		document.body.appendChild(gapped);
		disposables.add(wireParadisOfficeTableGrid(gapped, {
			label: 'Hidden source column',
			rowCount: 1,
			columnCount: 3,
			logicalCellColumns: [[0, 2]],
		}));
		navigationKey(gapped, 'ArrowRight');
		const gappedActive = document.getElementById(gapped.getAttribute('aria-activedescendant') ?? '');
		strictEqual(gappedActive?.textContent, '1:2');
		strictEqual(gappedActive?.getAttribute('aria-colindex'), '3');
	});

	test('gives toolbar buttons and sheet tabs explicit names with roving keyboard activation', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('Office controls accessibility');
		const root = document.createElement('div');
		document.body.appendChild(root);
		const accessibility = disposables.add(new ParadisOfficeAccessibility(root, { label: 'Spreadsheet viewer' }));
		const zoom = document.createElement('button');
		root.appendChild(zoom);
		accessibility.labelButton(zoom, 'Zoom in');

		const tabList = document.createElement('div');
		const data = document.createElement('button');
		data.textContent = 'Data';
		const archive = document.createElement('button');
		archive.textContent = 'Archive';
		tabList.append(data, archive);
		root.appendChild(tabList);
		let activated = -1;
		archive.addEventListener('click', () => activated = 1);
		disposables.add(wireParadisOfficeTabList(tabList, {
			label: 'Workbook sheets',
			tabs: [
				{ element: data, label: 'Data sheet', selected: true },
				{ element: archive, label: 'Archive sheet', selected: false },
			],
		}));

		strictEqual(zoom.getAttribute('aria-label'), 'Zoom in');
		strictEqual(tabList.getAttribute('role'), 'tablist');
		strictEqual(data.getAttribute('role'), 'tab');
		strictEqual(data.getAttribute('aria-selected'), 'true');
		strictEqual(data.tabIndex, 0);
		strictEqual(archive.getAttribute('aria-label'), 'Archive sheet');
		strictEqual(archive.tabIndex, -1);
		navigationKey(data, 'ArrowRight');
		strictEqual(activated, 1);
	});

	test('keeps change categories visible without color and names diagonals separately from drawing lines', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('Office change accessibility');
		const item = document.createElement('span');
		const swatch = document.createElement('span');
		const label = document.createElement('span');
		label.textContent = 'Added';
		item.append(swatch, label);
		applyParadisOfficeChangeLegendSemantics(item, swatch, { category: 'added', label: 'Added', marker: '+' });

		strictEqual(item.getAttribute('aria-label'), 'Added');
		strictEqual(swatch.getAttribute('aria-hidden'), 'true');
		const marker = item.querySelector('.paradis-office-change-marker');
		strictEqual(marker?.textContent, '+');
		strictEqual(marker?.parentElement, swatch, 'marker overlays the existing swatch without adding legend width');
		deepStrictEqual([
			paradisOfficeChangeLabel(change('base', 'formatting', 'cell.diagonalBorder')),
			paradisOfficeChangeLabel(change('conditional', 'formatting', 'conditionalFormatting.diagonalBorder')),
			paradisOfficeChangeLabel(change('table', 'formatting', 'table.diagonalBorder')),
			paradisOfficeChangeLabel(change('line', 'object', 'object.lineGeometry')),
		], ['セルの斜線', '条件付き書式の斜線', '表の斜線', '図形の線']);
	});

	test('applies forced-color and reduced-motion preferences to the rendered controls', () => {
		const root = mainWindow.document.createElement('div');
		const marker = mainWindow.document.createElement('span');
		marker.className = 'paradis-office-change-marker';
		const pulse = mainWindow.document.createElement('span');
		pulse.className = 'pulse';
		root.append(marker, pulse);
		mainWindow.document.body.appendChild(root);
		disposables.add({ dispose: () => root.remove() });
		disposables.add(new ParadisOfficeAccessibility(root, {
			label: 'Office viewer',
			forcedColors: true,
			reducedMotion: true,
		}));

		strictEqual(root.dataset.paradisOfficeForcedColors, 'true');
		strictEqual(root.dataset.paradisOfficeReducedMotion, 'true');
		strictEqual(mainWindow.getComputedStyle(marker).outlineStyle, 'solid');
		strictEqual(mainWindow.getComputedStyle(pulse).animationName, 'none');
	});

	test('announces logical change position and category without exposing raw before or after values', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('Office announcements');
		const root = document.createElement('div');
		document.body.appendChild(root);
		const accessibility = disposables.add(new ParadisOfficeAccessibility(root, { label: 'Word comparison' }));

		accessibility.announceChange(change('line', 'object', 'object.lineGeometry'), 1, 3);

		const live = root.querySelector('[aria-live="polite"]');
		strictEqual(live?.getAttribute('aria-atomic'), 'true');
		strictEqual(live?.textContent, '3 件中 2 件目の変更: 図形の線');
		ok(!root.textContent?.includes('before secret'));
		ok(!root.textContent?.includes('after-secret'));

		accessibility.announceChange(change('diagonal', 'formatting', 'conditionalFormatting.diagonalBorder'), 0, 1);
		strictEqual(live?.textContent, '1 件中 1 件目の変更: 条件付き書式の斜線');
		ok(!root.textContent?.includes('before secret'));
		ok(!root.textContent?.includes('after-secret'));
	});
});
