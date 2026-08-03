/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import {
	IParadisAgentLiveViewState,
	PARADIS_AGENT_LIVE_MAX_COLUMNS,
	PARADIS_AGENT_LIVE_MAX_FONT_SIZE,
	PARADIS_AGENT_LIVE_MAX_ROW_HEIGHT,
	PARADIS_AGENT_LIVE_MIN_COLUMNS,
	PARADIS_AGENT_LIVE_MIN_FONT_SIZE,
	PARADIS_AGENT_LIVE_MIN_ROW_HEIGHT,
	ParadisAgentLiveGroup,
	ParadisAgentLiveSort,
	paradisClampAgentLiveFontSize,
	paradisClampAgentLiveRowHeight,
} from '../common/paradisAgentLiveWindow.js';

const SORT_LABELS: Record<ParadisAgentLiveSort, string> = {
	attention: localize('paradis.agentLive.sort.attention', "要対応 → 経過時間の長い順"),
	status: localize('paradis.agentLive.sort.status', "状態順"),
	elapsed: localize('paradis.agentLive.sort.elapsed', "経過時間が長い順"),
	updated: localize('paradis.agentLive.sort.updated', "最後に動いた順"),
	space: localize('paradis.agentLive.sort.space', "スペース名順"),
	manual: localize('paradis.agentLive.sort.manual', "手動（ドラッグで並べ替え）"),
};

const GROUP_LABELS: Record<ParadisAgentLiveGroup, string> = {
	none: localize('paradis.agentLive.group.none', "なし"),
	space: localize('paradis.agentLive.group.space', "スペース"),
	status: localize('paradis.agentLive.group.status', "状態"),
};

/** ポップオーバーがウィンドウ下端との間に残す余白 */
const BOTTOM_MARGIN = 12;
/** これ以上狭くするくらいならはみ出させる */
const MIN_HEIGHT = 120;

export interface IParadisAgentLivePopoverHost {
	/** これを開いたボタン。ここへのクリックは「外側」に数えない (トグルとして働かせるため) */
	readonly anchor: HTMLElement;
	/** スペースの状態キー → 表示名 */
	readonly spaces: () => Map<string, string>;
	/** 「いま何桁見えるか」を測るための、画面に出ているミラー。無ければ undefined */
	readonly visibleCells: () => { readonly cols: number; readonly rows: number; readonly totalCols: number; readonly totalRows: number } | undefined;
	readonly commit: () => void;
	readonly close: (restoreFocus: boolean) => void;
	readonly reset: () => void;
}

/**
 * 歯車の中身。並び替え・スペース・表示の設定をまとめて持つ。
 *
 * コンテキストメニューではなく自前のポップオーバーにしているのは、文字サイズとタイルの高さを
 * 数値で直接打てるようにするため (メニューでは決め打ちの選択肢しか出せない)。
 */
export class ParadisAgentLiveSettingsPopover extends Disposable {

	private readonly element: HTMLElement;
	private readonly sortButtons = new Map<ParadisAgentLiveSort, HTMLElement>();
	private readonly groupButtons = new Map<ParadisAgentLiveGroup, HTMLElement>();
	private readonly columnButtons = new Map<number, HTMLElement>();
	private readonly fillButtons = new Map<boolean, HTMLElement>();
	private readonly spaceButtons = new Map<string, HTMLElement>();
	private readonly spaceList: HTMLElement;
	private readonly rowHeightInput: HTMLInputElement;
	private readonly fontSizeInput: HTMLInputElement;
	private readonly fitCheckbox: HTMLInputElement;
	private readonly hint: HTMLElement;
	private readonly directionButton: HTMLElement;
	private readonly pinTopCheckbox: HTMLInputElement;
	private allSpacesButton: HTMLElement | undefined;

	/** スペース一覧は開いている間も作り直しうるので、その分のリスナーだけ別に持つ */
	private readonly spaceDisposables = this._register(new DisposableStore());
	/** 前回スペース一覧を組み立てたときの顔ぶれ。同じなら作り直さない */
	private spaceKeys: string[] = [];

	constructor(
		private readonly container: HTMLElement,
		private readonly viewState: IParadisAgentLiveViewState,
		private readonly host: IParadisAgentLivePopoverHost,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.element = append(container, $('.paradis-agent-live-pop'));
		this.element.tabIndex = -1;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('paradis.agentLive.settings', "表示と並び"));
		this._register({ dispose: () => this.element.remove() });

