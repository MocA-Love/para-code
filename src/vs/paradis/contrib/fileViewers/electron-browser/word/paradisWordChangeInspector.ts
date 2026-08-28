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
import type { ParadisWordStoryKind } from '../../common/word/paradisWordSemantic.js';
import { PARADIS_WORD_HIGH_CONTRAST_TOKENS, canShowWordNoChanges, wordPrintWarning } from './paradisWordDiagnostics.js';

export const PARADIS_WORD_CHANGE_CATEGORIES: readonly ParadisOfficeChangeCategory[] = Object.freeze([
	'content',
	'formatting',
	'structure',
	'annotation',
	'revision',
	'object',
	'security',
]);

export type ParadisWordDisplayMode = 'final' | 'original' | 'markup';

const categorySet = new Set<ParadisOfficeChangeCategory>(PARADIS_WORD_CHANGE_CATEGORIES);
const storyKindSet = new Set<ParadisWordStoryKind>(['body', 'header', 'footer', 'footnote', 'endnote', 'comment', 'textbox', 'glossary']);
const displayModeSet = new Set<ParadisWordDisplayMode>(['final', 'original', 'markup']);
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const INSPECTOR_PAGE_SIZE = 100;
const MAX_STORED_SEARCH_RESULTS = 10_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_STRING_LENGTH = 4096;

export interface ParadisWordViewState {
	readonly zoom: number;
	readonly displayMode: ParadisWordDisplayMode;
	readonly activeStory: string;
	readonly categories: readonly ParadisOfficeChangeCategory[];
	readonly selectedChangeId?: string;
}

export interface ParadisWordRestorableInput {
	readonly source: ParadisOfficeSourceDescriptor;
	readonly viewState: ParadisWordViewState;
}

/** Input-open fence: only the newest open may commit or restore editor state. */
export class ParadisWordOpenGeneration {
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

/** Grants at most one blank-render retry to the current open generation. */
export class ParadisWordBlankRetry {
	private generation = 0;
	private consumed = false;

	begin(): number {
		this.consumed = false;
		return ++this.generation;
	}

	invalidate(): void {
		this.generation++;
		this.consumed = true;
	}

