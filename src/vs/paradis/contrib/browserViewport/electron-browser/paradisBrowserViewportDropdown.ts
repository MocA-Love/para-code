/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 大きさの chip から開く一覧（Q451 のモック「chip を押したとき」）。
//
// 形とキーボード操作はプロファイルのドロップダウン（paradisBrowserProfileDropdown.ts）に揃えている:
//  - 共通の印 `paradis-overlay-popover` を付ける。これが無いと内蔵ブラウザのネイティブ WebContentsView の
//    裏に隠れる（overlayManager.ts に登録済みの印なので、upstream 側の追加の変更は要らない）
//  - ↑↓/Home/End で行を移り、Enter/Space で選び、Esc で閉じる。Tab は外へ逃がさない
//  - 自由入力の欄では、Tab で幅から高さへ、Enter で当てる
//  - 外側クリック・スクロール・ウィンドウの大きさの変化で閉じ、閉じたら chip へフォーカスを戻す

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ParadisPopoverRows, paradisWatchPopoverDismiss } from '../../../browser/paradisAnchoredPopover.js';
import {
	IParadisViewportSize,
	IParadisViewportState,
	PARADIS_VIEWPORT_MAX_DIMENSION,
	PARADIS_VIEWPORT_MIN_DIMENSION,
	paradisFormatViewportDimensions,
} from '../common/paradisBrowserViewport.js';

const $ = dom.$;

const DROPDOWN_WIDTH = 320;
const ANCHOR_GAP = 4;
const EDGE_MARGIN = 8;

/** 行に付ける既定の印。 */
export interface IParadisViewportDefaultMarks {
	readonly global: boolean;
	readonly space: boolean;
	/** 親（メインツリー）のスペースから引き継いだ既定。 */
	readonly parentSpace: boolean;
}

export interface IParadisBrowserViewportDropdownOptions {
	readonly anchor: HTMLElement;
	readonly current: IParadisViewportState;
	readonly sizes: readonly IParadisViewportSize[];
	/** エディタに合わせたときの大きさ（測れていれば）。 */
	readonly fitSize: { readonly width: number; readonly height: number } | undefined;
	readonly marksFor: (target: { readonly kind: 'fit' } | { readonly kind: 'size'; readonly size: IParadisViewportSize }) => IParadisViewportDefaultMarks;
	/** 今の大きさが全体の既定か・このスペースの既定か。 */
	readonly currentMarks: IParadisViewportDefaultMarks;
	/** このタブがスペースに属しているとき、そのスペースの名前。属していなければ undefined（スペースの既定を出さない）。 */
	readonly spaceLabel: string | undefined;
	/** upstream の Device Emulation の帯を出しているか。大きさを決めていないときは undefined（行を出さない）。 */
	readonly bandVisible: boolean | undefined;
	readonly onSelectSize: (size: IParadisViewportSize) => void;
	readonly onSelectFit: () => void;
	readonly onApplyDimensions: (width: number, height: number) => void;
	readonly onSaveCurrent: () => void;
	readonly onSetGlobalDefault: () => void;
	readonly onToggleSpaceDefault: () => void;
	readonly onToggleBand: () => void;
	readonly onManage: () => void;
}

interface IDropdownRow {
	readonly element: HTMLElement;
	readonly run: () => void;
	/** 行に入ったときにフォーカスを渡す先（自由入力の行の幅の欄）。 */
	readonly focusTarget?: HTMLElement;
}

export class ParadisBrowserViewportDropdown extends Disposable {

	private static _nextHeadingId = 0;

	private readonly _element: HTMLElement;
	private readonly _listElement: HTMLElement;
	private readonly _rows = new ParadisPopoverRows<IDropdownRow>();
	private readonly _container: HTMLElement;
	private _disposed = false;
	private _widthInput: HTMLInputElement | undefined;
	private _heightInput: HTMLInputElement | undefined;

	constructor(
		private readonly options: IParadisBrowserViewportDropdownOptions,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();

		// 開いたボタンのウィンドウに置く（補助ウィンドウのボタンから開いたとき、別の窓に出ないように）
		this._container = layoutService.getContainer(dom.getWindow(options.anchor));
		this._element = $('.paradis-browser-viewport-dropdown.paradis-focus-none.paradis-overlay-popover');
		this._element.tabIndex = -1;
		// listbox の中は option だけにする（見出しや入力欄が混ざると、読み上げの件数と位置がずれる。paradis-16-5）。
		// 見出し「保存した大きさ」は外側の区画（スクロールする箱）に置き、role="group" でつなぐ
		const savedGroup = dom.append(this._element, $('.pbv-list'));
		savedGroup.setAttribute('role', 'group');
		const savedHeading = this._appendSeparator(savedGroup, localize('paradis.browserViewport.dropdown.saved', "保存した大きさ"));
		savedGroup.setAttribute('aria-labelledby', savedHeading.id);
		this._listElement = dom.append(savedGroup, $('.pbv-options'));
		this._listElement.setAttribute('role', 'listbox');
		this._listElement.setAttribute('aria-label', localize('paradis.browserViewport.dropdown.label', "ページの大きさ"));

		this._renderSizes();
		this._renderCustom();
		this._renderActions();

		this._container.appendChild(this._element);
		this.options.anchor.setAttribute('aria-expanded', 'true');

		this._layout();
		this._registerListeners();
		this._rows.focusInitial();
	}