		// --- 並び替え --------------------------------------------------------------------
		this.section(localize('paradis.agentLive.sortLabel', "並び替え"));
		const sortList = append(this.element, $('.paradis-agent-live-pop-list'));
		for (const sort of Object.keys(SORT_LABELS) as ParadisAgentLiveSort[]) {
			const button = append(sortList, $('button.paradis-agent-live-pop-item'));
			append(button, $('span.paradis-agent-live-pop-check.codicon.codicon-check'));
			append(button, $('span')).textContent = SORT_LABELS[sort];
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.viewState.sort = sort;
				this.host.commit();
			}));
			this.sortButtons.set(sort, button);
		}
		const directionRow = append(this.element, $('.paradis-agent-live-pop-row'));
		this.directionButton = append(directionRow, $('button.paradis-agent-live-chip'));
		this._register(addDisposableListener(this.directionButton, EventType.CLICK, () => {
			this.viewState.sortDesc = !this.viewState.sortDesc;
			this.host.commit();
		}));

		// --- スペース --------------------------------------------------------------------
		this.separator();
		this.section(localize('paradis.agentLive.spacesLabel', "スペース"));
		this.spaceList = append(this.element, $('.paradis-agent-live-pop-list.scrollable'));

		// --- 表示 ------------------------------------------------------------------------
		this.separator();
		this.section(localize('paradis.agentLive.displayLabel', "表示"));

		const columnsRow = this.labelledRow(localize('paradis.agentLive.columnsLabel', "列"));
		const columnsSeg = append(columnsRow, $('.paradis-agent-live-seg'));
		for (let columns = PARADIS_AGENT_LIVE_MIN_COLUMNS; columns <= PARADIS_AGENT_LIVE_MAX_COLUMNS; columns++) {
			const button = append(columnsSeg, $('button'));
			button.textContent = String(columns);
			const value = columns;
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.viewState.columns = value;
				this.host.commit();
			}));
			this.columnButtons.set(columns, button);
		}

		const heightRow = this.labelledRow(localize('paradis.agentLive.rowHeightLabel', "タイルの高さ"));
		const heightSeg = append(heightRow, $('.paradis-agent-live-seg'));
		this.fillButtons.set(true, this.segButton(heightSeg,
			localize('paradis.agentLive.fillRows', "画面を等分"),
			localize('paradis.agentLive.fillRowsHint', "何件あっても1画面に収める（多いと1枚が小さくなる）"),
			() => {
				this.viewState.fillRows = true;
				this.host.commit();
			}));
		this.fillButtons.set(false, this.segButton(heightSeg,
			localize('paradis.agentLive.fixedRows', "高さを指定"),
			localize('paradis.agentLive.fixedRowsHint', "必ずこの高さで並べる（入りきらない分は縦スクロール）"),
			() => {
				this.viewState.fillRows = false;
				this.host.commit();
			}));

		// 入力欄は「画面を等分」の間も触れるままにして、数値を打った時点で「高さを指定」へ移す
		// (打てないようにすると、値を変えるのに先にモードを選ぶ必要があって手数が増える)。
		this.rowHeightInput = this.numberInput(heightRow, PARADIS_AGENT_LIVE_MIN_ROW_HEIGHT, PARADIS_AGENT_LIVE_MAX_ROW_HEIGHT, 10,
			localize('paradis.agentLive.rowHeightAria', "タイル1枚の高さ（ピクセル）"));
		this._register(addDisposableListener(this.rowHeightInput, EventType.CHANGE, () => {
			const parsed = Number.parseInt(this.rowHeightInput.value, 10);
			if (!Number.isFinite(parsed)) {
				this.rowHeightInput.value = String(this.viewState.rowHeight);
				return;
			}
			this.viewState.rowHeight = paradisClampAgentLiveRowHeight(parsed);
			// 丸めた結果を必ず書き戻す。Enter 確定では入力欄がフォーカスを持ったままなので、
			// 描画側の「入力中は上書きしない」ガードに阻まれて表示だけ元の値が残る。
			this.rowHeightInput.value = String(this.viewState.rowHeight);
			this.viewState.fillRows = false;
			this.host.commit();
		}));

		const fontRow = this.labelledRow(localize('paradis.agentLive.fontSizeLabel', "文字サイズ"));
		this.fontSizeInput = this.numberInput(fontRow, PARADIS_AGENT_LIVE_MIN_FONT_SIZE, PARADIS_AGENT_LIVE_MAX_FONT_SIZE, 0.5,
			localize('paradis.agentLive.fontSizeAria', "端末の文字サイズ（ピクセル）"));
		this._register(addDisposableListener(this.fontSizeInput, EventType.CHANGE, () => {
			const parsed = Number.parseFloat(this.fontSizeInput.value);
			if (!Number.isFinite(parsed)) {
				this.fontSizeInput.value = String(this.viewState.fontSize);
				return;
			}
			this.viewState.fontSize = paradisClampAgentLiveFontSize(parsed);
			this.fontSizeInput.value = String(this.viewState.fontSize);
			this.viewState.fitFontToTile = false;
			this.host.commit();
		}));

		this.fitCheckbox = this.checkboxRow(
			localize('paradis.agentLive.fitFont', "全体を収める（文字は小さくなる）"),
			checked => {
				this.viewState.fitFontToTile = checked;
				this.host.commit();
			},
			true,
		);

		this.hint = append(this.element, $('.paradis-agent-live-pop-hint'));

		const groupRow = this.labelledRow(localize('paradis.agentLive.groupLabel', "グループ"));
		const groupSeg = append(groupRow, $('.paradis-agent-live-seg'));
		for (const group of ['none', 'space', 'status'] as const) {
			const button = append(groupSeg, $('button'));
			button.textContent = GROUP_LABELS[group];
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.viewState.group = group;
				this.host.commit();
			}));
			this.groupButtons.set(group, button);
		}

		this.pinTopCheckbox = this.checkboxRow(
			localize('paradis.agentLive.pinTop', "ピン留めを常に先頭にする"),
			checked => {
				this.viewState.pinTop = checked;
				this.host.commit();
			},
			false,
		);

		this.separator();
		const resetButton = append(this.element, $('button.paradis-agent-live-link'));
		resetButton.textContent = localize('paradis.agentLive.reset', "表示をリセット");
		this._register(addDisposableListener(resetButton, EventType.CLICK, () => this.host.reset()));

		// 外側のクリックと Escape で閉じる。歯車自身は「外側」に数えない —— そこで閉じると、
		// 続けて届く click が改めて開き直してしまい、トグルにならないため。
		const targetWindow = getWindow(container);
		this._register(addDisposableListener(targetWindow.document, EventType.MOUSE_DOWN, event => {
			// instanceof で絞らない。別ウィンドウ側の要素が来ても contains は正しく働くので、
			// 判定をこのコードのレルムに縛らないでおく。
			const target = event.target as Node | null;
			if (target && !this.element.contains(target) && !this.host.anchor.contains(target)) {
				this.host.close(false);
			}
		}, true));
		this._register(addDisposableListener(targetWindow.document, EventType.KEY_DOWN, event => {
			if (new StandardKeyboardEvent(event).keyCode === KeyCode.Escape) {
				this.host.close(true);
			}
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
		// ツールバーが2段に折り返すと下端がウィンドウの外へ出るので、実際の位置から測って抑える。
		this.element.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.round(rootRect.height - top - BOTTOM_MARGIN))}px`;
	}

	/**
	 * 中身を現在のビュー状態に合わせる。開いたまま設定を変えても閉じないので、変更のたびに
	 * 呼ばれる。入力中の欄は書き換えない (打っている途中で桁が飛ぶため)。
	 */
	update(): void {
		for (const [sort, button] of this.sortButtons) {
			button.classList.toggle('checked', this.viewState.sort === sort);
		}
		this.directionButton.textContent = this.viewState.sortDesc
			? localize('paradis.agentLive.sortDesc', "降順（大きい方が先）")
			: localize('paradis.agentLive.sortAsc', "昇順（小さい方が先）");

		this.updateSpaces();

		for (const [columns, button] of this.columnButtons) {
			button.classList.toggle('checked', this.viewState.columns === columns);
		}
		for (const [fill, button] of this.fillButtons) {
			button.classList.toggle('checked', this.viewState.fillRows === fill);
		}
		this.fitCheckbox.checked = this.viewState.fitFontToTile;
		this.pinTopCheckbox.checked = this.viewState.pinTop;

		const active = this.element.ownerDocument.activeElement;
		if (active !== this.rowHeightInput) {
			this.rowHeightInput.value = String(this.viewState.rowHeight);
		}
		if (active !== this.fontSizeInput) {
			this.fontSizeInput.value = String(this.viewState.fontSize);
		}

		for (const [group, button] of this.groupButtons) {
			button.classList.toggle('checked', this.viewState.group === group);
		}

		this.updateHint();
	}

	/**
	 * 「いまタイルに何が見えているか」を言葉にする。指定した数値が何を意味するのかは、
	 * 元の端末の桁数とタイルの大きさの両方に依存していて、数字だけでは分からないため。
	 */
	private updateHint(): void {
		clearNode(this.hint);
		const cells = this.host.visibleCells();
		if (cells) {
			const clipped = cells.cols < cells.totalCols || cells.rows < cells.totalRows;
			append(this.hint, $('div')).textContent = clipped
				? localize('paradis.agentLive.hintClipped', "いま {0}桁 × {1}行 見えています（元の端末は {2}桁 × {3}行）。はみ出した右端と上部は切り取られます。",
					cells.cols, cells.rows, cells.totalCols, cells.totalRows)
				: localize('paradis.agentLive.hintWhole', "いま端末の全体（{0}桁 × {1}行）が見えています。", cells.totalCols, cells.totalRows);
		}
		// 見出しが行を1つ使うので、グループ表示のときは等分できない。指定した高さの方が使われる。
		if (this.viewState.fillRows && this.viewState.group !== 'none') {
			append(this.hint, $('div')).textContent = localize('paradis.agentLive.hintGroupHeight',
				"グループ表示の間は等分できないため、タイルは指定した高さ（{0}px）になります。", this.viewState.rowHeight);
		}
	}

	/**
	 * スペース一覧を現在の状態に合わせる。顔ぶれが変わっていなければチェックの付け替えだけで
	 * 済ませる —— エージェントのタイトルが変わるたびに再描画が走るので、毎回組み立て直すと
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
			button.classList.toggle('checked', selected === undefined || selected.includes(key));
		}
		this.allSpacesButton?.classList.toggle('checked', selected === undefined);
	}

	private buildSpaces(options: Map<string, string>): void {
		this.spaceDisposables.clear();
		this.spaceButtons.clear();
		clearNode(this.spaceList);
		for (const [key, label] of options) {
			const button = append(this.spaceList, $('button.paradis-agent-live-pop-item'));
			append(button, $('span.paradis-agent-live-pop-check.codicon.codicon-check'));
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
		const all = append(this.spaceList, $('button.paradis-agent-live-pop-item'));
		append(all, $('span.paradis-agent-live-pop-check.codicon.codicon-check'));
		append(all, $('span')).textContent = localize('paradis.agentLive.selectAllSpaces', "すべてのスペース");
		this.spaceDisposables.add(addDisposableListener(all, EventType.CLICK, () => {
			this.viewState.spaces = undefined;
			this.host.commit();
		}));
		this.allSpacesButton = all;
	}

	// ------------------------------------------------------------------ 部品

	private section(label: string): void {
		append(this.element, $('.paradis-agent-live-pop-head')).textContent = label;
	}

	private separator(): void {
		append(this.element, $('.paradis-agent-live-pop-sep'));
	}

	private labelledRow(label: string): HTMLElement {
		const row = append(this.element, $('.paradis-agent-live-pop-row'));
		append(row, $('span.paradis-agent-live-pop-key')).textContent = label;
		return row;
	}

	private segButton(parent: HTMLElement, label: string, hover: string, run: () => void): HTMLElement {
		const button = append(parent, $('button'));
		button.textContent = label;
		this.registerHover(button, hover);
		this._register(addDisposableListener(button, EventType.CLICK, run));
		return button;
	}

	/** チェックボックスは label で包む。id を振ると、窓を複数開いたときに衝突するため。 */
	private checkboxRow(label: string, run: (checked: boolean) => void, indent: boolean): HTMLInputElement {
		const row = append(this.element, $(`.paradis-agent-live-pop-row${indent ? '.indent' : ''}`));
		const wrapper = append(row, $('label.paradis-agent-live-pop-toggle'));
		const input = append(wrapper, $('input.paradis-agent-live-pop-checkbox')) as HTMLInputElement;
		input.type = 'checkbox';
		append(wrapper, $('span')).textContent = label;
		this._register(addDisposableListener(input, EventType.CHANGE, () => run(input.checked)));
		return input;
	}

	private numberInput(parent: HTMLElement, min: number, max: number, step: number, ariaLabel: string): HTMLInputElement {
		const input = append(parent, $('input.paradis-agent-live-number')) as HTMLInputElement;
		input.type = 'number';
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.setAttribute('aria-label', ariaLabel);
		append(parent, $('span.paradis-agent-live-tool-label')).textContent = localize('paradis.agentLive.pxUnit', "px");
		return input;
	}

	private registerHover(element: HTMLElement, text: string): void {
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), element, text));
	}
}