	shouldRetry(generation: number, blank: boolean): boolean {
		if (!blank || generation !== this.generation || this.consumed) {
			return false;
		}
		this.consumed = true;
		return true;
	}
}

export interface ParadisWordNavigationTarget {
	readonly kind: 'change' | 'placeholder' | 'search';
	readonly locator: string;
	readonly anchor?: string;
}

export interface ParadisWordLogicalNavigation {
	readonly storyKind: ParadisWordStoryKind;
	readonly partUri: string;
	readonly storyIdentity: string;
	readonly nodeId?: string;
}

/** Resolves semantic Story/node identities only; no render coordinates or geometry are accepted. */
export function resolveParadisWordNavigation(locator: string, anchor?: string): ParadisWordLogicalNavigation | undefined {
	if (typeof locator !== 'string' || !locator.startsWith('story:') || locator.length > MAX_STRING_LENGTH
		|| (anchor !== undefined && (typeof anchor !== 'string' || anchor.length === 0 || anchor.length > MAX_STRING_LENGTH))) {
		return undefined;
	}
	const nodeSeparator = locator.lastIndexOf('/node:');
	const storyLocator = nodeSeparator >= 0 ? locator.slice(0, nodeSeparator) : locator;
	const locatorNodeId = nodeSeparator >= 0 ? locator.slice(nodeSeparator + '/node:'.length) : undefined;
	const value = storyLocator.slice('story:'.length);
	const kindSeparator = value.indexOf(':');
	const identitySeparator = value.lastIndexOf(':');
	if (kindSeparator <= 0 || identitySeparator <= kindSeparator + 1) {
		return undefined;
	}
	const storyKind = value.slice(0, kindSeparator);
	const partUri = value.slice(kindSeparator + 1, identitySeparator);
	const storyIdentity = value.slice(identitySeparator + 1);
	const nodeId = anchor ?? locatorNodeId;
	if (!storyKindSet.has(storyKind as ParadisWordStoryKind) || !partUri || !storyIdentity
		|| (nodeId !== undefined && (nodeId.length === 0 || nodeId.length > MAX_STRING_LENGTH))) {
		return undefined;
	}
	return { storyKind: storyKind as ParadisWordStoryKind, partUri, storyIdentity, ...(nodeId ? { nodeId } : {}) };
}

export interface ParadisWordSearchStory {
	readonly id: string;
	readonly kind: ParadisWordStoryKind;
	readonly partUri: string;
	readonly identity: string;
	readonly text: string;
}

/** Compatibility search over already-typed Stories, including headers, notes, comments, and textboxes. */
export function searchParadisWordStories(stories: readonly ParadisWordSearchStory[], query: string): readonly ParadisOfficeSearchResult[] {
	const normalizedQuery = query.normalize('NFC').trim();
	if (!normalizedQuery || normalizedQuery.length > MAX_STRING_LENGTH) {
		return [];
	}
	const foldedQuery = normalizedQuery.toLocaleLowerCase();
	const results: ParadisOfficeSearchResult[] = [];
	for (const story of stories) {
		if (results.length >= MAX_SEARCH_RESULTS || !storyKindSet.has(story.kind) || !story.id || !story.partUri || !story.identity) {
			if (results.length >= MAX_SEARCH_RESULTS) {
				break;
			}
			continue;
		}
		const text = story.text.normalize('NFC');
		const folded = text.toLocaleLowerCase();
		let offset = 0;
		let ordinal = 0;
		while (results.length < MAX_SEARCH_RESULTS) {
			const index = folded.indexOf(foldedQuery, offset);
			if (index < 0) {
				break;
			}
			const end = index + normalizedQuery.length;
			results.push(Object.freeze({
				id: `word-search:${story.id}:${ordinal++}`,
				locator: `story:${story.kind}:${story.partUri}:${story.identity}`,
				preview: Object.freeze({
					before: text.slice(Math.max(0, index - 40), index),
					match: text.slice(index, end),
					after: text.slice(end, Math.min(text.length, end + 40)),
				}),
				locationBadge: Object.freeze({ kind: 'story', label: storyLabel(story.kind) }),
				navigableAnchor: story.id,
			}));
			offset = Math.max(end, index + 1);
		}
	}
	return Object.freeze(results);
}

export interface ParadisWordChangeInspectorOptions {
	readonly search?: (query: string) => Promise<readonly ParadisOfficeSearchResult[]>;
	readonly getPrintModel?: () => Promise<ParadisOfficePrintModel>;
	readonly searchUnavailable?: string;
	readonly printUnavailable?: string;
	readonly onNavigate?: (target: ParadisWordNavigationTarget) => void;
	readonly onDidChangeViewState?: (state: ParadisWordViewState) => void;
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

function copyViewState(state: ParadisWordViewState): ParadisWordViewState {
	return Object.freeze({
		zoom: state.zoom,
		displayMode: state.displayMode,
		activeStory: state.activeStory,
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

function copyInput(input: ParadisWordRestorableInput): ParadisWordRestorableInput {
	return Object.freeze({ source: copySource(input.source), viewState: copyViewState(input.viewState) });
}

/** Accepts bounded source-specific fields only; backend handle IDs are not view state. */
export function restoreParadisWordViewState(value: unknown, fallback: ParadisWordViewState): ParadisWordViewState {
	const record = dataRecord(value, 5);
	if (!record || record.keys.some(key => key !== 'zoom' && key !== 'displayMode' && key !== 'activeStory' && key !== 'categories' && key !== 'selectedChangeId')) {
		return copyViewState(fallback);
	}
	const zoom = record.values.get('zoom');
	const displayMode = record.values.get('displayMode');
	const activeStory = record.values.get('activeStory');
	const categories = record.values.get('categories');
	const selectedChangeId = record.values.get('selectedChangeId');
	if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX
		|| typeof displayMode !== 'string' || !displayModeSet.has(displayMode as ParadisWordDisplayMode)
		|| typeof activeStory !== 'string' || activeStory.length === 0 || activeStory.length > MAX_STRING_LENGTH
		|| !Array.isArray(categories) || categories.length > PARADIS_WORD_CHANGE_CATEGORIES.length
		|| (selectedChangeId !== undefined && (typeof selectedChangeId !== 'string' || selectedChangeId.length === 0 || selectedChangeId.length > MAX_STRING_LENGTH))) {
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
	return Object.freeze({
		zoom,
		displayMode: displayMode as ParadisWordDisplayMode,
		activeStory,
		categories: Object.freeze(categoryValues),
		...(typeof selectedChangeId === 'string' ? { selectedChangeId } : {}),
	});
}

/** Two-phase input state. Cancellation always returns the last committed descriptor and view state. */
export class ParadisWordInputRestoration {
	private committed: ParadisWordRestorableInput;
	private pending: ParadisWordRestorableInput | undefined;

	constructor(initial: ParadisWordRestorableInput) {
		this.committed = copyInput(initial);
	}

	begin(input: ParadisWordRestorableInput): void {
		this.pending = copyInput(input);
	}

	commit(viewState?: ParadisWordViewState): ParadisWordRestorableInput {
		if (this.pending) {
			this.committed = copyInput({ source: this.pending.source, viewState: viewState ?? this.pending.viewState });
			this.pending = undefined;
		}
		return copyInput(this.committed);
	}

	cancel(): ParadisWordRestorableInput {
		this.pending = undefined;
		return copyInput(this.committed);
	}

	snapshot(): ParadisWordRestorableInput {
		return copyInput(this.committed);
	}

	serialize(): string {
		return JSON.stringify(this.committed);
	}
}

function categoryLabel(category: ParadisOfficeChangeCategory): string {
	switch (category) {
		case 'content': return localize('paradis.word.change.content', "Content");
		case 'formatting': return localize('paradis.word.change.formatting', "Formatting");
		case 'structure': return localize('paradis.word.change.structure', "Structure");
		case 'annotation': return localize('paradis.word.change.annotation', "Annotations");
		case 'revision': return localize('paradis.word.change.revision', "Revisions");
		case 'object': return localize('paradis.word.change.object', "Objects");
		case 'security': return localize('paradis.word.change.security', "Security");
	}
}

function storyLabel(kind: ParadisWordStoryKind | 'package'): string {
	switch (kind) {
		case 'body': return localize('paradis.word.story.body', "Body");
		case 'header': return localize('paradis.word.story.header', "Header");
		case 'footer': return localize('paradis.word.story.footer', "Footer");
		case 'footnote': return localize('paradis.word.story.footnote', "Footnote");
		case 'endnote': return localize('paradis.word.story.endnote', "Endnote");
		case 'comment': return localize('paradis.word.story.comment', "Comment");
		case 'textbox': return localize('paradis.word.story.textbox', "Text Box");
		case 'glossary': return localize('paradis.word.story.glossary', "Glossary");
		case 'package': return localize('paradis.word.story.package', "Package");
	}
}

/** Keeps visually similar Word table diagonals and Drawing lines distinct. */
export function wordChangeLabel(change: ParadisOfficeChange): string {
	switch (change.subject.kind) {
		case 'table.diagonalBorder': return localize('paradis.word.change.tableDiagonal', "Table Diagonal Border");
		case 'object.lineGeometry': return localize('paradis.word.change.drawingLine', "Drawing Line");
		case 'object.omml': return localize('paradis.word.change.math', "Math");
		case 'object.imageReference': return localize('paradis.word.change.image', "Image");
		case 'package.style': return localize('paradis.word.change.style', "Style");
		case 'paragraph.text': return localize('paradis.word.change.content', "Content");
		default: return categoryLabel(change.category);
	}
}

function appendButton(parent: HTMLElement, label: string): HTMLButtonElement {
	const button = dom.append(parent, dom.$('button')) as HTMLButtonElement;
	button.type = 'button';
	button.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.foreground;
	button.style.background = 'var(--vscode-button-secondaryBackground, transparent)';
	button.style.border = `1px solid ${PARADIS_WORD_HIGH_CONTRAST_TOKENS.border}`;
	button.style.borderRadius = '2px';
	button.style.padding = '3px 6px';
	button.textContent = label;
	return button;
}

function storyIdentity(change: ParadisOfficeChange): { readonly kind: ParadisWordStoryKind | 'package'; readonly root: string } {
	if (!change.subject.locator.startsWith('story:')) {
		return { kind: 'package', root: 'package' };
	}
	const nodeSeparator = change.subject.locator.lastIndexOf('/node:');
	const root = nodeSeparator >= 0 ? change.subject.locator.slice(0, nodeSeparator) : change.subject.locator;
	const value = root.slice('story:'.length);
	const separator = value.indexOf(':');
	const kind = separator > 0 ? value.slice(0, separator) : '';
	return storyKindSet.has(kind as ParadisWordStoryKind) ? { kind: kind as ParadisWordStoryKind, root } : { kind: 'package', root: 'package' };
}

export class ParadisWordChangeInspector extends Disposable {
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
	private viewState: ParadisWordViewState = Object.freeze({ zoom: 1, displayMode: 'final', activeStory: 'all', categories: PARADIS_WORD_CHANGE_CATEGORIES });

	constructor(container: HTMLElement, private readonly options: ParadisWordChangeInspectorOptions = {}) {
		super();
		this.root = dom.append(container, dom.$('.paradis-word-change-inspector'));
		this.root.setAttribute('role', 'region');
		this.root.setAttribute('aria-label', localize('paradis.word.changeInspector', "Word Change Inspector"));
		this.root.style.display = 'flex';
		this.root.style.flexDirection = 'column';
		this.root.style.gap = '6px';
		this.root.style.padding = '6px';
		this.root.style.border = `1px solid ${PARADIS_WORD_HIGH_CONTRAST_TOKENS.border}`;
		this.root.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.foreground;
		this.render();
	}

	setComparison(changes: readonly ParadisOfficeChange[], completeness: ParadisOfficeCompletenessManifest, outcome: ParadisOfficeOutcome): void {
		this.changes = [...changes];
		this.changePage = 0;
		this.completeness = completeness;
		this.outcome = outcome;
		this.announcement = changes.length === 1
			? localize('paradis.word.changeCountOne', "1 change")
			: localize('paradis.word.changeCountMany', "{0} changes", changes.length);
		this.render();
	}

	setPlaceholders(placeholders: readonly ParadisOfficePlaceholder[]): void {
		this.placeholders = [...placeholders];
		this.placeholderPage = 0;
		this.render();
	}

	setViewState(value: unknown): void {
		this.viewState = restoreParadisWordViewState(value, this.viewState);
		this.render();
	}

	getViewState(): ParadisWordViewState {
		return copyViewState(this.viewState);
	}

	setZoom(zoom: number): void {
		this.setViewState({ ...this.viewState, zoom });
		this.options.onDidChangeViewState?.(this.getViewState());
	}

	setDisplayMode(displayMode: ParadisWordDisplayMode): void {
		this.setViewState({ ...this.viewState, displayMode });
		this.options.onDidChangeViewState?.(this.getViewState());
	}

	async search(query: string): Promise<void> {
		const normalized = query.normalize('NFC').trim();
		if (!this.options.search || normalized.length === 0 || normalized.length > MAX_STRING_LENGTH) {
			this.results = [];
			this.render();
			return;
		}
		const results = await this.options.search(normalized);
		this.results = [...results].slice(0, MAX_STORED_SEARCH_RESULTS);
		this.resultPage = 0;
		this.announcement = this.results.length === 1
			? localize('paradis.word.searchResultOne', "1 search result")
			: localize('paradis.word.searchResultMany', "{0} search results", this.results.length);
		this.render();
	}

	async requestPrintModel(): Promise<ParadisOfficePrintModel | undefined> {
		if (!this.options.getPrintModel) {
			return undefined;
		}
		const model = await this.options.getPrintModel();
		this.printWarning = wordPrintWarning(model);
		this.printPlaceholderCount = model.pages.reduce((count, page) => count + page.placeholders.length, 0);
		this.announcement = this.printWarning ?? localize('paradis.word.printReady', "Print Preview Ready");
		this.render();
		return model;
	}

	private updateCategories(category: ParadisOfficeChangeCategory): void {
		const categories = this.viewState.categories.includes(category)
			? this.viewState.categories.filter(value => value !== category)
			: PARADIS_WORD_CHANGE_CATEGORIES.filter(value => value === category || this.viewState.categories.includes(value));
		this.viewState = copyViewState({ ...this.viewState, categories });
		this.changePage = 0;
		this.options.onDidChangeViewState?.(this.getViewState());
		this.render();
	}

	private updateStory(activeStory: string): void {
		this.viewState = copyViewState({ ...this.viewState, activeStory: this.viewState.activeStory === activeStory ? 'all' : activeStory });
		this.changePage = 0;
		this.options.onDidChangeViewState?.(this.getViewState());
		this.render();
	}

	private navigate(kind: ParadisWordNavigationTarget['kind'], locator: string, anchor?: string, selectedChangeId?: string): void {
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
		const pager = dom.append(parent, dom.$('.paradis-word-inspector-pager'));
		pager.dataset.pageList = kind;
		pager.setAttribute('role', 'group');
		pager.setAttribute('aria-label', localize('paradis.word.pageNavigation', "{0} page navigation", kind));
		const previous = appendButton(pager, localize('paradis.word.previousPage', "Previous"));
		previous.disabled = page === 0;
		const status = dom.append(pager, dom.$('span'));
		status.textContent = localize('paradis.word.pageStatus', "Page {0} of {1}", page + 1, pageCount);
		const next = appendButton(pager, localize('paradis.word.nextPage', "Next"));
		next.disabled = page + 1 >= pageCount;
		this.renderDisposables.add(dom.addDisposableListener(previous, dom.EventType.CLICK, () => setPage(Math.max(0, page - 1))));
		this.renderDisposables.add(dom.addDisposableListener(next, dom.EventType.CLICK, () => setPage(Math.min(pageCount - 1, page + 1))));
	}

	private render(): void {
		this.renderDisposables.clear();
		dom.clearNode(this.root);
		const document = this.root.ownerDocument;
		const title = dom.append(this.root, dom.$('strong'));
		title.textContent = localize('paradis.word.changes', "Changes");

		const modes = dom.append(this.root, dom.$('.paradis-word-display-modes'));
		modes.setAttribute('role', 'toolbar');
		modes.setAttribute('aria-label', localize('paradis.word.displayModes', "Revision Display"));
		for (const mode of displayModeSet) {
			const label = mode === 'final' ? localize('paradis.word.mode.final', "Final")
				: mode === 'original' ? localize('paradis.word.mode.original', "Original")
					: localize('paradis.word.mode.markup', "Markup");
			const button = appendButton(modes, label);
			button.dataset.wordMode = mode;
			button.setAttribute('aria-pressed', String(this.viewState.displayMode === mode));
			this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setDisplayMode(mode)));
		}

		const zoom = dom.append(this.root, dom.$('.paradis-word-inspector-zoom'));
		zoom.setAttribute('role', 'group');
		zoom.setAttribute('aria-label', localize('paradis.word.zoom', "Zoom"));
		const zoomOut = appendButton(zoom, localize('paradis.word.zoomOut', "Zoom Out"));
		zoomOut.dataset.wordZoom = 'out';
		const zoomStatus = dom.append(zoom, dom.$('span'));
		zoomStatus.textContent = `${Math.round(this.viewState.zoom * 100)}%`;
		const zoomIn = appendButton(zoom, localize('paradis.word.zoomIn', "Zoom In"));
		zoomIn.dataset.wordZoom = 'in';
		this.renderDisposables.add(dom.addDisposableListener(zoomOut, dom.EventType.CLICK, () => this.setZoom(Math.max(ZOOM_MIN, this.viewState.zoom / 1.2))));
		this.renderDisposables.add(dom.addDisposableListener(zoomIn, dom.EventType.CLICK, () => this.setZoom(Math.min(ZOOM_MAX, this.viewState.zoom * 1.2))));

		const categories = dom.append(this.root, dom.$('.paradis-word-change-categories'));
		categories.setAttribute('role', 'toolbar');
		categories.setAttribute('aria-label', localize('paradis.word.changeCategories', "Change Categories"));
		categories.style.display = 'flex';
		categories.style.flexWrap = 'wrap';
		categories.style.gap = '3px';
		for (const category of PARADIS_WORD_CHANGE_CATEGORIES) {
			const count = this.changes.filter(change => change.category === category).length;
			const button = appendButton(categories, `${categoryLabel(category)} ${count}`);
			button.dataset.category = category;
			button.dataset.count = String(count);
			button.setAttribute('aria-pressed', String(this.viewState.categories.includes(category)));
			this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.updateCategories(category)));
		}

		const storyCounts = new Map<ParadisWordStoryKind | 'package', number>();
		for (const change of this.changes) {
			const story = storyIdentity(change);
			storyCounts.set(story.kind, (storyCounts.get(story.kind) ?? 0) + 1);
		}
		if (storyCounts.size > 0) {
			const stories = dom.append(this.root, dom.$('.paradis-word-story-counts'));
			stories.setAttribute('role', 'group');
			stories.setAttribute('aria-label', localize('paradis.word.stories', "Stories"));
			for (const [kind, count] of storyCounts) {
				const filter = `kind:${kind}`;
				const button = appendButton(stories, `${storyLabel(kind)} ${count}`);
				button.dataset.storyKind = kind;
				button.dataset.count = String(count);
				button.setAttribute('aria-pressed', String(this.viewState.activeStory === filter));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.updateStory(filter)));
			}
		}

