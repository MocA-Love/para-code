/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import {
	type ParadisOfficeChange,
	type ParadisOfficeChangeCategory,
	type ParadisOfficeCompletenessManifest,
	type ParadisOfficeOutcome,
	type ParadisOfficePlaceholder,
	type ParadisOfficePrintModel,
	type ParadisOfficeSearchResult,
	type ParadisOfficeSourceDescriptor,
} from '../../common/paradisOfficeProtocol.js';
import { PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS, canShowSpreadsheetNoChanges, spreadsheetPrintWarning } from './paradisSpreadsheetDiagnostics.js';

export const PARADIS_SPREADSHEET_CHANGE_CATEGORIES: readonly ParadisOfficeChangeCategory[] = Object.freeze([
	'content',
	'formatting',
	'structure',
	'annotation',
	'revision',
	'object',
	'security',
]);

const categorySet = new Set<ParadisOfficeChangeCategory>(PARADIS_SPREADSHEET_CHANGE_CATEGORIES);
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const INSPECTOR_PAGE_SIZE = 100;
const MAX_STORED_SEARCH_RESULTS = 10_000;

export interface ParadisSpreadsheetViewState {
	readonly zoom: number;
	readonly activeSheet: string;
	readonly categories: readonly ParadisOfficeChangeCategory[];
	readonly selectedChangeId?: string;
}

export interface ParadisSpreadsheetRestorableInput {
	readonly source: ParadisOfficeSourceDescriptor;
	readonly viewState: ParadisSpreadsheetViewState;
}

/** Input-open fence: only the newest open may commit or restore editor state. */
export class ParadisSpreadsheetOpenGeneration {
	private generation = 0;

	begin(): number {
		return ++this.generation;
	}

	invalidate(): void {
		this.generation++;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}
}

export interface ParadisSpreadsheetNavigationTarget {
	readonly kind: 'change' | 'placeholder' | 'search';
	readonly locator: string;
	readonly anchor?: string;
}

export interface ParadisSpreadsheetLogicalNavigation {
	readonly sheetName: string;
	readonly cell?: { readonly address: string; readonly row: number; readonly column: number };
	readonly objectName?: string;
}

function parseCellAddress(address: string): ParadisSpreadsheetLogicalNavigation['cell'] | undefined {
	const match = /^([A-Z]+)([1-9]\d*)$/i.exec(address);
	if (!match) {
		return undefined;
	}
	let column = 0;
	for (const character of match[1].toUpperCase()) {
		column = column * 26 + character.charCodeAt(0) - 64;
	}
	const row = Number(match[2]);
	if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column)) {
		return undefined;
	}
	return { address: `${match[1].toUpperCase()}${row}`, row, column };
}

/** Resolves only typed sheet/cell/object identities; render coordinates and diagonal geometry are never accepted. */
export function resolveParadisSpreadsheetNavigation(locator: string, anchor?: string): ParadisSpreadsheetLogicalNavigation | undefined {
	const separator = locator.lastIndexOf('!');
	let sheetName = separator > 0 ? locator.slice(0, separator) : '';
	let target = separator > 0 ? locator.slice(separator + 1) : locator;
	const cellAnchor = anchor ? /^cell:(.+):([A-Z]+[1-9]\d*)$/i.exec(anchor) : undefined;
	const sheetAnchor = anchor ? /^sheet:(.+)$/.exec(anchor) : undefined;
	if (!sheetName) {
		if (target.startsWith('object:')) {
			sheetName = cellAnchor?.[1] ?? sheetAnchor?.[1] ?? '';
		} else if (cellAnchor) {
			sheetName = cellAnchor[1];
		} else {
			sheetName = sheetAnchor?.[1] ?? target;
			target = '';
		}
	}
	if (!sheetName || sheetName.length > 1024) {
		return undefined;
	}
	let cell = parseCellAddress(target);
	if (!cell && cellAnchor) {
		cell = parseCellAddress(cellAnchor[2]);
		if (cellAnchor[1] !== sheetName) {
			sheetName = cellAnchor[1];
		}
	}
	if (cell) {
		return { sheetName, cell };
	}
	if (target.startsWith('object:') && target.length > 'object:'.length) {
		return { sheetName, objectName: target.slice('object:'.length) };
	}
	return { sheetName };
}

