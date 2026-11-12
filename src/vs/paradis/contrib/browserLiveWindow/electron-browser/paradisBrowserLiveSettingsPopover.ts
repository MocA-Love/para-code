/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, clearNode, EventType, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { paradisWatchPopoverDismiss } from '../../../browser/paradisAnchoredPopover.js';
import { showParadisPopover } from '../../../browser/paradisPopover.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
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
	space: localize('paradis.browserLive.sort.space', "スペース名順"),
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
/** 小窓の幅（UI キットのポップアップ。列の 6 つの切り替えが 1 行に収まる幅）。 */
const POPOVER_WIDTH = 320;
/** キットの小窓の、ボタンとの間の余白（paradisPopover.css の margin-top）。 */
const ANCHOR_GAP = 4;
/** これ以上狭くするくらいならはみ出させる。 */
const MIN_HEIGHT = 120;

export interface IParadisBrowserLivePopoverHost {
	/** これを開いたボタン。ここへのクリックは「外側」に数えない (トグルとして働かせるため)。 */
	readonly anchor: HTMLElement;
	/** スペースの状態キー → 表示名。一覧に出ているページのぶんだけ。 */
	readonly spaces: () => Map<string, string>;
	/** いま一覧から外しているページの数。 */
	readonly hiddenCount: () => number;
	readonly commit: () => void;
	readonly close: (restoreFocus: boolean) => void;
}

/**
 * 歯車の中身。並び替え・まとめ方・表示をここへ畳む。
 *
 * ツールバーに出しっぱなしにすると、幅の狭いウィンドウでは折り返してタイルの面積を食う。
 * 列数のように「一覧から選びたい」ものはボタンを回すより並べたほうが早いので、
 * エージェント一覧と同じくポップオーバーへまとめている。
 *
 * 面・角丸・影・重なりの段は UI キットのポップアップ（paradisPopover.ts、context view の段）に任せる（paradis-18-15）。
 * まとめ方・列・更新は UI キットの切り替えの組（paradisSegmented.ts、aria-pressed）にする（paradis-18-9）。
 */
export class ParadisBrowserLiveSettingsPopover extends Disposable {

	/** 小窓の本文（キットのポップアップの本文へ入れる）。 */
	private readonly element: HTMLElement;
	/** キットのポップアップの箱。開いている間だけある。 */
	private box: HTMLElement | undefined;
	private readonly popup: IDisposable;
	/** 自分で閉じている最中か（閉じた知らせで host.close を呼び返さないため）。 */
	private disposing = false;
	private readonly sortButtons = new Map<ParadisBrowserLiveSort, HTMLElement>();
	private readonly groupSeg: ParadisSegmented<ParadisBrowserLiveGroup>;
	private readonly columnsSeg: ParadisSegmented<string>;
	private readonly cadenceSeg: ParadisSegmented<ParadisBrowserLiveCadence>;
	private readonly spaceButtons = new Map<string, HTMLElement>();
	private readonly spaceList: HTMLElement;
	private readonly hiddenText: HTMLElement;
	private readonly restoreHiddenButton: HTMLElement;
	private allSpacesButton: HTMLElement | undefined;
	/** スペース一覧は開いている間も作り直しうるので、その分の購読だけ別に持つ。 */
	private readonly spaceDisposables = this._register(new DisposableStore());
	/** 前回組み立てたときの顔ぶれ。同じなら作り直さない (選択中のスクロール位置を保つ)。 */
	private spaceKeys: string[] = [];

