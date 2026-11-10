/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { getBaseLayerHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate2.js';
import type { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import './media/paradisOfficeFindWidget.css';
import type { ParadisOfficeSearchResult } from '../common/paradisOfficeProtocol.js';
import { PARADIS_OFFICE_SEARCH_PAGE_SIZE, PARADIS_OFFICE_SEARCH_RESULT_LIMIT, type ParadisOfficeSearchPage } from '../common/paradisOfficeSearch.js';

const MAXIMUM_QUERY_LENGTH = 4_096;

/** 変更点のパネルの横に小窓を並べられる幅（これより狭いとパネルの下へずらす）。 */
const SIDE_BY_SIDE_MIN_WIDTH = 760;
/** 小窓とパネルのあいだ（px）。 */
const OBSTACLE_GAP = 8;

export type ParadisOfficeFindSearchProvider = (query: { readonly text: string; readonly matchCase: boolean }, cursor: string | undefined, token: CancellationToken) => Promise<ParadisOfficeSearchPage>;

export interface ParadisOfficeFindWidgetOptions {
	readonly search?: ParadisOfficeFindSearchProvider;
	readonly unavailableMessage?: string;
	readonly onNavigate?: (result: ParadisOfficeSearchResult) => void;
	/** Covers forwarded OverlayWebview key events whose target lives outside the editor root. */
	readonly isActive?: () => boolean;
}

/**
 * Shared script-free Office find surface. Navigation is delegated as a typed logical result only.
 * 形は本家のエディタの検索の小窓（findWidget.css）のまま、部品は UI キットにする: ポップアップの面（角丸 8・影）に、
 * キットの入力欄（28、中に「大文字と小文字を区別」）、件数、キットのアイコンのボタン（24）の ↑↓ と閉じる。
 */
export class ParadisOfficeFindWidget extends Disposable {
	private readonly element: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly matchCaseButton: HTMLButtonElement;
	private matchCase = false;
	private readonly previousButton: HTMLButtonElement;
	private readonly nextButton: HTMLButtonElement;
	private readonly closeButton: HTMLButtonElement;
	private readonly statusElement: HTMLElement;
	private readonly currentElement: HTMLElement;
	private readonly statusHover: IManagedHover;
	private readonly request = this._register(new MutableDisposable<CancellationTokenSource>());
	private searchProvider: ParadisOfficeFindSearchProvider | undefined;
	private unavailableMessage: string | undefined;
	private readonly onNavigate: ((result: ParadisOfficeSearchResult) => void) | undefined;
	private readonly isActive: (() => boolean) | undefined;
	private results: readonly ParadisOfficeSearchResult[] = Object.freeze([]);
	private currentIndex = -1;
	private nextCursor: string | undefined;
	private total = 0;
	private capped = false;
	private generation = 0;
	private visible = false;
	private restoreFocus: HTMLElement | undefined;

	constructor(parent: HTMLElement, options: ParadisOfficeFindWidgetOptions) {
		super();
		this.searchProvider = options.search;
		this.unavailableMessage = options.unavailableMessage;
		this.onNavigate = options.onNavigate;
		this.isActive = options.isActive;

		const document = parent.ownerDocument;
		this.element = document.createElement('div');
		this.element.className = 'paradis-office-find-widget';
		this.element.setAttribute('role', 'search');
		this.element.setAttribute('aria-label', localize('paradis.office.findWidget', "Office 文書内を検索"));
		this.element.setAttribute('aria-hidden', 'true');
		this.element.style.display = 'none';

		const field = this._register(new ParadisInputField(this.element, {
			ariaLabel: localize('paradis.office.findInput', "検索"),
			placeholder: localize('paradis.office.findPlaceholder', "検索"),
			small: true,
		}));
		field.element.classList.add('paradis-office-find-input');
		this.input = field.inputElement;
		this.input.type = 'search';
		this.input.maxLength = MAXIMUM_QUERY_LENGTH;

		this.matchCaseButton = this.appendButton(document, Codicon.caseSensitive, localize('paradis.office.findMatchCase', "大文字と小文字を区別"), field.element);
		this.matchCaseButton.setAttribute('aria-pressed', 'false');

		this.statusElement = document.createElement('span');
		this.statusElement.className = 'paradis-office-find-status';
		this.statusElement.setAttribute('role', 'status');
		this.statusElement.setAttribute('aria-live', 'polite');
		this.statusElement.setAttribute('aria-atomic', 'true');
		this.element.appendChild(this.statusElement);

		// ツールチップは本家と同じ管理されたホバーで出す（ネイティブの title は使わない）。
		this.statusHover = this._register(getBaseLayerHoverDelegate().setupManagedHover(getDefaultHoverDelegate('mouse'), this.statusElement, ''));

		this.previousButton = this.appendButton(document, Codicon.arrowUp, localize('paradis.office.findPrevious', "前の一致"));
		this.nextButton = this.appendButton(document, Codicon.arrowDown, localize('paradis.office.findNext', "次の一致"));
		this.closeButton = this.appendButton(document, Codicon.close, localize('paradis.office.findClose', "閉じる"));

		// 一致した場所（シート名・前後の文）は本家の小窓に無い 2 行目になるので、画面には出さず、
		// 件数のツールチップに出す。要素は DOM に残す（見えないだけで、読み上げの順に入る）。
		this.currentElement = document.createElement('span');
		this.currentElement.className = 'paradis-office-find-current';
		this.element.appendChild(this.currentElement);
		parent.appendChild(this.element);

		const eventWindow = document.defaultView;
		if (eventWindow) {
			this._register(dom.addDisposableListener(eventWindow, dom.EventType.KEY_DOWN, event => {
				const target = event.target;
				const insideRoot = target instanceof eventWindow.Node && parent.contains(target);
				if (insideRoot || this.isActive?.()) {
					this.handleKeyDown(event);
				}
			}));
		}
		this._register(dom.addDisposableListener(this.input, dom.EventType.INPUT, () => void this.beginSearch()));
		this._register(dom.addDisposableListener(this.matchCaseButton, dom.EventType.CLICK, () => {
			this.matchCase = !this.matchCase;
			this.matchCaseButton.classList.toggle('checked', this.matchCase);
			this.matchCaseButton.setAttribute('aria-pressed', String(this.matchCase));
			void this.beginSearch();
		}));
		this._register(dom.addDisposableListener(this.previousButton, dom.EventType.CLICK, () => void this.findPrevious()));
		this._register(dom.addDisposableListener(this.nextButton, dom.EventType.CLICK, () => void this.findNext()));
		this._register(dom.addDisposableListener(this.closeButton, dom.EventType.CLICK, () => this.hide()));
		this.updateAvailability();
		this.updateResultPresentation();
	}

	/**
	 * `obstacle`（変更点のパネル）が出ているあいだ、小窓をそれに重ねない。広い窓ではパネルの左へ、狭い窓では
	 * パネルの下へずらす。パネルは小窓と同じ親に置いた絶対配置の要素で、出し入れ（display）と大きさの変化を
	 * ResizeObserver で追う（小窓を捨てるときに一緒に外す）。
	 */
	avoidOverlapWith(obstacle: HTMLElement): void {
		const parent = this.element.parentElement;
		const view = this.element.ownerDocument.defaultView;
		if (!parent || !view) {
			return;
		}
		const place = () => {
			const shown = obstacle.isConnected && obstacle.getClientRects().length > 0;
			if (!shown) {
				this.element.style.right = '';
				this.element.style.top = '';
				this.element.style.maxWidth = '';
				return;
			}
			if (parent.clientWidth >= SIDE_BY_SIDE_MIN_WIDTH) {
				// 横に置くときは、パネルの左に残る幅に収める（入力欄が縮む）。
				this.element.style.right = `${parent.clientWidth - obstacle.offsetLeft + OBSTACLE_GAP}px`;
				this.element.style.maxWidth = `${Math.max(0, obstacle.offsetLeft - 2 * OBSTACLE_GAP)}px`;
				this.element.style.top = '';
			} else {
				this.element.style.right = '';
				this.element.style.maxWidth = '';
				this.element.style.top = `${obstacle.offsetTop + obstacle.offsetHeight + OBSTACLE_GAP}px`;
			}
		};
		const observer = new view.ResizeObserver(() => place());
		observer.observe(obstacle);
		observer.observe(parent);
		place();
		this._register(toDisposable(() => observer.disconnect()));
	}

	/** Updates the source-specific callback without adding a transport or retaining old source results. */
	setSearchProvider(search: ParadisOfficeFindSearchProvider | undefined, unavailableMessage?: string): void {
		this.cancelSearch();
		this.searchProvider = search;
		this.unavailableMessage = unavailableMessage;
		this.resetResults();
		this.updateAvailability();
		if (this.visible && !search) {
			this.statusElement.textContent = unavailableMessage ?? localize('paradis.office.findUnavailable', "この文書では検索を利用できません。");
		}
	}

	reveal(initialInput?: string): void {
		const activeElement = this.element.ownerDocument.activeElement;
		if (!this.visible && dom.isHTMLElement(activeElement) && !this.element.contains(activeElement)) {
			this.restoreFocus = activeElement;
		}
		this.visible = true;
		this.element.style.display = 'flex';
		this.element.setAttribute('aria-hidden', 'false');
		if (initialInput !== undefined) {
			this.input.value = initialInput.slice(0, MAXIMUM_QUERY_LENGTH);
			void this.beginSearch();
		}
		if (!this.searchProvider) {
			this.statusElement.textContent = this.unavailableMessage ?? localize('paradis.office.findUnavailable', "この文書では検索を利用できません。");
		}
		if (this.searchProvider) {
			this.input.focus();
			this.input.select();
		} else {
			this.closeButton.focus();
		}
	}

	hide(): void {
		if (!this.visible) {
			return;
		}
		this.cancelSearch();
		this.visible = false;
		this.element.style.display = 'none';
		this.element.setAttribute('aria-hidden', 'true');
		const restoreFocus = this.restoreFocus;
		this.restoreFocus = undefined;
		if (restoreFocus?.isConnected) {
			restoreFocus.focus();
		}
	}

	isVisible(): boolean {
		return this.visible;
	}

	/**
	 * 表示中で検索語が入っていれば、同じ条件で検索し直す（中身や並びが変わったとき用）。
	 * `navigate: false` のときは結果と件数だけを更新し、先頭の一致へは移動しない（再読込で表示位置を動かさない）。
	 */
	refresh(options: { readonly navigate?: boolean } = {}): void {
		if (this.visible && this.searchProvider && this.input.value.trim()) {
			void this.beginSearch(options.navigate ?? true);
		}
	}

	async findNext(): Promise<void> {
		if (this.results.length === 0) {
			return;
		}
		if (this.currentIndex + 1 < this.results.length) {
			this.currentIndex++;
		} else if (this.nextCursor) {
			const previousLength = this.results.length;
			if (!await this.loadNextPage()) {
				return;
			}
			this.currentIndex = previousLength < this.results.length ? previousLength : 0;
		} else {
			this.currentIndex = 0;
		}
		this.navigateCurrent();
	}

	async findPrevious(): Promise<void> {
		if (this.results.length === 0) {
			return;
		}
		if (this.currentIndex > 0) {
			this.currentIndex--;
		} else {
			while (this.nextCursor && this.results.length < PARADIS_OFFICE_SEARCH_RESULT_LIMIT) {
				if (!await this.loadNextPage()) {
					return;
				}
			}
			this.currentIndex = this.results.length - 1;
		}
		this.navigateCurrent();
	}

	private async beginSearch(navigate = true): Promise<void> {
		this.cancelSearch();
		const generation = ++this.generation;
		this.resetResults();
		const provider = this.searchProvider;
		const query = this.input.value.normalize('NFC').trim();
		if (!provider) {
			this.statusElement.textContent = this.unavailableMessage ?? localize('paradis.office.findUnavailable', "この文書では検索を利用できません。");
			return;
		}
		if (!query) {
			this.statusElement.textContent = '';
			return;
		}
		const request = new CancellationTokenSource();
		this.request.value = request;
		this.statusElement.textContent = localize('paradis.office.findSearching', "検索中…");
		try {
			const page = await provider({ text: query, matchCase: this.matchCase }, undefined, request.token);
			if (generation !== this.generation || request.token.isCancellationRequested) {
				return;
			}
			this.acceptPage(page, false);
			if (this.results.length > 0 && navigate) {
				this.currentIndex = 0;
				this.navigateCurrent();
			} else {
				this.updateResultPresentation();
			}
		} catch (error) {
			if (generation === this.generation && !isCancellationError(error)) {
				this.resetResults();
				this.statusElement.textContent = localize('paradis.office.findFailed', "検索できませんでした。");
			}
		}
	}

	private async loadNextPage(): Promise<boolean> {
		const provider = this.searchProvider;
		const cursor = this.nextCursor;
		const request = this.request.value;
		if (!provider || !cursor || !request || request.token.isCancellationRequested) {
			return false;
		}
		const generation = this.generation;
		try {
			const page = await provider({ text: this.input.value.normalize('NFC').trim(), matchCase: this.matchCase }, cursor, request.token);
			if (generation !== this.generation || request.token.isCancellationRequested) {
				return false;
			}
			this.acceptPage(page, true);
			return true;
		} catch (error) {
			if (generation === this.generation && !isCancellationError(error)) {
				this.statusElement.textContent = localize('paradis.office.findFailed', "検索できませんでした。");
			}
			return false;
		}
	}

	private acceptPage(page: ParadisOfficeSearchPage, append: boolean): void {
		if (!page || !Array.isArray(page.results) || page.results.length > PARADIS_OFFICE_SEARCH_PAGE_SIZE
			|| !Number.isSafeInteger(page.total) || page.total < 0 || page.total > PARADIS_OFFICE_SEARCH_RESULT_LIMIT
			|| typeof page.capped !== 'boolean'
			|| (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0 || page.nextCursor.length > MAXIMUM_QUERY_LENGTH))) {
			throw new Error('Invalid Office search page');
		}
		const combined = append ? [...this.results, ...page.results] : [...page.results];
		if (combined.length > PARADIS_OFFICE_SEARCH_RESULT_LIMIT || combined.length > page.total
			|| (append && (page.total !== this.total || page.capped !== this.capped))
			|| (page.nextCursor !== undefined && combined.length >= page.total)) {
			throw new Error('Invalid Office search page');
		}
		this.results = Object.freeze(combined);
		this.nextCursor = page.nextCursor;
		this.total = page.total;
		this.capped = page.capped;
	}

	private navigateCurrent(): void {
		const result = this.results[this.currentIndex];
		if (!result) {
			this.updateResultPresentation();
			return;
		}
		this.updateResultPresentation();
		this.onNavigate?.(result);
	}

	private updateResultPresentation(): void {
		const result = this.results[this.currentIndex];
		this.statusHover.update('');
		this.statusElement.classList.remove('none');
		if (!result && this.results.length > 0) {
			// 一致はあるが、まだどれにも移動していない（`refresh({ navigate: false })` の後）。
			this.currentElement.textContent = '';
			this.statusElement.textContent = localize('paradis.office.findCount', "{0} 件", this.capped ? `${this.total}+` : String(this.total));
			this.previousButton.disabled = false;
			this.nextButton.disabled = false;
			return;
		}
		if (!result) {
			this.currentElement.textContent = '';
			if (this.input.value && this.searchProvider) {
				this.statusElement.textContent = localize('paradis.office.findNoResults', "見つかりません");
				this.statusElement.classList.add('none');
			}
			this.previousButton.disabled = true;
			this.nextButton.disabled = true;
			return;
		}
		const visibleTotal = this.capped ? `${this.total}+` : String(this.total);
		this.statusElement.textContent = localize('paradis.office.findPosition', "{1} 件中 {0} 件目", this.currentIndex + 1, visibleTotal);
		this.currentElement.textContent = `${result.locationBadge.label}: ${result.preview.before}${result.preview.match}${result.preview.after}`;
		this.statusHover.update(this.currentElement.textContent);
		this.previousButton.disabled = false;
		this.nextButton.disabled = false;
	}

	private updateAvailability(): void {
		const available = this.searchProvider !== undefined;
		this.input.disabled = !available;
		this.matchCaseButton.disabled = !available;
		if (!available) {
			this.previousButton.disabled = true;
			this.nextButton.disabled = true;
		}
	}

	private resetResults(): void {
		this.results = Object.freeze([]);
		this.currentIndex = -1;
		this.nextCursor = undefined;
		this.total = 0;
		this.capped = false;
		this.currentElement.textContent = '';
		this.statusHover.update('');
		this.previousButton.disabled = true;
		this.nextButton.disabled = true;
	}

	private cancelSearch(): void {
		this.request.value?.cancel();
		this.request.clear();
		this.generation++;
	}

	private handleKeyDown(event: KeyboardEvent): void {
		const keyboardEvent = new StandardKeyboardEvent(event);
		if (keyboardEvent.equals(KeyMod.CtrlCmd | KeyCode.KeyF) || (event.key.toLocaleLowerCase() === 'f' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey)) {
			this.reveal();
			keyboardEvent.preventDefault();
			keyboardEvent.stopPropagation();
			return;
		}
		if (!this.visible) {
			return;
		}
		if (keyboardEvent.equals(KeyCode.Escape) || event.key === 'Escape') {
			this.hide();
			keyboardEvent.preventDefault();
			keyboardEvent.stopPropagation();
			return;
		}
		if ((keyboardEvent.equals(KeyCode.Enter) || event.key === 'Enter') && this.element.contains(event.target as Node)) {
			void (event.shiftKey ? this.findPrevious() : this.findNext());
			keyboardEvent.preventDefault();
			keyboardEvent.stopPropagation();
			return;
		}
		if (keyboardEvent.equals(KeyCode.F3) || keyboardEvent.equals(KeyMod.Shift | KeyCode.F3) || event.key === 'F3') {
			void (event.shiftKey ? this.findPrevious() : this.findNext());
			keyboardEvent.preventDefault();
			keyboardEvent.stopPropagation();
		}
	}

	/** キットのアイコンのボタン（24）。フォーカスの枠は小窓の中で欠けないよう内側に描く。 */
	private appendButton(document: Document, icon: ThemeIcon, label: string, parent: HTMLElement = this.element): HTMLButtonElement {
		const result = document.createElement('button');
		result.type = 'button';
		result.classList.add('paradis-office-find-button', ...paradisButtonClasses('icon', true).filter(name => name !== 'paradis-focus-ring'), 'paradis-focus-ring-inset', ...ThemeIcon.asClassNameArray(icon));
		result.setAttribute('aria-label', label);
		parent.appendChild(result);
		this._register(getBaseLayerHoverDelegate().setupManagedHover(getDefaultHoverDelegate('mouse'), result, label));
		return result;
	}

	override dispose(): void {
		this.cancelSearch();
		this.element.remove();
		super.dispose();
	}
}