export interface ParadisSpreadsheetChangeInspectorOptions {
	readonly search?: (query: string) => Promise<readonly ParadisOfficeSearchResult[]>;
	readonly getPrintModel?: () => Promise<ParadisOfficePrintModel>;
	readonly onNavigate?: (target: ParadisSpreadsheetNavigationTarget) => void;
	readonly onDidChangeViewState?: (state: ParadisSpreadsheetViewState) => void;
}

interface DataRecord {
	readonly values: ReadonlyMap<string, unknown>;
	readonly keys: readonly string[];
}

function dataRecord(value: unknown, maximumKeys: number): DataRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			return undefined;
		}
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length > maximumKeys || ownKeys.some(key => typeof key !== 'string')) {
			return undefined;
		}
		const keys = ownKeys as string[];
		const values = new Map<string, unknown>();
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return undefined;
			}
			values.set(key, descriptor.value);
		}
		return { keys, values };
	} catch {
		return undefined;
	}
}

function copyViewState(state: ParadisSpreadsheetViewState): ParadisSpreadsheetViewState {
	return Object.freeze({
		zoom: state.zoom,
		activeSheet: state.activeSheet,
		categories: Object.freeze([...state.categories]),
		...(state.selectedChangeId ? { selectedChangeId: state.selectedChangeId } : {}),
	});
}

function copySource(source: ParadisOfficeSourceDescriptor): ParadisOfficeSourceDescriptor {
	return Object.freeze({
		kind: source.kind,
		...(source.uri ? { uri: source.uri } : {}),
		...(source.revisionHint ? { revisionHint: source.revisionHint } : {}),
		displayName: source.displayName,
		...(source.side ? { side: source.side } : {}),
	});
}

function copyInput(input: ParadisSpreadsheetRestorableInput): ParadisSpreadsheetRestorableInput {
	return Object.freeze({ source: copySource(input.source), viewState: copyViewState(input.viewState) });
}

/** Accepts only the bounded source-specific view-state fields; backend handle capabilities are not a view-state field. */
export function restoreParadisSpreadsheetViewState(value: unknown, fallback: ParadisSpreadsheetViewState): ParadisSpreadsheetViewState {
	const record = dataRecord(value, 4);
	if (!record || record.keys.some(key => key !== 'zoom' && key !== 'activeSheet' && key !== 'categories' && key !== 'selectedChangeId')) {
		return copyViewState(fallback);
	}
	const zoom = record.values.get('zoom');
	const activeSheet = record.values.get('activeSheet');
	const categories = record.values.get('categories');
	const selectedChangeId = record.values.get('selectedChangeId');
	if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX
		|| typeof activeSheet !== 'string' || activeSheet.length === 0 || activeSheet.length > 1024
		|| !Array.isArray(categories) || categories.length > PARADIS_SPREADSHEET_CHANGE_CATEGORIES.length
		|| (selectedChangeId !== undefined && (typeof selectedChangeId !== 'string' || selectedChangeId.length === 0 || selectedChangeId.length > 4096))) {
		return copyViewState(fallback);
	}
	const categoryValues: ParadisOfficeChangeCategory[] = [];
	for (const category of categories) {
		if (typeof category !== 'string' || !categorySet.has(category as ParadisOfficeChangeCategory)) {
			return copyViewState(fallback);
		}
		if (!categoryValues.includes(category as ParadisOfficeChangeCategory)) {
			categoryValues.push(category as ParadisOfficeChangeCategory);
		}
	}
	return Object.freeze({ zoom, activeSheet, categories: Object.freeze(categoryValues), ...(typeof selectedChangeId === 'string' ? { selectedChangeId } : {}) });
}

/** Two-phase input state used by rapid input switches. Cancel always returns the last committed descriptor/view state. */
export class ParadisSpreadsheetInputRestoration {
	private committed: ParadisSpreadsheetRestorableInput;
	private pending: ParadisSpreadsheetRestorableInput | undefined;

	constructor(initial: ParadisSpreadsheetRestorableInput) {
		this.committed = copyInput(initial);
	}

