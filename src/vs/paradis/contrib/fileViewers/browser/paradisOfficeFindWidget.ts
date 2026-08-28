/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { ParadisOfficeSearchResult } from '../common/paradisOfficeProtocol.js';
import { PARADIS_OFFICE_SEARCH_PAGE_SIZE, PARADIS_OFFICE_SEARCH_RESULT_LIMIT, type ParadisOfficeSearchPage } from '../common/paradisOfficeSearch.js';

const MAXIMUM_QUERY_LENGTH = 4_096;

export type ParadisOfficeFindSearchProvider = (query: { readonly text: string; readonly matchCase: boolean }, cursor: string | undefined, token: CancellationToken) => Promise<ParadisOfficeSearchPage>;

export interface ParadisOfficeFindWidgetOptions {
	readonly search?: ParadisOfficeFindSearchProvider;
	readonly unavailableMessage?: string;
	readonly onNavigate?: (result: ParadisOfficeSearchResult) => void;
	/** Covers forwarded OverlayWebview key events whose target lives outside the editor root. */
	readonly isActive?: () => boolean;
}

/** Shared script-free Office find surface. Navigation is delegated as a typed logical result only. */
export class ParadisOfficeFindWidget extends Disposable {
	private readonly element: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly matchCaseButton: HTMLButtonElement;
	private readonly previousButton: HTMLButtonElement;
	private readonly nextButton: HTMLButtonElement;
	private readonly closeButton: HTMLButtonElement;
	private readonly statusElement: HTMLElement;
	private readonly currentElement: HTMLElement;
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
		this.element.setAttribute('aria-label', localize('paradis.office.findWidget', "Find in Office Document"));
		this.element.setAttribute('aria-hidden', 'true');
		this.element.style.position = 'absolute';
		this.element.style.inset = '8px 8px auto auto';
		this.element.style.zIndex = '40';
		this.element.style.display = 'none';
		this.element.style.flexWrap = 'wrap';
		this.element.style.alignItems = 'center';
		this.element.style.gap = '4px';
		this.element.style.maxWidth = 'min(560px, calc(100% - 16px))';
		this.element.style.padding = '6px';
		this.element.style.border = '1px solid var(--vscode-widget-border, transparent)';
		this.element.style.borderRadius = '4px';
		this.element.style.background = 'var(--vscode-editorWidget-background)';
		this.element.style.color = 'var(--vscode-editorWidget-foreground)';
		this.element.style.boxShadow = '0 2px 8px var(--vscode-widget-shadow)';

		this.input = document.createElement('input');
		this.input.type = 'search';
		this.input.maxLength = MAXIMUM_QUERY_LENGTH;
		this.input.placeholder = localize('paradis.office.findPlaceholder', "Find");
		this.input.setAttribute('aria-label', localize('paradis.office.findInput', "Find"));
		this.input.style.minWidth = '180px';
		this.input.style.background = 'var(--vscode-input-background)';
		this.input.style.color = 'var(--vscode-input-foreground)';
		this.input.style.border = '1px solid var(--vscode-input-border, transparent)';
		this.element.appendChild(this.input);

		this.matchCaseButton = button(document, 'Aa', localize('paradis.office.findMatchCase', "Match Case"));
		this.matchCaseButton.setAttribute('aria-pressed', 'false');
		this.element.appendChild(this.matchCaseButton);
		this.previousButton = button(document, '↑', localize('paradis.office.findPrevious', "Previous Match"));
		this.element.appendChild(this.previousButton);
		this.nextButton = button(document, '↓', localize('paradis.office.findNext', "Next Match"));
		this.element.appendChild(this.nextButton);
		this.closeButton = button(document, '×', localize('paradis.office.findClose', "Close"));
		this.element.appendChild(this.closeButton);

