/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import { deepStrictEqual, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { rebuildSpreadsheetStickyStrips } from '../../electron-browser/paradisSpreadsheetEditor.js';

function setLayoutMetric(element: HTMLElement, property: 'offsetHeight' | 'offsetLeft' | 'offsetTop' | 'offsetWidth', value: number, operations: string[], name: string): void {
	Object.defineProperty(element, property, {
		configurable: true,
		get: () => {
			operations.push(`read:${name}`);
			return value;
		},
	});
}

function recordClear(container: HTMLElement, operations: string[], name: string): void {
	const staleChild = container.ownerDocument.createElement('span');
	const remove = staleChild.remove.bind(staleChild);
	staleChild.remove = () => {
		operations.push(`write:clear:${name}`);
		remove();
	};
	container.appendChild(staleChild);
}

function recordAppend(container: HTMLElement, operations: string[], name: string): void {
	const appendChild = container.appendChild.bind(container);
	container.appendChild = node => {
		operations.push(`write:append:${name}:${node.nodeType}`);
		return appendChild(node);
	};
}

suite('paradisSpreadsheetStickyStrips', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads layout before replacing strips and appends each strip as one fragment', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('spreadsheet sticky strips');
		const operations: string[] = [];
		const columnInner = document.createElement('div');
		const rowInner = document.createElement('div');
		const thead = document.createElement('thead');
		const firstColumn = document.createElement('th');
		const secondColumn = document.createElement('th');
		const firstRow = document.createElement('tr');
		const secondRow = document.createElement('tr');
		firstColumn.textContent = 'A';
		secondColumn.textContent = 'B';

		setLayoutMetric(thead, 'offsetHeight', 30, operations, 'header.height');
		setLayoutMetric(firstColumn, 'offsetLeft', 96, operations, 'column.1.left');
		setLayoutMetric(firstColumn, 'offsetWidth', 80, operations, 'column.1.width');
		setLayoutMetric(secondColumn, 'offsetLeft', 176, operations, 'column.2.left');
		setLayoutMetric(secondColumn, 'offsetWidth', 120, operations, 'column.2.width');
		setLayoutMetric(firstRow, 'offsetTop', 50, operations, 'row.1.top');
		setLayoutMetric(firstRow, 'offsetHeight', 20, operations, 'row.1.height');
		setLayoutMetric(secondRow, 'offsetTop', 70, operations, 'row.2.top');
		setLayoutMetric(secondRow, 'offsetHeight', 25, operations, 'row.2.height');
		recordClear(columnInner, operations, 'columns');
		recordClear(rowInner, operations, 'rows');
		recordAppend(columnInner, operations, 'columns');
		recordAppend(rowInner, operations, 'rows');

		const result = rebuildSpreadsheetStickyStrips(columnInner, rowInner, thead, [firstColumn, secondColumn], [{ tr: firstRow }, { tr: secondRow }]);

		deepStrictEqual(operations, [
			'read:header.height',
			'read:column.1.left',
			'read:column.1.width',
			'read:column.2.left',
			'read:column.2.width',
			'read:row.1.top',
			'read:row.1.height',
			'read:row.2.top',
			'read:row.2.height',
			'write:clear:columns',
			'write:clear:rows',
			'write:append:columns:11',
			'write:append:rows:11',
		]);
		deepStrictEqual(Array.from(columnInner.children, cell => ({ text: cell.textContent, left: (cell as HTMLElement).style.left, width: (cell as HTMLElement).style.width, height: (cell as HTMLElement).style.height })), [
			{ text: 'A', left: '60px', width: '80px', height: '30px' },
			{ text: 'B', left: '140px', width: '120px', height: '30px' },
		]);
		deepStrictEqual(Array.from(rowInner.children, cell => ({ text: cell.textContent, top: (cell as HTMLElement).style.top, width: (cell as HTMLElement).style.width, height: (cell as HTMLElement).style.height })), [
			{ text: '1', top: '20px', width: '36px', height: '20px' },
			{ text: '2', top: '40px', width: '36px', height: '25px' },
		]);
		deepStrictEqual(result, { headHeight: 30, hasRows: true });
	});

	test('clears sticky strips for an empty table', () => {
		const document = mainWindow.document.implementation.createHTMLDocument('empty spreadsheet sticky strips');
		const columnInner = document.createElement('div');
		const rowInner = document.createElement('div');
		const thead = document.createElement('thead');
		columnInner.appendChild(document.createElement('span'));
		rowInner.appendChild(document.createElement('span'));

		const result = rebuildSpreadsheetStickyStrips(columnInner, rowInner, thead, [], []);

		strictEqual(columnInner.childElementCount, 0);
		strictEqual(rowInner.childElementCount, 0);
		deepStrictEqual(result, { headHeight: 0, hasRows: false });
	});
});
