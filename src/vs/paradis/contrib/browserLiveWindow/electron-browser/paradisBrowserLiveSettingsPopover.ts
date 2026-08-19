/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, EventType, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	IParadisBrowserLiveViewState,
	PARADIS_BROWSER_LIVE_MAX_COLUMNS,
	PARADIS_BROWSER_LIVE_MIN_COLUMNS,
	ParadisBrowserLiveCadence,
	ParadisBrowserLiveGroup,
	ParadisBrowserLiveSort,
} from '../common/paradisBrowserLiveWindow.js';

const SORT_LABELS: Record<ParadisBrowserLiveSort, string> = {
	editor: localize('paradis.browserLive.sort.editor', "タブの並び"),
	title: localize('paradis.browserLive.sort.title', "タイトル順"),
	shared: localize('paradis.browserLive.sort.shared', "共有中を先頭"),
};

const GROUP_LABELS: Record<ParadisBrowserLiveGroup, string> = {
	space: localize('paradis.browserLive.group.space', "スペース"),
	none: localize('paradis.browserLive.group.none', "なし"),
};

const CADENCE_LABELS: Record<ParadisBrowserLiveCadence, string> = {
	off: localize('paradis.browserLive.cadence.off', "止める"),
	normal: localize('paradis.browserLive.cadence.normal', "ふつう"),
	smooth: localize('paradis.browserLive.cadence.smooth', "なめらか"),
};

/** ポップオーバーがウィンドウ下端との間に残す余白。 */
const BOTTOM_MARGIN = 12;
/** これ以上狭くするくらいならはみ出させる。 */
const MIN_HEIGHT = 120;

export interface IParadisBrowserLivePopoverHost {
	/** これを開いたボタン。ここへのクリックは「外側」に数えない (トグルとして働かせるため)。 */
	readonly anchor: HTMLElement;
	readonly commit: () => void;
	readonly close: (restoreFocus: boolean) => void;
}

/**
 * 歯車の中身。並び替え・まとめ方・表示をここへ畳む。
 *
 * ツールバーに出しっぱなしにすると、幅の狭いウィンドウでは折り返してタイルの面積を食う。
 * 列数のように「一覧から選びたい」ものはボタンを回すより並べたほうが早いので、
 * エージェント一覧と同じくポップオーバーへまとめている。
 */
export class ParadisBrowserLiveSettingsPopover extends Disposable {

	private readonly element: HTMLElement;
	private readonly sortButtons = new Map<ParadisBrowserLiveSort, HTMLElement>();
	private readonly groupButtons = new Map<ParadisBrowserLiveGroup, HTMLElement>();
	private readonly columnButtons = new Map<number, HTMLElement>();
	private readonly cadenceButtons = new Map<ParadisBrowserLiveCadence, HTMLElement>();

	constructor(
		private readonly container: HTMLElement,
		private readonly viewState: IParadisBrowserLiveViewState,
		private readonly host: IParadisBrowserLivePopoverHost,
	) {
		super();

		this.element = append(container, $('.paradis-browser-live-pop'));
		this.element.tabIndex = -1;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('paradis.browserLive.settings', "表示と並び"));
		this._register({ dispose: () => this.element.remove() });

