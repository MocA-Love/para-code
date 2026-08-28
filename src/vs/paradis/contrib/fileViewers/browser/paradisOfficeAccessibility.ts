/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { ParadisOfficeChange } from '../common/paradisOfficeProtocol.js';

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
let nextAccessibilityId = 0;

const PARADIS_OFFICE_ACCESSIBILITY_STYLE = `
.paradis-office-a11y-root .paradis-office-sr-only {
	position: absolute !important;
	width: 1px !important;
	height: 1px !important;
	padding: 0 !important;
	margin: -1px !important;
	overflow: hidden !important;
	clip: rect(0, 0, 0, 0) !important;
	white-space: nowrap !important;
	border: 0 !important;
}
.paradis-office-a11y-root .paradis-office-change-marker {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 8px;
	line-height: 1;
	font-weight: 700;
	pointer-events: none;
}
.paradis-office-a11y-root [role="gridcell"].paradis-office-active-cell {
	outline: 2px solid var(--vscode-focusBorder, #0078d4);
	outline-offset: -2px;
}
.paradis-office-a11y-root.paradis-office-forced-colors .paradis-office-change-marker {
	outline: 1px solid CanvasText;
	color: CanvasText;
	forced-color-adjust: auto;
}
.paradis-office-a11y-root.paradis-office-forced-colors [role="gridcell"].paradis-office-active-cell,
.paradis-office-a11y-root.paradis-office-forced-colors .paradis-spreadsheet-diff-highlight,
.paradis-office-a11y-root.paradis-office-forced-colors .paradis-current {
	outline: 2px solid Highlight !important;
	background: Canvas !important;
	forced-color-adjust: auto;
}
.paradis-office-a11y-root.paradis-office-reduced-motion *,
.paradis-office-a11y-root.paradis-office-reduced-motion *::before,
.paradis-office-a11y-root.paradis-office-reduced-motion *::after {
	animation: none !important;
	transition: none !important;
	scroll-behavior: auto !important;
}
@media (forced-colors: active) {
	.paradis-office-a11y-root .paradis-office-change-marker {
		outline: 1px solid CanvasText;
		color: CanvasText;
		forced-color-adjust: auto;
	}
	.paradis-office-a11y-root [role="gridcell"].paradis-office-active-cell,
	.paradis-office-a11y-root .paradis-spreadsheet-diff-highlight,
	.paradis-office-a11y-root .paradis-current {
		outline: 2px solid Highlight !important;
		background: Canvas !important;
		forced-color-adjust: auto;
	}
}
@media (prefers-reduced-motion: reduce) {
	.paradis-office-a11y-root *,
	.paradis-office-a11y-root *::before,
	.paradis-office-a11y-root *::after {
		animation: none !important;
		transition: none !important;
		scroll-behavior: auto !important;
	}
}`;

/** Static CSS added to the generated Word webviews. It never contains document data. */
export const PARADIS_OFFICE_WEBVIEW_ACCESSIBILITY_STYLE = `
@media (forced-colors: active) {
	[data-paradis-docx-diff="added"] { outline: 2px solid CanvasText !important; }
	[data-paradis-docx-diff="removed"] { outline: 2px dashed CanvasText !important; }
	[data-paradis-docx-diff="modified"], [data-paradis-docx-diff="formatChanged"] { outline: 2px dotted CanvasText !important; }
	[data-paradis-docx-diff="moved"] { outline: 3px double CanvasText !important; }
	.paradis-current { outline: 2px solid Highlight !important; forced-color-adjust: auto; }
}
@media (prefers-reduced-motion: reduce) {
	*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}`;

export interface ParadisOfficeAccessibilityOptions {
	readonly label: string;
	/** Testable overrides. Production callers omit them and follow the OS media queries. */
	readonly forcedColors?: boolean;
	readonly reducedMotion?: boolean;
}

export interface ParadisOfficeTableGridOptions {
	readonly label: string;
	readonly rowCount: number;
	readonly columnCount: number;
	readonly pageSize?: number;
	/** Source column index for each rendered data cell, preserving gaps hidden by merged-cell projection. */
	readonly logicalCellColumns?: readonly (readonly number[])[];
}

export interface ParadisOfficeTabEntry {
	readonly element: HTMLButtonElement;
	readonly label: string;
	readonly selected: boolean;
}

export interface ParadisOfficeTabListOptions {
	readonly label: string;
	readonly tabs: readonly ParadisOfficeTabEntry[];
}