	// #region 描画

	private _renderSizes(): void {
		const current = this.options.current;
		for (const size of this.options.sizes) {
			const selected = !current.fit && current.name === size.name;
			const detail = size.mobile
				? localize('paradis.browserViewport.dropdown.mobileDetail', "{0}・モバイル", paradisFormatViewportDimensions(size.width, size.height))
				: paradisFormatViewportDimensions(size.width, size.height);
			this._appendOptionRow({
				selected,
				icon: size.mobile ? Codicon.deviceMobile : Codicon.vm,
				label: size.name,
				detail,
				marks: this.options.marksFor({ kind: 'size', size }),
				run: () => this.options.onSelectSize(size),
			});
		}
		const fit = this.options.fitSize;
		this._appendOptionRow({
			selected: current.fit,
			icon: Codicon.screenFull,
			label: localize('paradis.browserViewport.dropdown.fit', "エディタに合わせる"),
			detail: fit
				? localize('paradis.browserViewport.dropdown.fitDetail', "自動 {0}", paradisFormatViewportDimensions(fit.width, fit.height))
				: localize('paradis.browserViewport.dropdown.fitDetailUnknown', "自動"),
			marks: this.options.marksFor({ kind: 'fit' }),
			run: () => this.options.onSelectFit(),
		});
	}

	private _renderCustom(): void {
		// 自由入力は listbox の外の区画に置く（paradis-16-5 案 A）。キーボードの移動は今までどおり行の一つとして回る
		const section = dom.append(this._element, $('.pbv-section'));
		section.setAttribute('role', 'group');
		const heading = this._appendSeparator(section, localize('paradis.browserViewport.dropdown.custom', "自由に入力"));
		section.setAttribute('aria-labelledby', heading.id);
		const element = dom.append(section, $('.pbv-row.paradis-focus-none.pbv-custom'));
		// 入力できる範囲は読み上げにも渡す（paradis-16-21）。画面には出さない
		const range = dom.append(section, $('span'));
		range.id = `${heading.id}-range`;
		range.hidden = true;
		range.textContent = localize('paradis.browserViewport.dropdown.range', "{0}〜{1} の数", PARADIS_VIEWPORT_MIN_DIMENSION, PARADIS_VIEWPORT_MAX_DIMENSION);
		const current = this.options.current;
		const width = this._appendNumberInput(element, localize('paradis.browserViewport.dropdown.width', "幅"), current.width, range.id);
		dom.append(element, $('span.pbv-times')).textContent = '×';
		const height = this._appendNumberInput(element, localize('paradis.browserViewport.dropdown.height', "高さ"), current.height, range.id);
		const apply = dom.append(element, $('button.pbv-apply')) as HTMLButtonElement;
		apply.textContent = localize('paradis.browserViewport.dropdown.apply', "適用");
		apply.tabIndex = -1;
		this._widthInput = width;
		this._heightInput = height;
		const run = () => this._applyCustom();
		this._register(dom.addDisposableListener(apply, dom.EventType.MOUSE_DOWN, event => event.preventDefault()));
		this._register(dom.addDisposableListener(apply, dom.EventType.CLICK, () => run()));
		const index = this._rows.add({ element, run, focusTarget: width });
		for (const input of [width, height]) {
			this._register(dom.addDisposableListener(input, dom.EventType.FOCUS, () => this._rows.focus(index, false)));
		}
	}

	private _appendNumberInput(parent: HTMLElement, label: string, value: number | undefined, describedBy: string): HTMLInputElement {
		const input = dom.append(parent, $('input.pbv-number')) as HTMLInputElement;
		input.type = 'number';
		input.inputMode = 'numeric';
		input.min = String(PARADIS_VIEWPORT_MIN_DIMENSION);
		input.max = String(PARADIS_VIEWPORT_MAX_DIMENSION);
		input.tabIndex = -1;
		input.setAttribute('aria-label', label);
		input.setAttribute('aria-describedby', describedBy);
		input.placeholder = label;
		if (value) {
			input.value = String(value);
		}
		return input;
	}