		// --- 並び替え --------------------------------------------------------------------
		this.section(localize('paradis.browserLive.sortLabel', "並び替え"));
		const sortList = append(this.element, $('.paradis-browser-live-pop-list'));
		sortList.setAttribute('role', 'radiogroup');
		sortList.setAttribute('aria-label', localize('paradis.browserLive.sortLabel', "並び替え"));
		for (const sort of Object.keys(SORT_LABELS) as ParadisBrowserLiveSort[]) {
			const button = append(sortList, $('button.paradis-browser-live-pop-item'));
			button.setAttribute('role', 'radio');
			append(button, $('span.paradis-browser-live-pop-check.codicon.codicon-check'));
			append(button, $('span')).textContent = SORT_LABELS[sort];
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.viewState.sort = sort;
				this.host.commit();
			}));
			this.sortButtons.set(sort, button);
		}
		this.hintRow(localize('paradis.browserLive.sortHintActive', "どの並びでも、いま開いているスペースのページを先に置きます"));

		// --- まとめ方 --------------------------------------------------------------------
		this.separator();
		const groupRow = this.labelledRow(localize('paradis.browserLive.groupLabel', "まとめ方"));
		const groupSeg = this.segGroup(groupRow, localize('paradis.browserLive.groupLabel', "まとめ方"));
		for (const group of Object.keys(GROUP_LABELS) as ParadisBrowserLiveGroup[]) {
			this.groupButtons.set(group, this.segButton(groupSeg, GROUP_LABELS[group], () => {
				this.viewState.group = group;
				this.host.commit();
			}));
		}

		// --- 表示 ------------------------------------------------------------------------
		this.separator();
		this.section(localize('paradis.browserLive.displayLabel', "表示"));
		const columnsRow = this.labelledRow(localize('paradis.browserLive.columnsLabel', "列"));
		const columnsSeg = this.segGroup(columnsRow, localize('paradis.browserLive.columnsLabel', "列"));
		for (let columns = PARADIS_BROWSER_LIVE_MIN_COLUMNS; columns <= PARADIS_BROWSER_LIVE_MAX_COLUMNS; columns++) {
			this.columnButtons.set(columns, this.segButton(columnsSeg, String(columns), () => {
				this.viewState.columns = columns;
				this.host.commit();
			}));
		}

		const cadenceRow = this.labelledRow(localize('paradis.browserLive.cadenceLabel', "更新"));
		const cadenceSeg = this.segGroup(cadenceRow, localize('paradis.browserLive.cadenceLabel', "更新"));
		for (const cadence of Object.keys(CADENCE_LABELS) as ParadisBrowserLiveCadence[]) {
			this.cadenceButtons.set(cadence, this.segButton(cadenceSeg, CADENCE_LABELS[cadence], () => {
				this.viewState.cadence = cadence;
				this.host.commit();
			}));
		}
		this.hintRow(localize('paradis.browserLive.cadenceHint', "画面に出ていないページも追いかけます。上げるほどなめらかになりますが、そのぶん負荷も上がります"));

		// --- 開閉 ------------------------------------------------------------------------
		const targetWindow = getWindow(container);
		this._register(addDisposableListener(targetWindow.document, EventType.MOUSE_DOWN, event => {
			const target = event.target;
			// 要素でない target (テキストノード等) は「外側」として扱う。判定できないからと
			// 開いたままにすると、閉じ方が分からない状態になる。
			const inside = isHTMLElement(target) && (this.element.contains(target) || this.host.anchor.contains(target));
			if (!inside) {
				this.host.close(false);
			}
		}, true));
		this._register(addDisposableListener(targetWindow.document, EventType.KEY_DOWN, event => {
			if (new StandardKeyboardEvent(event).keyCode !== KeyCode.Escape) {
				return;
			}
			// フォーカスが外 (タイル等) にあるときまで歯車へ引き戻さない。
			const active = this.element.ownerDocument.activeElement;
			this.host.close(isHTMLElement(active) && this.element.contains(active));
		}));

		this.layout();
		this.update();
		this.element.focus();
	}

	/** 歯車の真下へ置き直す。ツールバーは折り返すので、開いたまま幅が変わっても付いていく。 */
	layout(): void {
		const anchorRect = this.host.anchor.getBoundingClientRect();
		const rootRect = this.container.getBoundingClientRect();
		const top = Math.round(anchorRect.bottom - rootRect.top + 4);
		this.element.style.top = `${top}px`;
		this.element.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.round(rootRect.height - top - BOTTOM_MARGIN))}px`;
	}

	/** 中身を現在のビュー状態に合わせる。開いたまま設定を変えても閉じないので、変更のたびに呼ばれる。 */
	update(): void {
		for (const [sort, button] of this.sortButtons) {
			this.mark(button, this.viewState.sort === sort);
		}
		for (const [group, button] of this.groupButtons) {
			this.mark(button, this.viewState.group === group);
		}
		for (const [columns, button] of this.columnButtons) {
			this.mark(button, this.viewState.columns === columns);
		}
		for (const [cadence, button] of this.cadenceButtons) {
			this.mark(button, this.viewState.cadence === cadence);
		}
	}

	/** 選択状態は見た目 (class) と読み上げ (aria-checked) の両方へ出す。 */
	private mark(button: HTMLElement, checked: boolean): void {
		button.classList.toggle('checked', checked);
		button.setAttribute('aria-checked', String(checked));
	}

	// ------------------------------------------------------------------ 部品

	private section(label: string): void {
		append(this.element, $('.paradis-browser-live-pop-head')).textContent = label;
	}

	private separator(): void {
		append(this.element, $('.paradis-browser-live-pop-sep'));
	}

	private labelledRow(label: string): HTMLElement {
		const row = append(this.element, $('.paradis-browser-live-pop-row'));
		append(row, $('span.paradis-browser-live-pop-key')).textContent = label;
		return row;
	}

	/** セグメントの入れ物。ラジオグループとして読み上げさせる。 */
	private segGroup(row: HTMLElement, label: string): HTMLElement {
		const group = append(row, $('.paradis-browser-live-pop-seg'));
		group.setAttribute('role', 'radiogroup');
		group.setAttribute('aria-label', label);
		return group;
	}

	private hintRow(text: string): void {
		append(this.element, $('.paradis-browser-live-pop-note')).textContent = text;
	}

	/** セグメントの1つ。ラベルがそのまま見えているので、同じ文字列のホバーは張らない。 */
	private segButton(parent: HTMLElement, label: string, run: () => void): HTMLElement {
		const button = append(parent, $('button'));
		button.setAttribute('role', 'radio');
		button.textContent = label;
		this._register(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}
}
