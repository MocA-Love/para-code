/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
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
import { PARADIS_WORD_STORY_KINDS, paradisWordChangeCategoryLabel, paradisWordChangeRecordText, paradisWordChangeStory, paradisWordNodeKindLabel, paradisWordStoryLabel, wordChangeLabel, wordChangeText } from '../../common/word/paradisWordChangeLabels.js';
import { truncateParadisWordText, type IParadisWordAnalysisCounts } from '../../common/word/paradisWordSemanticSummary.js';
import type { IParadisWordInlineMark } from '../../common/word/paradisWordRenderOutline.js';
import { canShowWordNoChanges, paradisWordBlockedFeatureLabel, paradisWordIgnoredReasonLabel, wordPrintWarning, type ParadisWordPackageExclusions } from './paradisWordDiagnostics.js';
import { ParadisInputField } from '../../../../browser/paradisInputField.js';
import { appendParadisOfficeInspectorButton, appendParadisOfficePanelHead, setParadisOfficeRowHover, type ParadisOfficeInspectorButtonKind } from '../paradisOfficeInspectorParts.js';

// 表示名は common へ移した（スマホの Word 差分と共有）。既存の import 先を変えないため、ここからも出す。
export { paradisWordStoryLabel, wordChangeLabel, wordChangeText };

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
const storyKindSet = PARADIS_WORD_STORY_KINDS;
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
	/** 変更を選んだとき、その変更の id。同じ場所に変更が 2 つ以上あっても取り違えないために使う。 */
	readonly changeId?: string;
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
				locationBadge: Object.freeze({ kind: 'story', label: paradisWordStoryLabel(story.kind) }),
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
	/** パネルの見出しの「閉じる」を押したとき。省くと閉じるボタンを出さない。 */
	readonly onClose?: () => void;
	readonly onDidChangeViewState?: (state: ParadisWordViewState) => void;
	/** 「段落の情報」の行を選んだとき（本文の該当箇所を示し、その情報の吹き出しを開く）。 */
	readonly onOpenMark?: (id: number) => void;
}

/** 変更点パネルの「段落の情報」の 1 行。本文の点線の印（吹き出しで情報を出す要素）と同じものを指す。 */
export interface ParadisWordMarkItem {
	/** webview の印と対応させる番号。 */
	readonly id: number;
	/** 種類（「フィールド」など）。 */
	readonly kind: string;
	/** 印の中身の要約（フィールドの命令・画像の場所など）。空のこともある。 */
	readonly summary: string;
	/** どの段落か（「2 段落目」「ヘッダー・1 段落目」）。 */
	readonly location: string;
}

const MARK_SUMMARY_LIMIT = 80;

function markKindLabel(mark: IParadisWordInlineMark, value: (name: string) => string): string {
	switch (mark.kind) {
		case 'comment': return localize('paradis.word.mark.comment', "コメント");
		case 'textbox': return localize('paradis.word.mark.textbox', "テキストボックス");
		case 'noteReference': return value('noteKind') === 'endnote' ? paradisWordStoryLabel('endnote') : paradisWordStoryLabel('footnote');
		default: return paradisWordNodeKindLabel(mark.kind);
	}
}

function revisionKindLabel(kind: string): string {
	switch (kind) {
		case 'inserted': return localize('paradis.word.mark.revisionInserted', "挿入");
		case 'deleted': return localize('paradis.word.mark.revisionDeleted', "削除");
		case 'moveFrom': return localize('paradis.word.mark.revisionMoveFrom', "移動元");
		case 'moveTo': return localize('paradis.word.mark.revisionMoveTo', "移動先");
		case 'propertyChange': return localize('paradis.word.mark.revisionProperty', "書式の変更履歴");
		default: return kind;
	}
}

function markSummary(mark: IParadisWordInlineMark, value: (name: string) => string): string {
	switch (mark.kind) {
		case 'field': return value('instruction') || value('fieldKind');
		case 'contentControl': return value('alias') || value('tag');
		case 'revision': {
			const kind = revisionKindLabel(value('revisionKind'));
			const author = value('author');
			return author ? localize('paradis.word.mark.revisionBy', "{0}（{1}）", kind, author) : kind;
		}
		case 'comment': return [value('author'), value('text')].filter(text => !!text).join(' ');
		case 'hyperlink': return value('anchorName');
		case 'image': return value('targetPartUri');
		case 'noteReference': return value('noteId') ? localize('paradis.word.mark.note', "{0} {1}", markKindLabel(mark, value), value('noteId')) : '';
		case 'textbox': return value('shapeId');
	}
}