	private _applyCustom(): void {
		const width = Math.round(Number(this._widthInput?.value));
		const height = Math.round(Number(this._heightInput?.value));
		const valid = (value: number) => Number.isFinite(value) && value >= PARADIS_VIEWPORT_MIN_DIMENSION && value <= PARADIS_VIEWPORT_MAX_DIMENSION;
		for (const [input, value] of [[this._widthInput, width], [this._heightInput, height]] as const) {
			input?.classList.toggle('is-invalid', !valid(value));
			if (valid(value)) {
				input?.removeAttribute('aria-invalid');
			} else {
				input?.setAttribute('aria-invalid', 'true');
			}
		}
		if (valid(width) && valid(height)) {
			this.options.onApplyDimensions(width, height);
		}
	}

	private _renderActions(): void {
		// 操作の行は listbox の外に置く（選ぶ対象ではないので option にしない）。キーボードの移動だけ行と同じ扱い
		const footer = dom.append(this._element, $('.pbv-footer'));
		this._appendActionRow(footer, Codicon.save, localize('paradis.browserViewport.dropdown.saveCurrent', "今の大きさに名前を付けて保存…"), () => this.options.onSaveCurrent());
		const marks = this.options.currentMarks;
		this._appendActionRow(footer, Codicon.globe, marks.global
			? localize('paradis.browserViewport.dropdown.globalDefaultDone', "全体の既定です")
			: localize('paradis.browserViewport.dropdown.setGlobalDefault', "既定にする: 全体"), () => this.options.onSetGlobalDefault(), marks.global);
		if (this.options.spaceLabel !== undefined) {
			const space = this.options.spaceLabel || localize('paradis.browserViewport.dropdown.thisSpace', "このスペース");
			this._appendActionRow(footer, Codicon.folder, marks.space
				? localize('paradis.browserViewport.dropdown.unsetSpaceDefault', "このスペース（{0}）の既定から外す", space)
				: localize('paradis.browserViewport.dropdown.setSpaceDefault', "既定にする: このスペース（{0}）", space), () => this.options.onToggleSpaceDefault(), marks.space);
		}
		if (this.options.bandVisible !== undefined) {
			this._appendActionRow(footer, Codicon.settings, this.options.bandVisible
				? localize('paradis.browserViewport.dropdown.hideBand', "細かい設定の帯を隠す")
				: localize('paradis.browserViewport.dropdown.showBand', "細かい設定の帯を表示（DPR・倍率・User Agent）"), () => this.options.onToggleBand(), this.options.bandVisible);
		}
		this._appendActionRow(footer, Codicon.listUnordered, localize('paradis.browserViewport.dropdown.manage', "大きさの管理…"), () => this.options.onManage());
	}

	private _appendSeparator(parent: HTMLElement, text: string): HTMLElement {
		const separator = dom.append(parent, $('.pbv-separator'));
		separator.id = `paradis-browser-viewport-heading-${ParadisBrowserViewportDropdown._nextHeadingId++}`;
		separator.textContent = text;
		return separator;
	}

	private _appendOptionRow(descriptor: {
		readonly selected: boolean;
		readonly icon: ThemeIcon;
		readonly label: string;
		readonly detail: string;
		readonly marks: IParadisViewportDefaultMarks;
		readonly run: () => void;
	}): void {
		const element = dom.append(this._listElement, $('.pbv-row.paradis-focus-none'));
		element.classList.toggle('is-selected', descriptor.selected);
		element.setAttribute('role', 'option');
		element.setAttribute('aria-selected', String(descriptor.selected));
		this._prepareRow(element, descriptor.run);

		dom.append(element, $(`.pbv-check${descriptor.selected ? ThemeIcon.asCSSSelector(Codicon.check) : ''}`));
		dom.append(element, $(`.pbv-icon${ThemeIcon.asCSSSelector(descriptor.icon)}`));
		dom.append(element, $('.pbv-label')).textContent = descriptor.label;
		const badges: string[] = [];
		if (descriptor.marks.global) {
			badges.push(localize('paradis.browserViewport.dropdown.badgeGlobal', "既定"));
		}
		if (descriptor.marks.space) {
			badges.push(localize('paradis.browserViewport.dropdown.badgeSpace', "このスペース"));
		} else if (descriptor.marks.parentSpace) {
			badges.push(localize('paradis.browserViewport.dropdown.badgeParentSpace', "メインツリー"));
		}
		for (const badge of badges) {
			dom.append(element, $('.pbv-badge')).textContent = badge;
		}
		dom.append(element, $('.pbv-detail')).textContent = descriptor.detail;
		element.setAttribute('aria-label', [descriptor.label, descriptor.detail, ...badges].join('、'));
	}