	begin(input: ParadisSpreadsheetRestorableInput): void {
		this.pending = copyInput(input);
	}

	commit(viewState?: ParadisSpreadsheetViewState): ParadisSpreadsheetRestorableInput {
		if (this.pending) {
			this.committed = copyInput({ source: this.pending.source, viewState: viewState ?? this.pending.viewState });
			this.pending = undefined;
		}
		return copyInput(this.committed);
	}

	cancel(): ParadisSpreadsheetRestorableInput {
		this.pending = undefined;
		return copyInput(this.committed);
	}

	snapshot(): ParadisSpreadsheetRestorableInput {
		return copyInput(this.committed);
	}

	serialize(): string {
		return JSON.stringify(this.committed);
	}
}

function categoryLabel(category: ParadisOfficeChangeCategory): string {
	switch (category) {
		case 'content': return localize('paradis.spreadsheet.change.content', "内容");
		case 'formatting': return localize('paradis.spreadsheet.change.formatting', "書式");
		case 'structure': return localize('paradis.spreadsheet.change.structure', "構造");
		case 'annotation': return localize('paradis.spreadsheet.change.annotation', "コメント");
		case 'revision': return localize('paradis.spreadsheet.change.revision', "変更履歴");
		case 'object': return localize('paradis.spreadsheet.change.object', "オブジェクト");
		case 'security': return localize('paradis.spreadsheet.change.security', "セキュリティ");
	}
}

/** Keeps the three visually similar diagonal sources distinct in the Inspector. */
export function spreadsheetChangeLabel(change: ParadisOfficeChange): string {
	switch (change.subject.kind) {
		case 'cell.diagonalBorder': return localize('paradis.spreadsheet.change.baseDiagonal', "セルの斜線");
		case 'conditionalFormatting.diagonalBorder': return localize('paradis.spreadsheet.change.conditionalDiagonal', "条件付き書式の斜線");
		case 'object.lineGeometry': return localize('paradis.spreadsheet.change.drawingLine', "図形の線");
		default: return categoryLabel(change.category);
	}
}

function appendButton(parent: HTMLElement, label: string): HTMLButtonElement {
	const button = dom.append(parent, dom.$('button')) as HTMLButtonElement;
	button.type = 'button';
	button.style.color = PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.foreground;
	button.style.background = 'var(--vscode-button-secondaryBackground, transparent)';
	button.style.border = `1px solid ${PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.border}`;
	button.style.borderRadius = '2px';
	button.style.padding = '3px 6px';
	button.textContent = label;
	return button;
}