export interface ParadisOfficeChangeLegendOptions {
	readonly category: string;
	readonly label: string;
	readonly marker: string;
}

function boundedAccessibleText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 4_096);
}

function positiveInteger(value: number, fallback = 1): number {
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function mediaPreference(root: HTMLElement, query: string): MediaQueryList | undefined {
	return root.ownerDocument.defaultView?.matchMedia?.(query);
}

/** Shared Office viewer region, preference state, accessible button labels, and polite announcements. */
export class ParadisOfficeAccessibility extends Disposable {
	private readonly liveRegion: HTMLElement;

	constructor(private readonly root: HTMLElement, options: ParadisOfficeAccessibilityOptions) {
		super();
		root.classList.add('paradis-office-a11y-root');
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', boundedAccessibleText(options.label));

		const style = root.ownerDocument.createElement('style');
		style.textContent = PARADIS_OFFICE_ACCESSIBILITY_STYLE;
		root.appendChild(style);
		this._register(toDisposable(() => style.remove()));

		this.liveRegion = root.ownerDocument.createElement('span');
		this.liveRegion.className = 'paradis-office-sr-only paradis-office-change-live';
		this.liveRegion.setAttribute('role', 'status');
		this.liveRegion.setAttribute('aria-live', 'polite');
		this.liveRegion.setAttribute('aria-atomic', 'true');
		root.appendChild(this.liveRegion);
		this._register(toDisposable(() => this.liveRegion.remove()));

		this.observePreference('forcedColors', options.forcedColors, '(forced-colors: active)');
		this.observePreference('reducedMotion', options.reducedMotion, '(prefers-reduced-motion: reduce)');
	}

	labelButton(button: HTMLButtonElement, label: string): void {
		const safeLabel = boundedAccessibleText(label);
		button.type = 'button';
		button.setAttribute('aria-label', safeLabel);
		if (!button.title) {
			button.title = safeLabel;
		}
	}

	announceChange(change: ParadisOfficeChange, index: number, total: number): void {
		this.announceChangeLabel(paradisOfficeChangeLabel(change), index, total);
	}

	announceChangeLabel(label: string, index: number, total: number): void {
		const logicalTotal = positiveInteger(total);
		const logicalIndex = Math.min(logicalTotal - 1, Math.max(0, Number.isSafeInteger(index) ? index : 0));
		this.liveRegion.textContent = localize(
			'paradis.office.accessibility.changePosition',
			"{1} 件中 {0} 件目の変更: {2}",
			logicalIndex + 1,
			logicalTotal,
			boundedAccessibleText(label),
		);
	}

	announceChangeCount(total: number): void {
		const logicalTotal = Math.max(0, Number.isSafeInteger(total) ? total : 0);
		this.liveRegion.textContent = logicalTotal === 1
			? localize('paradis.office.accessibility.oneChange', "1 件の変更")
			: localize('paradis.office.accessibility.changeCount', "{0} 件の変更", logicalTotal);
	}

	private observePreference(kind: 'forcedColors' | 'reducedMotion', override: boolean | undefined, query: string): void {
		const className = kind === 'forcedColors' ? 'paradis-office-forced-colors' : 'paradis-office-reduced-motion';
		const dataName = kind === 'forcedColors' ? 'paradisOfficeForcedColors' : 'paradisOfficeReducedMotion';
		const apply = (enabled: boolean): void => {
			this.root.classList.toggle(className, enabled);
			this.root.dataset[dataName] = String(enabled);
		};
		if (override !== undefined) {
			apply(override);
			return;
		}
		const media = mediaPreference(this.root, query);
		apply(media?.matches ?? false);
		if (media) {
			const listener = (event: MediaQueryListEvent): void => apply(event.matches);
			media.addEventListener('change', listener);
			this._register(toDisposable(() => media.removeEventListener('change', listener)));
		}
	}

	override dispose(): void {
		super.dispose();
		this.root.classList.remove('paradis-office-a11y-root', 'paradis-office-forced-colors', 'paradis-office-reduced-motion');
		delete this.root.dataset.paradisOfficeForcedColors;
		delete this.root.dataset.paradisOfficeReducedMotion;
	}
}

/** Applies bounded logical metadata to an existing grid, including virtual grids owned by another renderer. */
export function applyParadisOfficeGridMetadata(grid: HTMLElement, label: string, rowCount: number, columnCount: number): void {
	grid.setAttribute('role', 'grid');
	grid.setAttribute('aria-label', boundedAccessibleText(label));
	grid.setAttribute('aria-rowcount', String(positiveInteger(rowCount)));
	grid.setAttribute('aria-colcount', String(positiveInteger(columnCount)));
	if (grid.tabIndex < 0) {
		grid.tabIndex = 0;
	}
}

/** Adds native-table grid semantics and logical keyboard navigation without copying cell values. */
export function wireParadisOfficeTableGrid(table: HTMLTableElement, options: ParadisOfficeTableGridOptions): IDisposable {
	const rowCount = positiveInteger(options.rowCount);
	const columnCount = positiveInteger(options.columnCount);
	const pageSize = positiveInteger(options.pageSize ?? 20, 20);
	applyParadisOfficeGridMetadata(table, options.label, rowCount, columnCount);

	for (const row of Array.from(table.tHead?.rows ?? [])) {
		row.setAttribute('role', 'row');
		let column = 0;
		for (const cell of Array.from(row.cells)) {
			if (column === 0) {
				cell.setAttribute('role', 'presentation');
			} else {
				cell.setAttribute('role', 'columnheader');
				cell.setAttribute('aria-colindex', String(column));
			}
			column += Math.max(1, cell.colSpan);
		}
	}

	const rows = Array.from(table.tBodies[0]?.rows ?? []);
	const cellsByRow: HTMLElement[][] = [];
	rows.forEach((row, rowIndex) => {
		row.setAttribute('role', 'row');
		row.setAttribute('aria-rowindex', String(rowIndex + 1));
		const logicalCells: HTMLElement[] = [];
		let column = 0;
		let renderedCellIndex = 0;
		for (const cell of Array.from(row.cells)) {
			if (cell === row.cells[0]) {
				cell.setAttribute('role', 'rowheader');
				cell.setAttribute('aria-rowindex', String(rowIndex + 1));
				continue;
			}
			const logicalColumn = options.logicalCellColumns?.[rowIndex]?.[renderedCellIndex++] ?? column;
			cell.setAttribute('role', 'gridcell');
			cell.setAttribute('aria-rowindex', String(rowIndex + 1));
			cell.setAttribute('aria-colindex', String(logicalColumn + 1));
			cell.tabIndex = -1;
			cell.id ||= `paradis-office-gridcell-${++nextAccessibilityId}-${rowIndex + 1}-${logicalColumn + 1}`;
			for (let span = 0; span < Math.max(1, cell.colSpan) && logicalColumn + span < columnCount; span++) {
				logicalCells[logicalColumn + span] = cell;
			}
			column = logicalColumn + Math.max(1, cell.colSpan);
		}
		cellsByRow[rowIndex] = logicalCells;
	});

	const maximumRow = Math.max(0, Math.min(rowCount, rows.length) - 1);
	let active = { row: 0, column: 0 };
	let activeCell: HTMLElement | undefined;
	const setActive = (row: number, column: number, reveal: boolean): void => {
		const targetRow = Math.min(maximumRow, Math.max(0, row));
		const logicalCells = cellsByRow[targetRow] ?? [];
		const targetColumn = Math.min(columnCount - 1, Math.max(0, column));
		let resolvedColumn = targetColumn;
		let cell = logicalCells[resolvedColumn];
		while (!cell && resolvedColumn < columnCount - 1) {
			cell = logicalCells[++resolvedColumn];
		}
		while (!cell && resolvedColumn > 0) {
			cell = logicalCells[--resolvedColumn];
		}
		if (!cell) {
			return;
		}
		activeCell?.classList.remove('paradis-office-active-cell');
		cell.classList.add('paradis-office-active-cell');
		activeCell = cell;
		table.setAttribute('aria-activedescendant', cell.id);
		active = {
			row: Number(cell.getAttribute('aria-rowindex')) - 1,
			column: resolvedColumn,
		};
		if (reveal && typeof cell.scrollIntoView === 'function') {
			cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
		}
	};
	setActive(0, 0, false);

	const listener = (event: KeyboardEvent): void => {
		const eventTarget = event.target as HTMLElement | null;
		if (!NAVIGATION_KEYS.has(event.key) || event.altKey || event.shiftKey
			|| eventTarget !== table && !!eventTarget?.closest('button, input, select, textarea, a[href], [contenteditable="true"]')) {
			return;
		}
		event.preventDefault();
		const documentBound = event.ctrlKey || event.metaKey;
		let { row, column } = active;
		switch (event.key) {
			case 'ArrowUp': row--; break;
			case 'ArrowDown': row++; break;
			case 'ArrowLeft': column--; break;
			case 'ArrowRight': column++; break;
			case 'Home':
				row = documentBound ? 0 : row;
				column = 0;
				break;
			case 'End':
				row = documentBound ? maximumRow : row;
				column = columnCount - 1;
				break;
			case 'PageUp': row -= pageSize; break;
			case 'PageDown': row += pageSize; break;
		}
		setActive(row, column, true);
	};
	table.addEventListener('keydown', listener);
	return toDisposable(() => table.removeEventListener('keydown', listener));
}

/** Adds tablist/tab names and the standard wrapping arrow/Home/End keyboard behavior. */
export function wireParadisOfficeTabList(container: HTMLElement, options: ParadisOfficeTabListOptions): IDisposable {
	const tabs = [...options.tabs];
	container.setAttribute('role', 'tablist');
	container.setAttribute('aria-label', boundedAccessibleText(options.label));
	for (const tab of tabs) {
		tab.element.type = 'button';
		tab.element.setAttribute('role', 'tab');
		tab.element.setAttribute('aria-label', boundedAccessibleText(tab.label));
		tab.element.setAttribute('aria-selected', String(tab.selected));
		tab.element.tabIndex = tab.selected ? 0 : -1;
	}
	const listener = (event: KeyboardEvent): void => {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		const current = tabs.findIndex(tab => tab.element === event.target || tab.element.contains(event.target as Node));
		if (current < 0 || tabs.length === 0) {
			return;
		}
		event.preventDefault();
		const next = event.key === 'Home'
			? 0
			: event.key === 'End'
				? tabs.length - 1
				: (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
		tabs[next].element.click();
		const selected = Array.from(container.children).find(element => element.getAttribute('role') === 'tab' && element.getAttribute('aria-selected') === 'true') as HTMLElement | undefined;
		(selected ?? tabs[next].element).focus();
	};
	container.addEventListener('keydown', listener);
	return toDisposable(() => container.removeEventListener('keydown', listener));
}

/** Keeps the color swatch decorative and adds a visible, bounded marker plus an accessible category name. */
export function applyParadisOfficeChangeLegendSemantics(item: HTMLElement, swatch: HTMLElement, options: ParadisOfficeChangeLegendOptions): void {
	item.dataset.officeChangeCategory = boundedAccessibleText(options.category);
	item.setAttribute('role', 'img');
	item.setAttribute('aria-label', boundedAccessibleText(options.label));
	swatch.setAttribute('aria-hidden', 'true');
	swatch.style.position = 'relative';
	const marker = item.ownerDocument.createElement('span');
	marker.className = 'paradis-office-change-marker';
	marker.setAttribute('aria-hidden', 'true');
	marker.textContent = boundedAccessibleText(options.marker).slice(0, 4);
	swatch.appendChild(marker);
}

/** Human-facing semantic label; raw before/after values and geometry are deliberately excluded. */
export function paradisOfficeChangeLabel(change: Pick<ParadisOfficeChange, 'category' | 'subject'>): string {
	switch (change.subject.kind) {
		case 'cell.diagonalBorder': return localize('paradis.office.change.baseDiagonal', "セルの斜線");
		case 'conditionalFormatting.diagonalBorder': return localize('paradis.office.change.conditionalDiagonal', "条件付き書式の斜線");
		case 'table.diagonalBorder': return localize('paradis.office.change.tableDiagonal', "表の斜線");
		case 'object.lineGeometry': return localize('paradis.office.change.drawingLine', "図形の線");
	}
	switch (change.category) {
		case 'content': return localize('paradis.office.change.content', "内容の変更");
		case 'formatting': return localize('paradis.office.change.formatting', "書式の変更");
		case 'structure': return localize('paradis.office.change.structure', "構造の変更");
		case 'annotation': return localize('paradis.office.change.annotation', "コメントの変更");
		case 'revision': return localize('paradis.office.change.revision', "変更履歴の変更");
		case 'object': return localize('paradis.office.change.object', "オブジェクトの変更");
		case 'security': return localize('paradis.office.change.security', "セキュリティの変更");
	}
}

/** Injects only the static accessibility stylesheet into a generated Office webview document. */
export function applyParadisOfficeWebviewAccessibility(html: string): string {
	const styleEnd = html.indexOf('</style>');
	return styleEnd < 0
		? html
		: `${html.slice(0, styleEnd)}${PARADIS_OFFICE_WEBVIEW_ACCESSIBILITY_STYLE}${html.slice(styleEnd)}`;
}