	/**
	 * @param container 一覧のウィンドウの作業領域（補助ウィンドウの container）。キットの小窓をここへ出す。
	 */
	constructor(
		private readonly container: HTMLElement,
		private readonly viewState: IParadisBrowserLiveViewState,
		private readonly host: IParadisBrowserLivePopoverHost,
		private readonly contextViewService: IContextViewService,
	) {
		super();

		this.element = $('.paradis-browser-live-pop');

		// --- 並び替え --------------------------------------------------------------------
		this.section(localize('paradis.browserLive.sortLabel', "並び替え"));
		const sortList = append(this.element, $('.paradis-browser-live-pop-list'));
		sortList.setAttribute('role', 'group');
		sortList.setAttribute('aria-label', localize('paradis.browserLive.sortLabel', "並び替え"));
		for (const sort of Object.keys(SORT_LABELS) as ParadisBrowserLiveSort[]) {
			const button = append(sortList, $<HTMLButtonElement>('button.paradis-browser-live-pop-item.paradis-focus-ring-inset'));
			button.type = 'button';
			append(button, $('span.paradis-browser-live-pop-check.codicon.codicon-check'));
			append(button, $('span')).textContent = SORT_LABELS[sort];
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.viewState.sort = sort;
				this.host.commit();
			}));
			this.sortButtons.set(sort, button);
		}
		this.hintRow(localize('paradis.browserLive.sortHintActive', "どの並びでも、いま開いているスペースのページを先に置きます"));

		// --- スペース --------------------------------------------------------------------
		this.separator();
		this.section(localize('paradis.browserLive.spacesLabel', "スペース"));
		this.spaceList = append(this.element, $('.paradis-browser-live-pop-list.scrollable'));
		this.spaceList.setAttribute('role', 'group');
		this.spaceList.setAttribute('aria-label', localize('paradis.browserLive.spacesLabel', "スペース"));

		// --- 非表示 ----------------------------------------------------------------------
		this.separator();
		const hiddenRow = append(this.element, $('.paradis-browser-live-pop-row'));
		this.hiddenText = append(hiddenRow, $('span.paradis-browser-live-pop-key'));
		this.restoreHiddenButton = append(hiddenRow, $('button.paradis-browser-live-chip.paradis-focus-ring-inset'));
		this.restoreHiddenButton.textContent = localize('paradis.browserLive.restoreHidden', "すべて戻す");
		this._register(addDisposableListener(this.restoreHiddenButton, EventType.CLICK, () => {
			this.viewState.hidden = [];
			this.host.commit();
		}));

		// --- まとめ方 --------------------------------------------------------------------
		this.separator();
		const groupRow = this.labelledRow(localize('paradis.browserLive.groupLabel', "まとめ方"));
		this.groupSeg = this._register(new ParadisSegmented(groupRow, {
			items: (Object.keys(GROUP_LABELS) as ParadisBrowserLiveGroup[]).map(group => ({ value: group, label: GROUP_LABELS[group] })),
			value: this.viewState.group,
			ariaLabel: localize('paradis.browserLive.groupLabel', "まとめ方"),
		}));
		this._register(this.groupSeg.onDidChange(group => {
			this.viewState.group = group;
			this.host.commit();
		}));

		// --- 表示 ------------------------------------------------------------------------
		this.separator();
		this.section(localize('paradis.browserLive.displayLabel', "表示"));
		const columnsRow = this.labelledRow(localize('paradis.browserLive.columnsLabel', "列"));
		const columnItems: { value: string; label: string }[] = [];
		for (let columns = PARADIS_BROWSER_LIVE_MIN_COLUMNS; columns <= PARADIS_BROWSER_LIVE_MAX_COLUMNS; columns++) {
			columnItems.push({ value: String(columns), label: String(columns) });
		}
		this.columnsSeg = this._register(new ParadisSegmented(columnsRow, {
			items: columnItems,
			value: String(this.viewState.columns),
			ariaLabel: localize('paradis.browserLive.columnsLabel', "列"),
		}));
		this._register(this.columnsSeg.onDidChange(columns => {
			this.viewState.columns = Number(columns);
			this.host.commit();
		}));

		const cadenceRow = this.labelledRow(localize('paradis.browserLive.cadenceLabel', "更新"));
		this.cadenceSeg = this._register(new ParadisSegmented(cadenceRow, {
			items: (Object.keys(CADENCE_LABELS) as ParadisBrowserLiveCadence[]).map(cadence => ({ value: cadence, label: CADENCE_LABELS[cadence] })),
			value: this.viewState.cadence,
			ariaLabel: localize('paradis.browserLive.cadenceLabel', "更新"),
		}));
		this._register(this.cadenceSeg.onDidChange(cadence => {
			this.viewState.cadence = cadence;
			this.host.commit();
		}));
		this.hintRow(localize('paradis.browserLive.cadenceHint', "画面に出ていないページも追いかけます。上げるほどなめらかになりますが、そのぶん負荷も上がります"));

		// --- 開閉 ------------------------------------------------------------------------
		this.update();
		const targetWindow = getWindow(container);
		this.popup = showParadisPopover(this.contextViewService, {
			anchor: this.host.anchor,
			title: localize('paradis.browserLive.settings', "表示と並び"),
			container,
			render: (body, store) => {
				const box = this.box = body.parentElement ?? body;
				box.classList.add('paradis-browser-live-pop-box');
				box.style.width = `${POPOVER_WIDTH}px`;
				body.appendChild(this.element);
				this.layout();
				// ContextView は作業領域の中の押下では閉じないので、外側の押下で閉じる（歯車の押し直しは開き直しの操作なので内側）。
				// 押下の target は要素なので、要素かどうかは見ずに contains() だけで判定する（paradisAnchoredPopover.ts）
				store.add(paradisWatchPopoverDismiss(targetWindow, { element: box, anchor: this.host.anchor, close: () => this.host.close(false), listenOnDocument: true }));
				store.add({ dispose: () => { this.box = undefined; } });
			},
			onHide: () => {
				// Esc で閉じたときのフォーカスの戻し先（歯車）はキットが戻す
				if (!this.disposing) {
					this.host.close(false);
				}
			},
		});
		// 小窓の中の Esc はキットが受ける。フォーカスが外 (タイル等) にあるときの Esc でも閉じるが、歯車へは引き戻さない。
		this._register(addDisposableListener(targetWindow.document, EventType.KEY_DOWN, event => {
			if (new StandardKeyboardEvent(event).keyCode !== KeyCode.Escape) {
				return;
			}
			const active = targetWindow.document.activeElement;
			this.host.close(isHTMLElement(active) && !!this.box?.contains(active));
		}));
	}

	override dispose(): void {
		this.disposing = true;
		this.popup.dispose();
		super.dispose();
	}

	/** 歯車の下に収まる高さへ合わせる。ツールバーは折り返すので、開いたまま幅が変わっても付いていく。 */
	layout(): void {
		if (!this.box) {
			return;
		}
		const anchorRect = this.host.anchor.getBoundingClientRect();
		const rootRect = this.container.getBoundingClientRect();
		const top = Math.round(anchorRect.bottom - rootRect.top + ANCHOR_GAP);
		this.box.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.round(rootRect.height - top - BOTTOM_MARGIN))}px`;
		this.contextViewService.layout();
	}

	/** 中身を現在のビュー状態に合わせる。開いたまま設定を変えても閉じないので、変更のたびに呼ばれる。 */
	update(): void {
		for (const [sort, button] of this.sortButtons) {
			button.classList.toggle('checked', this.viewState.sort === sort);
			button.setAttribute('aria-pressed', String(this.viewState.sort === sort));
		}
		this.groupSeg.value = this.viewState.group;
		this.columnsSeg.value = String(this.viewState.columns);
		this.cadenceSeg.value = this.viewState.cadence;
		this.updateSpaces();
		const hidden = this.host.hiddenCount();
		this.hiddenText.textContent = hidden > 0
			? localize('paradis.browserLive.hiddenCount', "非表示 {0} 件", hidden)
			: localize('paradis.browserLive.hiddenNone', "非表示なし");
		this.restoreHiddenButton.classList.toggle('hidden', hidden === 0);
	}

	/**
	 * スペース一覧を現在の状態に合わせる。顔ぶれが変わっていなければチェックの付け替えだけで
	 * 済ませる —— ページのタイトルが変わるたびに再描画が走るので、毎回組み立て直すと
	 * 一覧のスクロール位置が戻り、キーボードで選んでいる最中はフォーカスまで失われる。
	 */
	private updateSpaces(): void {
		const options = this.host.spaces();
		const keys = [...options.keys()];
		if (keys.length !== this.spaceKeys.length || keys.some((key, index) => key !== this.spaceKeys[index])) {
			this.buildSpaces(options);
			this.spaceKeys = keys;
		}
		const selected = this.viewState.spaces;
		for (const [key, button] of this.spaceButtons) {
			this.mark(button, selected === undefined || selected.includes(key));
		}
		if (this.allSpacesButton) {
			this.mark(this.allSpacesButton, selected === undefined);
		}
	}

	private buildSpaces(options: Map<string, string>): void {
		this.spaceDisposables.clear();
		this.spaceButtons.clear();
		clearNode(this.spaceList);
		for (const [key, label] of options) {
			const button = append(this.spaceList, $('button.paradis-browser-live-pop-item.paradis-focus-ring-inset'));
			button.setAttribute('role', 'checkbox');
			append(button, $('span.paradis-browser-live-pop-check.codicon.codicon-check'));
			append(button, $('span')).textContent = label;
			this.spaceDisposables.add(addDisposableListener(button, EventType.CLICK, () => {
				// 選択中の集合はクリック時点のものを読む (組み立て時の値を掴むと古くなる)。
				const selected = this.viewState.spaces;
				const current = selected === undefined ? [...options.keys()] : [...selected];
				const index = current.indexOf(key);
				if (index >= 0) {
					current.splice(index, 1);
				} else {
					current.push(key);
				}
				// 全部外した / 全部入れた場合は「すべて」に戻す (空の一覧を見せない)。
				this.viewState.spaces = current.length === 0 || current.length === options.size ? undefined : current;
				this.host.commit();
			}));
			this.spaceButtons.set(key, button);
		}
		const all = append(this.spaceList, $('button.paradis-browser-live-pop-item.paradis-focus-ring-inset'));
		all.setAttribute('role', 'checkbox');
		append(all, $('span.paradis-browser-live-pop-check.codicon.codicon-check'));
		append(all, $('span')).textContent = localize('paradis.browserLive.selectAllSpaces', "すべてのスペース");
		this.spaceDisposables.add(addDisposableListener(all, EventType.CLICK, () => {
			this.viewState.spaces = undefined;
			this.host.commit();
		}));
		this.allSpacesButton = all;
	}

	/** スペースの選択状態は見た目 (class) と読み上げ (aria-checked) の両方へ出す。 */
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

	private hintRow(text: string): void {
		append(this.element, $('.paradis-browser-live-pop-note')).textContent = text;
	}
}