export class ParadisSpreadsheetChangeInspector extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly root: HTMLElement;
	private changes: readonly ParadisOfficeChange[] = [];
	private placeholders: readonly ParadisOfficePlaceholder[] = [];
	private results: readonly ParadisOfficeSearchResult[] = [];
	private completeness: ParadisOfficeCompletenessManifest | undefined;
	private outcome: ParadisOfficeOutcome = 'degraded';
	private printWarning: string | undefined;
	private printPlaceholderCount = 0;
	private announcement = '';
	private changePage = 0;
	private placeholderPage = 0;
	private resultPage = 0;
	private viewState: ParadisSpreadsheetViewState = Object.freeze({ zoom: 1, activeSheet: 'Sheet1', categories: PARADIS_SPREADSHEET_CHANGE_CATEGORIES });

	constructor(container: HTMLElement, private readonly options: ParadisSpreadsheetChangeInspectorOptions = {}) {
		super();
		this.root = dom.append(container, dom.$('.paradis-spreadsheet-change-inspector'));
		this.root.setAttribute('role', 'region');
		this.root.setAttribute('aria-label', localize('paradis.spreadsheet.changeInspector', "スプレッドシートの変更インスペクター"));
		this.root.style.display = 'flex';
		this.root.style.flexDirection = 'column';
		this.root.style.gap = '6px';
		this.root.style.padding = '6px';
		this.root.style.border = `1px solid ${PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.border}`;
		this.root.style.color = PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.foreground;
		this.render();
	}

	setComparison(changes: readonly ParadisOfficeChange[], completeness: ParadisOfficeCompletenessManifest, outcome: ParadisOfficeOutcome): void {
		this.changes = [...changes];
		this.changePage = 0;
		this.completeness = completeness;
		this.outcome = outcome;
		this.announcement = changes.length === 1
			? localize('paradis.spreadsheet.changeCountOne', "1 件の変更")
			: localize('paradis.spreadsheet.changeCountMany', "{0} 件の変更", changes.length);
		this.render();
	}

	setPlaceholders(placeholders: readonly ParadisOfficePlaceholder[]): void {
		this.placeholders = [...placeholders];
		this.placeholderPage = 0;
		this.render();
	}

	setViewState(value: unknown): void {
		this.viewState = restoreParadisSpreadsheetViewState(value, this.viewState);
		this.render();
	}

	getViewState(): ParadisSpreadsheetViewState {
		return copyViewState(this.viewState);
	}

	setZoom(zoom: number): void {
		this.setViewState({ ...this.viewState, zoom });
		this.options.onDidChangeViewState?.(this.getViewState());
	}

	setActiveSheet(activeSheet: string): void {
		this.setViewState({ ...this.viewState, activeSheet });
		this.options.onDidChangeViewState?.(this.getViewState());
	}

	async search(query: string): Promise<void> {
		const normalized = query.normalize('NFC').trim();
		if (!this.options.search || normalized.length === 0 || normalized.length > 4096) {
			this.results = [];
			this.render();
			return;
		}
		const results = await this.options.search(normalized);
		this.results = [...results].slice(0, MAX_STORED_SEARCH_RESULTS);
		this.resultPage = 0;
		this.announcement = this.results.length === 1
			? localize('paradis.spreadsheet.searchResultOne', "1 件の検索結果")
			: localize('paradis.spreadsheet.searchResultMany', "{0} 件の検索結果", this.results.length);
		this.render();
	}

	async requestPrintModel(): Promise<ParadisOfficePrintModel | undefined> {
		if (!this.options.getPrintModel) {
			return undefined;
		}
		const model = await this.options.getPrintModel();
		this.printWarning = spreadsheetPrintWarning(model);
		this.printPlaceholderCount = model.pages.reduce((count, page) => count + page.placeholders.length, 0);
		this.announcement = this.printWarning ?? localize('paradis.spreadsheet.printReady', "印刷プレビューの準備ができました");
		this.render();
		return model;
	}

	private updateCategories(category: ParadisOfficeChangeCategory): void {
		const categories = this.viewState.categories.includes(category)
			? this.viewState.categories.filter(value => value !== category)
			: PARADIS_SPREADSHEET_CHANGE_CATEGORIES.filter(value => value === category || this.viewState.categories.includes(value));
		this.viewState = copyViewState({ ...this.viewState, categories });
		this.changePage = 0;
		this.options.onDidChangeViewState?.(this.getViewState());
		this.render();
	}

	private navigate(kind: ParadisSpreadsheetNavigationTarget['kind'], locator: string, anchor?: string, selectedChangeId?: string): void {
		if (kind === 'change' && selectedChangeId) {
			this.viewState = copyViewState({ ...this.viewState, selectedChangeId });
			this.options.onDidChangeViewState?.(this.getViewState());
		}
		this.options.onNavigate?.({ kind, locator, ...(anchor ? { anchor } : {}) });
		this.render();
	}

	private appendPager(parent: HTMLElement, kind: 'changes' | 'placeholders' | 'results', total: number, page: number, setPage: (page: number) => void): void {
		const pageCount = Math.ceil(total / INSPECTOR_PAGE_SIZE);
		if (pageCount <= 1) {
			return;
		}
		const pager = dom.append(parent, dom.$('.paradis-spreadsheet-inspector-pager'));
		pager.dataset.pageList = kind;
		pager.setAttribute('role', 'group');
		pager.setAttribute('aria-label', localize('paradis.spreadsheet.pageNavigation', "{0} のページ移動", kind));
		const previous = appendButton(pager, localize('paradis.spreadsheet.previousPage', "前へ"));
		previous.disabled = page === 0;
		const status = dom.append(pager, dom.$('span'));
		status.textContent = localize('paradis.spreadsheet.pageStatus', "{1} ページ中 {0} ページ目", page + 1, pageCount);
		const next = appendButton(pager, localize('paradis.spreadsheet.nextPage', "次へ"));
		next.disabled = page + 1 >= pageCount;
		this.renderDisposables.add(dom.addDisposableListener(previous, dom.EventType.CLICK, () => setPage(Math.max(0, page - 1))));
		this.renderDisposables.add(dom.addDisposableListener(next, dom.EventType.CLICK, () => setPage(Math.min(pageCount - 1, page + 1))));
	}

	private render(): void {
		this.renderDisposables.clear();
		dom.clearNode(this.root);
		const document = this.root.ownerDocument;
		const title = dom.append(this.root, dom.$('strong'));
		title.textContent = localize('paradis.spreadsheet.changes', "変更点");

		const categories = dom.append(this.root, dom.$('.paradis-spreadsheet-change-categories'));
		categories.setAttribute('role', 'toolbar');
		categories.setAttribute('aria-label', localize('paradis.spreadsheet.changeCategories', "変更の種類"));
		categories.style.display = 'flex';
		categories.style.flexWrap = 'wrap';
		categories.style.gap = '3px';
		for (const category of PARADIS_SPREADSHEET_CHANGE_CATEGORIES) {
			const count = this.changes.filter(change => change.category === category).length;
			const button = appendButton(categories, `${categoryLabel(category)} ${count}`);
			button.dataset.category = category;
			button.dataset.count = String(count);
			button.setAttribute('aria-pressed', String(this.viewState.categories.includes(category)));
			this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.updateCategories(category)));
		}

		const changeList = dom.append(this.root, dom.$('.paradis-spreadsheet-change-list'));
		changeList.setAttribute('role', 'list');
		const visibleChanges = this.changes.filter(change => this.viewState.categories.includes(change.category));
		const changeCount = dom.append(changeList, dom.$('span'));
		changeCount.textContent = visibleChanges.length === 1
			? localize('paradis.spreadsheet.visibleChangeCountOne', "1 件の変更")
			: localize('paradis.spreadsheet.visibleChangeCountMany', "{0} 件の変更", visibleChanges.length);
		if (visibleChanges.length === 0) {
			const empty = dom.append(changeList, dom.$('span'));
			empty.textContent = this.completeness && canShowSpreadsheetNoChanges(this.completeness, this.outcome, this.changes.length)
				? localize('paradis.spreadsheet.noChangesStrict', "変更なし")
				: localize('paradis.spreadsheet.analysisIncomplete', "解析未完了");
		} else {
			const pageCount = Math.max(1, Math.ceil(visibleChanges.length / INSPECTOR_PAGE_SIZE));
			this.changePage = Math.min(this.changePage, pageCount - 1);
			for (const change of visibleChanges.slice(this.changePage * INSPECTOR_PAGE_SIZE, (this.changePage + 1) * INSPECTOR_PAGE_SIZE)) {
				const item = dom.append(changeList, dom.$('.paradis-spreadsheet-change-item'));
				item.setAttribute('role', 'listitem');
				const button = appendButton(item, `${spreadsheetChangeLabel(change)} — ${change.subject.locator}`);
				button.dataset.changeId = change.id;
				button.setAttribute('aria-label', localize('paradis.spreadsheet.navigateChange', "{1} の{0}へ移動", spreadsheetChangeLabel(change), change.subject.locator));
				button.setAttribute('aria-current', String(this.viewState.selectedChangeId === change.id));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('change', change.subject.locator, change.navigableAnchor, change.id)));
			}
			this.appendPager(changeList, 'changes', visibleChanges.length, this.changePage, page => {
				this.changePage = page;
				this.render();
			});
		}

		if (this.placeholders.length > 0) {
			const placeholderList = dom.append(this.root, dom.$('.paradis-spreadsheet-placeholder-list'));
			placeholderList.setAttribute('role', 'list');
			placeholderList.setAttribute('aria-label', localize('paradis.spreadsheet.placeholders', "代替表示のコンテンツ"));
			const placeholderCount = dom.append(placeholderList, dom.$('span'));
			placeholderCount.textContent = localize('paradis.spreadsheet.placeholderCount', "代替表示 {0} 件", this.placeholders.length);
			for (const placeholder of this.placeholders.slice(this.placeholderPage * INSPECTOR_PAGE_SIZE, (this.placeholderPage + 1) * INSPECTOR_PAGE_SIZE)) {
				const button = appendButton(placeholderList, placeholder.detail ? `${placeholder.title} — ${placeholder.detail}` : placeholder.title);
				button.dataset.placeholderId = placeholder.nodeId;
				button.setAttribute('aria-label', localize('paradis.spreadsheet.navigatePlaceholder', "代替表示「{0}」へ移動", placeholder.title));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('placeholder', placeholder.nodeId)));
			}
			this.appendPager(placeholderList, 'placeholders', this.placeholders.length, this.placeholderPage, page => {
				this.placeholderPage = page;
				this.render();
			});
		}

		if (this.options.search) {
			const search = dom.append(this.root, dom.$('form.paradis-spreadsheet-search')) as HTMLFormElement;
			search.setAttribute('role', 'search');
			const input = dom.append(search, dom.$('input')) as HTMLInputElement;
			input.type = 'search';
			input.maxLength = 4096;
			input.setAttribute('aria-label', localize('paradis.spreadsheet.search', "スプレッドシートを検索"));
			const button = appendButton(search, localize('paradis.spreadsheet.searchButton', "検索"));
			button.type = 'submit';
			this.renderDisposables.add(dom.addDisposableListener(search, dom.EventType.SUBMIT, event => {
				event.preventDefault();
				void this.search(input.value);
			}));
			this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, event => {
				event.preventDefault();
				void this.search(input.value);
			}));
			button.setAttribute('aria-label', localize('paradis.spreadsheet.searchButton', "検索"));
		}

		if (this.results.length > 0) {
			const results = dom.append(this.root, dom.$('.paradis-spreadsheet-search-results'));
			results.setAttribute('role', 'list');
			for (const result of this.results.slice(this.resultPage * INSPECTOR_PAGE_SIZE, (this.resultPage + 1) * INSPECTOR_PAGE_SIZE)) {
				const label = `${result.locationBadge.label}: ${result.preview.before}${result.preview.match}${result.preview.after}`;
				const button = appendButton(results, label);
				button.dataset.searchResultId = result.id;
				button.setAttribute('aria-label', localize('paradis.spreadsheet.navigateSearchResult', "{0} 内の検索結果へ移動", result.locationBadge.label));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('search', result.locator, result.navigableAnchor)));
			}
			this.appendPager(results, 'results', this.results.length, this.resultPage, page => {
				this.resultPage = page;
				this.render();
			});
		}

		if (this.options.getPrintModel) {
			const print = appendButton(this.root, localize('paradis.spreadsheet.printPreview', "印刷プレビュー"));
			print.setAttribute('aria-label', localize('paradis.spreadsheet.printPreview', "印刷プレビュー"));
			this.renderDisposables.add(dom.addDisposableListener(print, dom.EventType.CLICK, () => void this.requestPrintModel()));
		}
		if (this.printWarning || this.printPlaceholderCount > 0) {
			const alert = dom.append(this.root, dom.$('.paradis-spreadsheet-print-warning'));
			alert.setAttribute('role', 'alert');
			alert.style.color = PARADIS_SPREADSHEET_HIGH_CONTRAST_TOKENS.warning;
			const placeholders = this.printPlaceholderCount === 1
				? localize('paradis.spreadsheet.printPlaceholderOne', "代替表示 1 件")
				: localize('paradis.spreadsheet.printPlaceholderMany', "代替表示 {0} 件", this.printPlaceholderCount);
			alert.textContent = [this.printWarning, this.printPlaceholderCount > 0 ? placeholders : undefined].filter((value): value is string => !!value).join(' ');
		}

		const live = document.createElement('span');
		live.className = 'paradis-spreadsheet-change-live';
		live.setAttribute('aria-live', 'polite');
		live.setAttribute('aria-atomic', 'true');
		live.style.position = 'absolute';
		live.style.width = '1px';
		live.style.height = '1px';
		live.style.overflow = 'hidden';
		live.textContent = this.announcement;
		this.root.appendChild(live);
	}
}