	private _appendActionRow(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void, checked?: boolean): void {
		const element = dom.append(parent, $('button.pbv-row.paradis-focus-none.pbv-action'));
		this._prepareRow(element, run);
		dom.append(element, $(`.pbv-check${checked ? ThemeIcon.asCSSSelector(Codicon.check) : ''}`));
		dom.append(element, $(`.pbv-icon${ThemeIcon.asCSSSelector(icon)}`));
		dom.append(element, $('.pbv-label')).textContent = label;
	}

	private _prepareRow(element: HTMLElement, run: () => void): void {
		element.tabIndex = -1;
		const index = this._rows.add({ element, run });
		this._register(dom.addDisposableListener(element, dom.EventType.MOUSE_DOWN, event => event.preventDefault()));
		this._register(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
		this._register(dom.addDisposableListener(element, dom.EventType.MOUSE_OVER, () => this._rows.focus(index, false)));
	}

	// #endregion

	// #region 位置・イベント

	private _layout(): void {
		const containerPosition = dom.getDomNodePagePosition(this._container);
		const anchorPosition = dom.getDomNodePagePosition(this.options.anchor);

		const availableWidth = Math.max(0, containerPosition.width - EDGE_MARGIN * 2);
		const width = Math.min(DROPDOWN_WIDTH, availableWidth);
		this._element.style.width = `${width}px`;

		const anchorTop = anchorPosition.top - containerPosition.top;
		const anchorBottom = anchorTop + anchorPosition.height;
		const spaceBelow = containerPosition.height - anchorBottom - ANCHOR_GAP - EDGE_MARGIN;
		const spaceAbove = anchorTop - ANCHOR_GAP - EDGE_MARGIN;
		const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
		this._element.style.maxHeight = `${Math.max(120, flipUp ? spaceAbove : spaceBelow)}px`;

		const height = this._element.offsetHeight;
		const top = flipUp
			? Math.max(EDGE_MARGIN, anchorTop - ANCHOR_GAP - height)
			: Math.min(anchorBottom + ANCHOR_GAP, Math.max(EDGE_MARGIN, containerPosition.height - EDGE_MARGIN - height));

		// chip の右端に揃える（chip はアドレスバーの右寄りにあるので、左揃えだと右へはみ出しやすい）
		const anchorRight = anchorPosition.left - containerPosition.left + anchorPosition.width;
		const left = Math.min(
			Math.max(EDGE_MARGIN, anchorRight - width),
			Math.max(EDGE_MARGIN, containerPosition.width - width - EDGE_MARGIN),
		);

		this._element.style.top = `${Math.round(top)}px`;
		this._element.style.left = `${Math.round(left)}px`;
	}

	private _registerListeners(): void {
		const targetWindow = dom.getWindow(this._container);

		this._register(dom.addDisposableListener(this._element, dom.EventType.KEY_DOWN, event => this._onKeyDown(event)));

		// 自分の一覧のスクロールでは閉じない（開いた直後の scrollIntoView でも発火するため。paradisAnchoredPopover.ts）
		this._register(paradisWatchPopoverDismiss(targetWindow, { element: this._element, anchor: this.options.anchor, close: () => this.close(), closeOnScroll: true, closeOnResize: true, closeOnBlur: true }));
	}

	private _onKeyDown(event: KeyboardEvent): void {
		const keyboardEvent = new StandardKeyboardEvent(event);
		const inInput = event.target === this._widthInput || event.target === this._heightInput;
		// 自由入力の欄の中では、Home・End・Space は欄の中の操作。Tab は幅 → 高さ → 次の行の順に移る
		if (inInput && (keyboardEvent.keyCode === KeyCode.Home || keyboardEvent.keyCode === KeyCode.End || keyboardEvent.keyCode === KeyCode.Space)) {
			return;
		}
		if (keyboardEvent.keyCode === KeyCode.Tab) {
			if (event.target === this._widthInput && !keyboardEvent.shiftKey) {
				keyboardEvent.preventDefault();
				this._heightInput?.focus();
				return;
			}
			if (event.target === this._heightInput && keyboardEvent.shiftKey) {
				keyboardEvent.preventDefault();
				this._widthInput?.focus();
				return;
			}
		}
		this._rows.handleKeyDown(keyboardEvent, () => this.close());
	}

	// #endregion

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this.options.anchor.setAttribute('aria-expanded', 'false');
		if (this.options.anchor.isConnected && dom.isAncestorOfActiveElement(this._element)) {
			this.options.anchor.focus();
		}
		this._element.remove();
		super.dispose();
	}
}