/**
 * 段落の中の印を、変更点パネルの「段落の情報」の 1 行にする。`storyKind` は印のある文書パーツ、`paragraphNumber` は
 * その文書パーツの中で何段落目か（1 から）。
 */
export function paradisWordMarkItem(id: number, mark: IParadisWordInlineMark, storyKind: ParadisWordStoryKind | undefined, paragraphNumber: number): ParadisWordMarkItem {
	const value = (name: string) => mark.rows.find(row => row[0] === name)?.[1] ?? '';
	const location = !storyKind || storyKind === 'body'
		? localize('paradis.word.mark.paragraph', "{0} 段落目", paragraphNumber)
		: localize('paradis.word.mark.storyParagraph', "{0}・{1} 段落目", paradisWordStoryLabel(storyKind), paragraphNumber);
	return { id, kind: markKindLabel(mark, value), summary: truncateParadisWordText(markSummary(mark, value), MARK_SUMMARY_LIMIT), location };
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

/** 一覧に出す短い説明。文字の変更なら変更後（無ければ変更前）の抜粋、それ以外は場所。 */
export function wordChangeSummary(change: ParadisOfficeChange): string {
	const text = wordChangeText(change);
	const author = paradisWordChangeRecordText(change.after, 'author');
	const detail = text ? truncateParadisWordText(text, 80) : change.subject.locator.replace(/^package:/, '');
	return author ? localize('paradis.word.changeSummaryAuthor', "{0}（{1}）", detail, author) : detail;
}

/** 解析の内訳（変更点パネルの下の節）に出す材料。 */
export interface ParadisWordInspectorAnalysis {
	readonly counts?: IParadisWordAnalysisCounts;
	/** 表示に関係しないので黙って外した部品（Q313 A）。一覧は上限の件数まで。 */
	readonly ignoredParts: readonly { readonly title: string; readonly detail?: string }[];
	/** 一覧に載せきれなかった、黙って外した部品の数。 */
	readonly ignoredOmitted?: number;
	/** 安全のために外したもの（マクロ・埋め込み・外部参照など）。一覧は上限の件数まで。 */
	readonly blockedParts?: readonly { readonly title: string; readonly detail?: string }[];
	readonly blockedOmitted?: number;
	/** 解析できなかったときの理由（利用者向けの文）。 */
	readonly failure?: string;
}

/** 描画用のパッケージから外した部品を、変更点パネルの一覧の項目にする。 */
export function paradisWordExclusionItems(exclusions: ParadisWordPackageExclusions): Pick<ParadisWordInspectorAnalysis, 'ignoredParts' | 'ignoredOmitted' | 'blockedParts' | 'blockedOmitted'> {
	return {
		ignoredParts: exclusions.ignored.map(part => ({ title: part.partName, detail: `${part.kind}: ${paradisWordIgnoredReasonLabel(part.reason)}` })),
		ignoredOmitted: exclusions.ignoredOmitted,
		blockedParts: exclusions.blocked.map(part => {
			const label = paradisWordBlockedFeatureLabel(part.feature);
			const title = part.partName ?? (part.scheme ? `${part.kind} (${part.scheme})` : part.kind);
			return { title, detail: part.count > 1 ? localize('paradis.word.blockedPartCount', "{0}・{1} 件", label, part.count) : label };
		}),
		blockedOmitted: exclusions.blockedOmitted,
	};
}

function appendKeyValue(parent: HTMLElement, key: string, value: string): void {
	const row = dom.append(parent, dom.$('.paradis-word-analysis-row'));
	const keyElement = dom.append(row, dom.$('span'));
	keyElement.textContent = key;
	const valueElement = dom.append(row, dom.$('span'));
	valueElement.textContent = value;
}

function appendButton(parent: HTMLElement, label: string, kind?: ParadisOfficeInspectorButtonKind): HTMLButtonElement {
	return appendParadisOfficeInspectorButton(parent, label, kind);
}

export class ParadisWordChangeInspector extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly root: HTMLElement;
	private changes: readonly ParadisOfficeChange[] = [];
	private placeholders: readonly ParadisOfficePlaceholder[] = [];
	private analysis: ParadisWordInspectorAnalysis | undefined;
	private truncatedChangeIds: ReadonlySet<string> = new Set();
	private results: readonly ParadisOfficeSearchResult[] = [];
	private completeness: ParadisOfficeCompletenessManifest | undefined;
	private outcome: ParadisOfficeOutcome = 'degraded';
	private printWarning: string | undefined;
	private printPlaceholderCount = 0;
	private announcement = '';
	private changePage = 0;
	private placeholderPage = 0;
	private markItems: readonly ParadisWordMarkItem[] = [];
	private markPage = 0;
	private resultPage = 0;
	private viewState: ParadisWordViewState = Object.freeze({ zoom: 1, displayMode: 'final', activeStory: 'all', categories: PARADIS_WORD_CHANGE_CATEGORIES });

	constructor(container: HTMLElement, private readonly options: ParadisWordChangeInspectorOptions = {}) {
		super();
		this.root = dom.append(container, dom.$('.paradis-word-change-inspector'));
		this.root.setAttribute('role', 'region');
		this.root.setAttribute('aria-label', localize('paradis.word.changeInspector', "Word の変更インスペクター"));
		this.render();
	}

	setComparison(changes: readonly ParadisOfficeChange[], completeness: ParadisOfficeCompletenessManifest, outcome: ParadisOfficeOutcome): void {
		this.changes = [...changes];
		this.changePage = 0;
		this.completeness = completeness;
		this.outcome = outcome;
		this.announcement = changes.length === 1
			? localize('paradis.word.changeCountOne', "1 件の変更")
			: localize('paradis.word.changeCountMany', "{0} 件の変更", changes.length);
		this.render();
	}

	setPlaceholders(placeholders: readonly ParadisOfficePlaceholder[]): void {
		this.placeholders = [...placeholders];
		this.placeholderPage = 0;
		this.render();
	}

	/** 「段落の情報」の一覧（本文の点線の印）。空なら節ごと出さない。 */
	setMarks(items: readonly ParadisWordMarkItem[]): void {
		this.markItems = [...items];
		this.markPage = 0;
		this.render();
	}

	/** 表示用に値を切り詰めた変更。一覧で「後半が変わっています」と添える。 */
	setTruncatedChanges(ids: Iterable<string>): void {
		this.truncatedChangeIds = new Set(ids);
		this.render();
	}

	/** 解析の内訳と、黙って外した部品の一覧を出す。undefined なら節ごと出さない。 */
	setAnalysis(analysis: ParadisWordInspectorAnalysis | undefined): void {
		this.analysis = analysis;
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
			? localize('paradis.word.searchResultOne', "1 件の検索結果")
			: localize('paradis.word.searchResultMany', "{0} 件の検索結果", this.results.length);
		this.render();
	}

	async requestPrintModel(): Promise<ParadisOfficePrintModel | undefined> {
		if (!this.options.getPrintModel) {
			return undefined;
		}
		const model = await this.options.getPrintModel();
		this.printWarning = wordPrintWarning(model);
		this.printPlaceholderCount = model.pages.reduce((count, page) => count + page.placeholders.length, 0);
		this.announcement = this.printWarning ?? localize('paradis.word.printReady', "印刷プレビューの準備ができました");
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
		this.options.onNavigate?.({ kind, locator, ...(anchor ? { anchor } : {}), ...(kind === 'change' && selectedChangeId ? { changeId: selectedChangeId } : {}) });
		this.render();
	}

	private appendPager(parent: HTMLElement, kind: 'changes' | 'placeholders' | 'marks' | 'results', total: number, page: number, setPage: (page: number) => void): void {
		const pageCount = Math.ceil(total / INSPECTOR_PAGE_SIZE);
		if (pageCount <= 1) {
			return;
		}
		const pager = dom.append(parent, dom.$('.paradis-word-inspector-pager'));
		pager.dataset.pageList = kind;
		pager.setAttribute('role', 'group');
		pager.setAttribute('aria-label', localize('paradis.word.pageNavigation', "{0} のページ移動", kind));
		const previous = appendButton(pager, localize('paradis.word.previousPage', "前へ"));
		previous.disabled = page === 0;
		const status = dom.append(pager, dom.$('span'));
		status.textContent = localize('paradis.word.pageStatus', "{1} ページ中 {0} ページ目", page + 1, pageCount);
		const next = appendButton(pager, localize('paradis.word.nextPage', "次へ"));
		next.disabled = page + 1 >= pageCount;
		this.renderDisposables.add(dom.addDisposableListener(previous, dom.EventType.CLICK, () => setPage(Math.max(0, page - 1))));
		this.renderDisposables.add(dom.addDisposableListener(next, dom.EventType.CLICK, () => setPage(Math.min(pageCount - 1, page + 1))));
	}

	private renderAnalysis(analysis: ParadisWordInspectorAnalysis): void {
		const section = dom.append(this.root, dom.$('.paradis-word-analysis'));
		section.setAttribute('role', 'group');
		section.setAttribute('aria-label', localize('paradis.word.analysis', "解析の内訳"));
		const heading = dom.append(section, dom.$('strong'));
		heading.textContent = localize('paradis.word.analysis', "解析の内訳");
		if (analysis.failure) {
			const failure = dom.append(section, dom.$('span.paradis-word-analysis-failure'));
			failure.setAttribute('role', 'status');
			failure.textContent = analysis.failure;
		}
		const counts = analysis.counts;
		if (counts) {
			const stories = dom.append(section, dom.$('.paradis-word-analysis-stories'));
			for (const [kind, count] of Object.entries(counts.storyKinds)) {
				appendKeyValue(stories, storyKindSet.has(kind as ParadisWordStoryKind) ? paradisWordStoryLabel(kind as ParadisWordStoryKind) : kind, String(count));
			}
			const nodes = dom.append(section, dom.$('.paradis-word-analysis-nodes'));
			for (const [kind, count] of Object.entries(counts.nodeKinds)) {
				if (kind !== 'unknownBlock') {
					appendKeyValue(nodes, paradisWordNodeKindLabel(kind), String(count));
				}
			}
			if (counts.unknownElements.length > 0) {
				const unknown = dom.append(section, dom.$('.paradis-word-analysis-unknown'));
				const title = dom.append(unknown, dom.$('span'));
				title.textContent = localize('paradis.word.analysis.unknown', "未知の要素の扱い");
				for (const element of counts.unknownElements) {
					appendKeyValue(unknown, element.name, element.disposition === 'ignorable'
						? localize('paradis.word.analysis.unknownIgnorable', "{0} 件・表示に関係しない", element.count)
						: localize('paradis.word.analysis.unknownUnrendered', "{0} 件・まだ描けない", element.count));
				}
				if (counts.unknownElementsOther.kinds > 0) {
					appendKeyValue(unknown, localize('paradis.word.analysis.unknownOtherKinds', "他 {0} 種", counts.unknownElementsOther.kinds), localize('paradis.word.analysis.unknownOtherCount', "{0} 件", counts.unknownElementsOther.count));
				}
			}
		}
		const appendPartList = (className: string, itemClassName: string, title: string, parts: readonly { readonly title: string; readonly detail?: string }[], omitted: number, warning: boolean) => {
			if (parts.length === 0 && omitted === 0) {
				return;
			}
			const list = dom.append(section, dom.$(`.${className}`));
			list.setAttribute('role', 'list');
			const heading = dom.append(list, dom.$('span'));
			heading.textContent = title;
			if (warning) {
				heading.classList.add('paradis-office-inspector-warning');
			}
			// 一覧の DOM は上限の件数までしか作らない（部品の数は文書しだいで大きくなる）。
			for (const part of parts) {
				const item = dom.append(list, dom.$(`.${itemClassName}`));
				item.setAttribute('role', 'listitem');
				item.textContent = part.detail ? `${part.title} — ${part.detail}` : part.title;
			}
			if (omitted > 0) {
				const more = dom.append(list, dom.$(`.${itemClassName}`));
				more.setAttribute('role', 'listitem');
				more.textContent = localize('paradis.word.partsOmitted', "他 {0} 件", omitted);
			}
		};
		const blockedParts = analysis.blockedParts ?? [];
		const blockedOmitted = analysis.blockedOmitted ?? 0;
		appendPartList('paradis-word-blocked-parts', 'paradis-word-blocked-part', localize('paradis.word.blockedParts', "安全のために外したもの {0}", blockedParts.length + blockedOmitted), blockedParts, blockedOmitted, true);
		const ignoredOmitted = analysis.ignoredOmitted ?? 0;
		appendPartList('paradis-word-ignored-parts', 'paradis-word-ignored-part', localize('paradis.word.ignoredParts', "無視した部品 {0}", analysis.ignoredParts.length + ignoredOmitted), analysis.ignoredParts, ignoredOmitted, false);
	}

	private render(): void {
		this.renderDisposables.clear();
		dom.clearNode(this.root);
		const document = this.root.ownerDocument;
		const close = appendParadisOfficePanelHead(this.root, localize('paradis.word.changes', "変更点"), !!this.options.onClose);
		if (close) {
			this.renderDisposables.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.options.onClose?.()));
		}

		const modes = dom.append(this.root, dom.$('.paradis-word-display-modes'));
		modes.setAttribute('role', 'toolbar');
		modes.setAttribute('aria-label', localize('paradis.word.displayModes', "変更履歴の表示"));
		for (const mode of displayModeSet) {
			const label = mode === 'final' ? localize('paradis.word.mode.final', "変更後")
				: mode === 'original' ? localize('paradis.word.mode.original', "変更前")
					: localize('paradis.word.mode.markup', "変更履歴付き");
			const button = appendButton(modes, label);
			button.dataset.wordMode = mode;
			button.setAttribute('aria-pressed', String(this.viewState.displayMode === mode));
			this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setDisplayMode(mode)));
		}

		const zoom = dom.append(this.root, dom.$('.paradis-word-inspector-zoom'));
		zoom.setAttribute('role', 'group');
		zoom.setAttribute('aria-label', localize('paradis.word.zoom', "表示倍率"));
		const zoomOut = appendButton(zoom, localize('paradis.word.zoomOut', "縮小"));
		zoomOut.dataset.wordZoom = 'out';
		const zoomStatus = dom.append(zoom, dom.$('span'));
		zoomStatus.textContent = `${Math.round(this.viewState.zoom * 100)}%`;
		const zoomIn = appendButton(zoom, localize('paradis.word.zoomIn', "拡大"));
		zoomIn.dataset.wordZoom = 'in';
		this.renderDisposables.add(dom.addDisposableListener(zoomOut, dom.EventType.CLICK, () => this.setZoom(Math.max(ZOOM_MIN, this.viewState.zoom / 1.2))));
		this.renderDisposables.add(dom.addDisposableListener(zoomIn, dom.EventType.CLICK, () => this.setZoom(Math.min(ZOOM_MAX, this.viewState.zoom * 1.2))));

		const categories = dom.append(this.root, dom.$('.paradis-word-change-categories'));
		categories.setAttribute('role', 'toolbar');
		categories.setAttribute('aria-label', localize('paradis.word.changeCategories', "変更の種類"));
		for (const category of PARADIS_WORD_CHANGE_CATEGORIES) {
			const count = this.changes.filter(change => change.category === category).length;
			const button = appendButton(categories, `${paradisWordChangeCategoryLabel(category)} ${count}`, 'chip');
			button.dataset.category = category;
			button.dataset.count = String(count);
			button.setAttribute('aria-pressed', String(this.viewState.categories.includes(category)));
			this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.updateCategories(category)));
		}

		const storyCounts = new Map<ParadisWordStoryKind | 'package', number>();
		for (const change of this.changes) {
			const story = paradisWordChangeStory(change);
			storyCounts.set(story.kind, (storyCounts.get(story.kind) ?? 0) + 1);
		}
		if (storyCounts.size > 0) {
			const stories = dom.append(this.root, dom.$('.paradis-word-story-counts'));
			stories.setAttribute('role', 'group');
			stories.setAttribute('aria-label', localize('paradis.word.stories', "文書パーツ"));
			for (const [kind, count] of storyCounts) {
				const filter = `kind:${kind}`;
				const button = appendButton(stories, `${paradisWordStoryLabel(kind)} ${count}`, 'chip');
				button.dataset.storyKind = kind;
				button.dataset.count = String(count);
				button.setAttribute('aria-pressed', String(this.viewState.activeStory === filter));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.updateStory(filter)));
			}
		}

		const changeList = dom.append(this.root, dom.$('.paradis-word-change-list'));
		changeList.setAttribute('role', 'list');
		const visibleChanges = this.changes.filter(change => {
			const story = paradisWordChangeStory(change);
			const storyVisible = this.viewState.activeStory === 'all' || this.viewState.activeStory === story.root || this.viewState.activeStory === `kind:${story.kind}`;
			return storyVisible && this.viewState.categories.includes(change.category);
		});
		const changeCount = dom.append(changeList, dom.$('span'));
		changeCount.textContent = visibleChanges.length === 1
			? localize('paradis.word.visibleChangeCountOne', "1 件の変更")
			: localize('paradis.word.visibleChangeCountMany', "{0} 件の変更", visibleChanges.length);
		if (visibleChanges.length === 0) {
			const empty = dom.append(changeList, dom.$('span'));
			empty.textContent = this.completeness && canShowWordNoChanges(this.completeness, this.outcome, this.changes.length)
				? localize('paradis.word.noChangesStrict', "変更なし")
				: localize('paradis.word.analysisIncomplete', "解析未完了");
		} else {
			const pageCount = Math.max(1, Math.ceil(visibleChanges.length / INSPECTOR_PAGE_SIZE));
			this.changePage = Math.min(this.changePage, pageCount - 1);
			for (const change of visibleChanges.slice(this.changePage * INSPECTOR_PAGE_SIZE, (this.changePage + 1) * INSPECTOR_PAGE_SIZE)) {
				const item = dom.append(changeList, dom.$('.paradis-word-change-item'));
				item.setAttribute('role', 'listitem');
				const label = wordChangeLabel(change);
				const summary = this.truncatedChangeIds.has(change.id)
					? localize('paradis.word.changeTruncated', "{0}（後半が変わっています）", wordChangeSummary(change))
					: wordChangeSummary(change);
				const button = appendButton(item, `${label} — ${summary}`, 'row');
				// 行は 1 行に切るので、全文と場所（locator）をホバーで出す。
				setParadisOfficeRowHover(button, `${label} — ${summary}\n${change.subject.locator}`, this.renderDisposables);
				button.dataset.changeId = change.id;
				button.setAttribute('aria-label', localize('paradis.word.navigateChange', "{1} の{0}へ移動", label, change.subject.locator));
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
			placeholderList.setAttribute('aria-label', localize('paradis.word.placeholders', "代替表示のコンテンツ"));
			const count = dom.append(placeholderList, dom.$('span'));
			count.textContent = localize('paradis.word.placeholderCount', "代替表示 {0} 件", this.placeholders.length);
			for (const placeholder of this.placeholders.slice(this.placeholderPage * INSPECTOR_PAGE_SIZE, (this.placeholderPage + 1) * INSPECTOR_PAGE_SIZE)) {
				const button = appendButton(placeholderList, placeholder.detail ? `${placeholder.title} — ${placeholder.detail}` : placeholder.title, 'row');
				setParadisOfficeRowHover(button, button.textContent ?? '', this.renderDisposables);
				button.dataset.placeholderId = placeholder.nodeId;
				button.setAttribute('aria-label', localize('paradis.word.navigatePlaceholder', "代替表示「{0}」へ移動", placeholder.title));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('placeholder', placeholder.nodeId)));
			}
			this.appendPager(placeholderList, 'placeholders', this.placeholders.length, this.placeholderPage, page => {
				this.placeholderPage = page;
				this.render();
			});
		}

		if (this.markItems.length > 0 && this.options.onOpenMark) {
			const onOpenMark = this.options.onOpenMark;
			const markList = dom.append(this.root, dom.$('.paradis-word-mark-list'));
			markList.setAttribute('role', 'list');
			markList.setAttribute('aria-label', localize('paradis.word.marks', "段落の情報"));
			const count = dom.append(markList, dom.$('span'));
			count.textContent = localize('paradis.word.markCount', "段落の情報（{0}）", this.markItems.length);
			const pageCount = Math.ceil(this.markItems.length / INSPECTOR_PAGE_SIZE);
			this.markPage = Math.min(this.markPage, pageCount - 1);
			for (const item of this.markItems.slice(this.markPage * INSPECTOR_PAGE_SIZE, (this.markPage + 1) * INSPECTOR_PAGE_SIZE)) {
				const text = item.summary ? localize('paradis.word.markSummaryLocation', "{0} ・ {1}", item.summary, item.location) : item.location;
				const row = dom.append(markList, dom.$('.paradis-word-mark-item'));
				row.setAttribute('role', 'listitem');
				const button = appendButton(row, '', 'row');
				dom.append(button, dom.$('span.paradis-word-mark-kind')).textContent = item.kind;
				button.append(text);
				setParadisOfficeRowHover(button, localize('paradis.word.markRowHover', "{0} {1}", item.kind, text), this.renderDisposables);
				button.dataset.markId = String(item.id);
				button.setAttribute('aria-label', localize('paradis.word.openMark', "{0} {1} の情報を開く", item.kind, text));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => onOpenMark(item.id)));
			}
			this.appendPager(markList, 'marks', this.markItems.length, this.markPage, page => {
				this.markPage = page;
				this.render();
			});
		}

		if (this.analysis) {
			this.renderAnalysis(this.analysis);
		}

		if (this.options.search) {
			const search = dom.append(this.root, dom.$('form.paradis-word-search')) as HTMLFormElement;
			search.setAttribute('role', 'search');
			const field = this.renderDisposables.add(new ParadisInputField(search, { ariaLabel: localize('paradis.word.search', "Word 文書を検索"), placeholder: localize('paradis.word.search', "Word 文書を検索"), icon: Codicon.search, small: true }));
			const input = field.inputElement;
			input.type = 'search';
			input.maxLength = MAX_STRING_LENGTH;
			const button = appendButton(search, localize('paradis.word.searchButton', "検索"));
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
				const button = appendButton(results, label, 'row');
				setParadisOfficeRowHover(button, label, this.renderDisposables);
				button.dataset.searchResultId = result.id;
				button.setAttribute('aria-label', localize('paradis.word.navigateSearchResult', "{0} 内の検索結果へ移動", result.locationBadge.label));
				this.renderDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.navigate('search', result.locator, result.navigableAnchor)));
			}
			this.appendPager(results, 'results', this.results.length, this.resultPage, page => {
				this.resultPage = page;
				this.render();
			});
		}

		if (this.options.getPrintModel) {
			const print = appendButton(this.root, localize('paradis.word.printPreview', "印刷プレビュー"));
			print.setAttribute('aria-label', localize('paradis.word.printPreview', "印刷プレビュー"));
			this.renderDisposables.add(dom.addDisposableListener(print, dom.EventType.CLICK, () => void this.requestPrintModel()));
		} else if (this.options.printUnavailable) {
			const unavailable = dom.append(this.root, dom.$('span.paradis-word-print-unavailable'));
			unavailable.setAttribute('role', 'status');
			unavailable.textContent = this.options.printUnavailable;
		}
		if (this.printWarning || this.printPlaceholderCount > 0) {
			const alert = dom.append(this.root, dom.$('.paradis-word-print-warning'));
			alert.setAttribute('role', 'alert');
			const placeholders = this.printPlaceholderCount === 1
				? localize('paradis.word.printPlaceholderOne', "代替表示 1 件")
				: localize('paradis.word.printPlaceholderMany', "代替表示 {0} 件", this.printPlaceholderCount);
			alert.textContent = [this.printWarning, this.printPlaceholderCount > 0 ? placeholders : undefined].filter((value): value is string => !!value).join(' ');
		}

		const live = document.createElement('span');
		live.className = 'paradis-word-change-live';
		live.setAttribute('aria-live', 'polite');
		live.setAttribute('aria-atomic', 'true');
		live.textContent = this.announcement;
		this.root.appendChild(live);
	}
}