		const changeList = dom.append(this.root, dom.$('.paradis-word-change-list'));
		changeList.setAttribute('role', 'list');
		const visibleChanges = this.changes.filter(change => {
			const story = storyIdentity(change);
			const storyVisible = this.viewState.activeStory === 'all' || this.viewState.activeStory === story.root || this.viewState.activeStory === `kind:${story.kind}`;
			return storyVisible && this.viewState.categories.includes(change.category);
		});
		const changeCount = dom.append(changeList, dom.$('span'));
		changeCount.textContent = visibleChanges.length === 1
			? localize('paradis.word.visibleChangeCountOne', "1 change")
			: localize('paradis.word.visibleChangeCountMany', "{0} changes", visibleChanges.length);
		if (visibleChanges.length === 0) {
			const empty = dom.append(changeList, dom.$('span'));
			empty.textContent = this.completeness && canShowWordNoChanges(this.completeness, this.outcome, this.changes.length)
				? localize('paradis.word.noChangesStrict', "No Changes")
				: localize('paradis.word.analysisIncomplete', "Analysis Incomplete");
		} else {
			const pageCount = Math.max(1, Math.ceil(visibleChanges.length / INSPECTOR_PAGE_SIZE));
			this.changePage = Math.min(this.changePage, pageCount - 1);
			for (const change of visibleChanges.slice(this.changePage * INSPECTOR_PAGE_SIZE, (this.changePage + 1) * INSPECTOR_PAGE_SIZE)) {
				const item = dom.append(changeList, dom.$('.paradis-word-change-item'));
				item.setAttribute('role', 'listitem');
				const label = wordChangeLabel(change);
				const button = appendButton(item, `${label} — ${change.subject.locator}`);
				button.dataset.changeId = change.id;
				button.setAttribute('aria-label', localize('paradis.word.navigateChange', "Navigate to {0} at {1}", label, change.subject.locator));
				button.setAttribute('aria-current', String(this.viewState.selectedChangeId === change.id));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('change', change.subject.locator, change.navigableAnchor, change.id)));
			}
			this.appendPager(changeList, 'changes', visibleChanges.length, this.changePage, page => {
				this.changePage = page;
				this.render();
			});
		}

		if (this.placeholders.length > 0) {
			const placeholderList = dom.append(this.root, dom.$('.paradis-word-placeholder-list'));
			placeholderList.setAttribute('role', 'list');
			placeholderList.setAttribute('aria-label', localize('paradis.word.placeholders', "Alternative Content"));
			const count = dom.append(placeholderList, dom.$('span'));
			count.textContent = localize('paradis.word.placeholderCount', "{0} placeholders", this.placeholders.length);
			for (const placeholder of this.placeholders.slice(this.placeholderPage * INSPECTOR_PAGE_SIZE, (this.placeholderPage + 1) * INSPECTOR_PAGE_SIZE)) {
				const button = appendButton(placeholderList, placeholder.detail ? `${placeholder.title} — ${placeholder.detail}` : placeholder.title);
				button.dataset.placeholderId = placeholder.nodeId;
				button.setAttribute('aria-label', localize('paradis.word.navigatePlaceholder', "Navigate to alternative content {0}", placeholder.title));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('placeholder', placeholder.nodeId)));
			}
			this.appendPager(placeholderList, 'placeholders', this.placeholders.length, this.placeholderPage, page => {
				this.placeholderPage = page;
				this.render();
			});
		}

		if (this.options.search) {
			const search = dom.append(this.root, dom.$('form.paradis-word-search')) as HTMLFormElement;
			search.setAttribute('role', 'search');
			const input = dom.append(search, dom.$('input')) as HTMLInputElement;
			input.type = 'search';
			input.maxLength = MAX_STRING_LENGTH;
			input.setAttribute('aria-label', localize('paradis.word.search', "Search Word Document"));
			const button = appendButton(search, localize('paradis.word.searchButton', "Search"));
			button.type = 'submit';
			this.renderDisposables.add(dom.addDisposableListener(search, dom.EventType.SUBMIT, event => {
				event.preventDefault();
				void this.search(input.value);
			}));
			this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, event => {
				event.preventDefault();
				void this.search(input.value);
			}));
		} else if (this.options.searchUnavailable) {
			const unavailable = dom.append(this.root, dom.$('span.paradis-word-search-unavailable'));
			unavailable.setAttribute('role', 'status');
			unavailable.textContent = this.options.searchUnavailable;
		}

		if (this.results.length > 0) {
			const results = dom.append(this.root, dom.$('.paradis-word-search-results'));
			results.setAttribute('role', 'list');
			for (const result of this.results.slice(this.resultPage * INSPECTOR_PAGE_SIZE, (this.resultPage + 1) * INSPECTOR_PAGE_SIZE)) {
				const label = `${result.locationBadge.label}: ${result.preview.before}${result.preview.match}${result.preview.after}`;
				const button = appendButton(results, label);
				button.dataset.searchResultId = result.id;
				button.setAttribute('aria-label', localize('paradis.word.navigateSearchResult', "Navigate to search result in {0}", result.locationBadge.label));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('search', result.locator, result.navigableAnchor)));
			}
			this.appendPager(results, 'results', this.results.length, this.resultPage, page => {
				this.resultPage = page;
				this.render();
			});
		}

		if (this.options.getPrintModel) {
			const print = appendButton(this.root, localize('paradis.word.printPreview', "Print Preview"));
			print.setAttribute('aria-label', localize('paradis.word.printPreview', "Print Preview"));
			this.renderDisposables.add(dom.addDisposableListener(print, dom.EventType.CLICK, () => void this.requestPrintModel()));
		} else if (this.options.printUnavailable) {
			const unavailable = dom.append(this.root, dom.$('span.paradis-word-print-unavailable'));
			unavailable.setAttribute('role', 'status');
			unavailable.textContent = this.options.printUnavailable;
		}
		if (this.printWarning || this.printPlaceholderCount > 0) {
			const alert = dom.append(this.root, dom.$('.paradis-word-print-warning'));
			alert.setAttribute('role', 'alert');
			alert.style.color = PARADIS_WORD_HIGH_CONTRAST_TOKENS.warning;
			const placeholders = this.printPlaceholderCount === 1
				? localize('paradis.word.printPlaceholderOne', "1 placeholder")
				: localize('paradis.word.printPlaceholderMany', "{0} placeholders", this.printPlaceholderCount);
			alert.textContent = [this.printWarning, this.printPlaceholderCount > 0 ? placeholders : undefined].filter((value): value is string => !!value).join(' ');
		}

		const live = document.createElement('span');
		live.className = 'paradis-word-change-live';
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