		this.statusElement = document.createElement('span');
		this.statusElement.className = 'paradis-office-find-status';
		this.statusElement.setAttribute('role', 'status');
		this.statusElement.setAttribute('aria-live', 'polite');
		this.statusElement.setAttribute('aria-atomic', 'true');
		this.element.appendChild(this.statusElement);
		this.currentElement = document.createElement('span');
		this.currentElement.className = 'paradis-office-find-current';
		this.currentElement.style.flexBasis = '100%';
		this.currentElement.style.overflow = 'hidden';
		this.currentElement.style.textOverflow = 'ellipsis';
		this.currentElement.style.whiteSpace = 'nowrap';
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
			const pressed = this.matchCaseButton.getAttribute('aria-pressed') !== 'true';
			this.matchCaseButton.setAttribute('aria-pressed', String(pressed));
			void this.beginSearch();
		}));
		this._register(dom.addDisposableListener(this.previousButton, dom.EventType.CLICK, () => void this.findPrevious()));
		this._register(dom.addDisposableListener(this.nextButton, dom.EventType.CLICK, () => void this.findNext()));
		this._register(dom.addDisposableListener(this.closeButton, dom.EventType.CLICK, () => this.hide()));
		this.updateAvailability();
		this.updateResultPresentation();
	}

	/** Updates the source-specific callback without adding a transport or retaining old source results. */
	setSearchProvider(search: ParadisOfficeFindSearchProvider | undefined, unavailableMessage?: string): void {
		this.cancelSearch();
		this.searchProvider = search;
		this.unavailableMessage = unavailableMessage;
		this.resetResults();
		this.updateAvailability();
		if (this.visible && !search) {
			this.statusElement.textContent = unavailableMessage ?? localize('paradis.office.findUnavailable', "Search is unavailable.");
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
			this.statusElement.textContent = this.unavailableMessage ?? localize('paradis.office.findUnavailable', "Search is unavailable.");
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

	private async beginSearch(): Promise<void> {
		this.cancelSearch();
		const generation = ++this.generation;
		this.resetResults();
		const provider = this.searchProvider;
		const query = this.input.value.normalize('NFC').trim();
		if (!provider) {
			this.statusElement.textContent = this.unavailableMessage ?? localize('paradis.office.findUnavailable', "Search is unavailable.");
			return;
		}
		if (!query) {
			this.statusElement.textContent = '';
			return;
		}
		const request = new CancellationTokenSource();
		this.request.value = request;
		this.statusElement.textContent = localize('paradis.office.findSearching', "Searching…");
		try {
			const page = await provider({ text: query, matchCase: this.matchCaseButton.getAttribute('aria-pressed') === 'true' }, undefined, request.token);
			if (generation !== this.generation || request.token.isCancellationRequested) {
				return;
			}
			this.acceptPage(page, false);
			if (this.results.length > 0) {
				this.currentIndex = 0;
				this.navigateCurrent();
			} else {
				this.updateResultPresentation();
			}
		} catch (error) {
			if (generation === this.generation && !isCancellationError(error)) {
				this.resetResults();
				this.statusElement.textContent = localize('paradis.office.findFailed', "Search is unavailable.");
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
			const page = await provider({ text: this.input.value.normalize('NFC').trim(), matchCase: this.matchCaseButton.getAttribute('aria-pressed') === 'true' }, cursor, request.token);
			if (generation !== this.generation || request.token.isCancellationRequested) {
				return false;
			}
			this.acceptPage(page, true);
			return true;
		} catch (error) {
			if (generation === this.generation && !isCancellationError(error)) {
				this.statusElement.textContent = localize('paradis.office.findFailed', "Search is unavailable.");
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
		if (!result) {
			this.currentElement.textContent = '';
			if (this.input.value && this.searchProvider) {
				this.statusElement.textContent = localize('paradis.office.findNoResults', "No Results");
			}
			this.previousButton.disabled = true;
			this.nextButton.disabled = true;
			return;
		}
		const visibleTotal = this.capped ? `${this.total}+` : String(this.total);
		this.statusElement.textContent = localize('paradis.office.findPosition', "{0} of {1}", this.currentIndex + 1, visibleTotal);
		this.currentElement.textContent = `${result.locationBadge.label}: ${result.preview.before}${result.preview.match}${result.preview.after}`;
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

	override dispose(): void {
		this.cancelSearch();
		this.element.remove();
		super.dispose();
	}
}

function button(document: Document, text: string, label: string): HTMLButtonElement {
	const result = document.createElement('button');
	result.type = 'button';
	result.textContent = text;
	result.setAttribute('aria-label', label);
	result.title = label;
	return result;
}
