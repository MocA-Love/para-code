/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの「入力で絞れる候補の一覧」（q.html Q605）。候補が多く、名前で探して選ぶもの（ブランチなど）に使う。
// 少ない選択肢はプルダウン（paradisSelect.ts）、よく替える 2〜4 個は切り替えの組（paradisSegmented.ts）にする。
//
// 見出しで分けた候補（ローカル / origin など）を、欄に打った文字で絞る。フォーカスは常に欄に残し、↑↓ で一覧の行を
// 動かして Enter で選ぶ。Esc は開いているときだけ一覧を閉じる（伝播を止め、外側のモーダルまで閉じない）。
//
// 包んでいる本家のファイル（upstream を取り込むときは、ここの差分の「キー・フォーカス・読み上げ」を読む）:
//  - src/vs/base/browser/ui/inputbox/inputBox.ts（paradisInputField.ts 経由。`<input>` と読み上げの名前）
//  - src/vs/base/browser/ui/list/listWidget.ts（一覧の行の仮想化と、読み上げの listbox / option・行の id）
//  - src/vs/base/browser/ui/contextview/contextview.ts（IContextViewService。一覧を出す場所と、上下どちらに出すか）
// 一覧は本家のコンテキストビュー（2575）に出る。fork のモーダルはその下の段（paradisModal.ts の表）なので、モーダルの上に出る。
//
// 読み上げ: 欄は `combobox`（`aria-expanded`・`aria-controls`・`aria-activedescendant`）、一覧は List の `listbox` と
// `option`。見出しの行は `presentation` にし、見出しの名前は各行の読み上げの名前に入れる。

import './media/paradisComboBox.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../base/browser/keyboardEvent.js';
import { IListRenderer, IListVirtualDelegate } from '../../base/browser/ui/list/list.js';
import { List } from '../../base/browser/ui/list/listWidget.js';
import { Codicon } from '../../base/common/codicons.js';
import { Emitter, Event } from '../../base/common/event.js';
import { KeyCode } from '../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { IContextViewService, IOpenContextView } from '../../platform/contextview/browser/contextView.js';
import { createParadisChip } from './paradisBadges.js';
import { ParadisButton } from './paradisButton.js';
import { ParadisInputField } from './paradisInputField.js';

/** 候補の 1 件。 */
export interface IParadisComboItem {
	/** 一覧の中で一意な値。 */
	readonly id: string;
	readonly label: string;
	/** 名前の前に薄く出す文字（`origin/` など）。絞り込みと欄の表示には含める。 */
	readonly prefix?: string;
	readonly icon?: ThemeIcon;
	/** 右に出す補足（更新日時など）。`chip` があればそちらを出す。 */
	readonly detail?: string;
	/** 右に出す札（使用中など）。 */
	readonly chip?: string;
}

/** 見出しと、その下の候補。 */
export interface IParadisComboGroup {
	readonly label: string;
	readonly icon?: ThemeIcon;
	readonly items: readonly IParadisComboItem[];
}

/** 一覧の上に出す知らせ（取得中・取得できない など）。 */
export interface IParadisComboNotice {
	readonly text: string;
	readonly icon: ThemeIcon;
	readonly warning?: boolean;
	/** 押せる操作（再試行など）。押されたら {@link ParadisComboBox.onDidRunNoticeAction}。 */
	readonly actionLabel?: string;
}

export interface IParadisComboBoxOptions {
	/** 欄の読み上げの名前。 */
	readonly ariaLabel: string;
	readonly placeholder: string;
	/** 欄の左のアイコン。 */
	readonly icon?: ThemeIcon;
	/** 一致する候補が無いときの文。 */
	readonly emptyLabel: string;
	/** 一覧の下の操作の案内（`↑↓ で選んで Enter` など）。 */
	readonly footer?: string;
}

/** 一覧の幅。欄より狭い画面でも窓の内側に収め、長い名前は省略記号で切る（全体は title）。 */
const POPUP_MIN_WIDTH = 300;
const POPUP_MAX_WIDTH = 360;
const POPUP_MAX_HEIGHT = 360;
const ITEM_HEIGHT = 28;
const FIRST_GROUP_HEIGHT = 24;
const GROUP_HEIGHT = 29;

type ParadisComboRow =
	| { readonly kind: 'group'; readonly label: string; readonly icon?: ThemeIcon; readonly count: number; readonly first: boolean }
	| { readonly kind: 'item'; readonly item: IParadisComboItem; readonly group: string };

/** 欄に出す名前（接頭辞込み）。 */
function paradisComboItemText(item: IParadisComboItem): string {
	return `${item.prefix ?? ''}${item.label}`;
}

/** 打った文字で候補を絞り、見出しと候補の行に並べる（大文字小文字を区別しない部分一致。0 件の見出しは出さない）。 */
export function paradisComboRows(groups: readonly IParadisComboGroup[], filter: string): ParadisComboRow[] {
	const needle = filter.trim().toLowerCase();
	const rows: ParadisComboRow[] = [];
	for (const group of groups) {
		const items = needle ? group.items.filter(item => paradisComboItemText(item).toLowerCase().includes(needle)) : group.items;
		if (items.length === 0) {
			continue;
		}
		rows.push({ kind: 'group', label: group.label, icon: group.icon, count: items.length, first: rows.length === 0 });
		for (const item of items) {
			rows.push({ kind: 'item', item, group: group.label });
		}
	}
	return rows;
}

const isItem = (row: ParadisComboRow) => row.kind === 'item';

/** 一覧の要素の id を窓の中で一意にする番号。 */
let paradisComboCount = 0;

class ParadisComboDelegate implements IListVirtualDelegate<ParadisComboRow> {
	getHeight(row: ParadisComboRow): number {
		return row.kind === 'item' ? ITEM_HEIGHT : row.first ? FIRST_GROUP_HEIGHT : GROUP_HEIGHT;
	}
	getTemplateId(row: ParadisComboRow): string {
		return row.kind;
	}
}

interface IGroupTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	readonly root: HTMLElement;
}

class ParadisComboGroupRenderer implements IListRenderer<ParadisComboRow, IGroupTemplate> {
	readonly templateId = 'group';
	renderTemplate(container: HTMLElement): IGroupTemplate {
		const root = append(container, $('.paradis-combo-group'));
		const icon = append(root, $('span'));
		icon.setAttribute('aria-hidden', 'true');
		return { root, icon, label: append(root, $('span.paradis-combo-group-label')), count: append(root, $('span.paradis-combo-group-count')) };
	}
	renderElement(row: ParadisComboRow, _index: number, template: IGroupTemplate): void {
		if (row.kind !== 'group') {
			return;
		}
		template.root.classList.toggle('first', row.first);
		template.icon.className = row.icon ? ThemeIcon.asClassName(row.icon) : '';
		template.label.textContent = row.label;
		template.count.textContent = String(row.count);
	}
	disposeTemplate(): void { }
}

interface IItemTemplate {
	readonly root: HTMLElement;
	readonly icon: HTMLElement;
	readonly prefix: HTMLElement;
	readonly label: HTMLElement;
	readonly meta: HTMLElement;
}

class ParadisComboItemRenderer implements IListRenderer<ParadisComboRow, IItemTemplate> {
	readonly templateId = 'item';
	renderTemplate(container: HTMLElement): IItemTemplate {
		const root = append(container, $('.paradis-combo-item'));
		const icon = append(root, $('span'));
		icon.setAttribute('aria-hidden', 'true');
		const name = append(root, $('span.paradis-combo-item-name'));
		return { root, icon, prefix: append(name, $('span.paradis-combo-item-prefix')), label: append(name, $('span')), meta: append(root, $('span.paradis-combo-item-meta')) };
	}
	renderElement(row: ParadisComboRow, _index: number, template: IItemTemplate): void {
		if (row.kind !== 'item') {
			return;
		}
		const item = row.item;
		template.icon.className = item.icon ? ThemeIcon.asClassName(item.icon) : '';
		template.prefix.textContent = item.prefix ?? '';
		template.label.textContent = item.label;
		// 長い名前は省略記号で切るので、全体はポインタを重ねたときに出す
		template.root.title = paradisComboItemText(item);
		template.meta.textContent = '';
		if (item.chip) {
			createParadisChip(template.meta, item.chip);
		} else if (item.detail) {
			template.meta.textContent = item.detail;
		}
	}
	disposeTemplate(): void { }
}

/** 入力で絞れる候補の一覧。利用者が選んだときだけ {@link onDidSelect} が来る。 */
export class ParadisComboBox extends Disposable {

	/** 欄（`.paradis-field`）。幅は置く側の CSS で決める。 */
	readonly element: HTMLElement;

	private readonly field: ParadisInputField;
	private readonly popup: HTMLElement;
	private readonly noticeElement: HTMLElement;
	private readonly noticeText: HTMLElement;
	private readonly noticeIcon: HTMLElement;
	private readonly noticeAction: ParadisButton;
	private readonly listHost: HTMLElement;
	private readonly emptyElement: HTMLElement;
	private readonly list: List<ParadisComboRow>;

	private groups: readonly IParadisComboGroup[] = [];
	private rows: ParadisComboRow[] = [];
	private filter = '';
	private _selected: IParadisComboItem | undefined;
	private openView: IOpenContextView | undefined;
	/** 一覧を開いている間だけの購読。 */
	private readonly openStore = this._register(new DisposableStore());

	private readonly _onDidSelect = this._register(new Emitter<IParadisComboItem>());
	readonly onDidSelect: Event<IParadisComboItem> = this._onDidSelect.event;

	private readonly _onDidRunNoticeAction = this._register(new Emitter<void>());
	readonly onDidRunNoticeAction: Event<void> = this._onDidRunNoticeAction.event;

	constructor(parent: HTMLElement, private readonly contextViewService: IContextViewService, private readonly options: IParadisComboBoxOptions) {
		super();
		this.field = this._register(new ParadisInputField(parent, { ariaLabel: options.ariaLabel, placeholder: options.placeholder, icon: options.icon, small: true }));
		this.element = this.field.element;
		this.element.classList.add('paradis-combo');
		const chevron = append(this.element, $(ThemeIcon.asCSSSelector(Codicon.chevronDown) + '.paradis-combo-chevron'));
		chevron.setAttribute('aria-hidden', 'true');

		this.popup = $('.paradis-combo-popup');
		this.noticeElement = append(this.popup, $('.paradis-combo-notice'));
		this.noticeIcon = append(this.noticeElement, $('span'));
		this.noticeIcon.setAttribute('aria-hidden', 'true');
		this.noticeText = append(this.noticeElement, $('span.paradis-combo-notice-text'));
		// 取得の状態が変わったことを読み上げる
		this.noticeText.setAttribute('role', 'status');
		this.noticeAction = this._register(new ParadisButton(this.noticeElement, { kind: 'ghost', small: true, label: '' }));
		this._register(this.noticeAction.onDidClick(() => this._onDidRunNoticeAction.fire()));
		this.listHost = append(this.popup, $('.paradis-combo-list'));
		this.emptyElement = append(this.popup, $('.paradis-combo-empty'));
		this.emptyElement.textContent = options.emptyLabel;
		if (options.footer) {
			append(this.popup, $('.paradis-combo-footer')).textContent = options.footer;
		}
		this.setNotice(undefined);

		this.list = this._register(new List<ParadisComboRow>('ParadisComboBox', this.listHost, new ParadisComboDelegate(), [new ParadisComboGroupRenderer(), new ParadisComboItemRenderer()], {
			// キーは欄が受ける（フォーカスを欄に残す）。押下は下で拾う
			keyboardSupport: false,
			mouseSupport: false,
			multipleSelectionSupport: false,
			setRowLineHeight: false,
			accessibilityProvider: {
				getWidgetRole: () => 'listbox',
				getWidgetAriaLabel: () => options.ariaLabel,
				getRole: row => row.kind === 'item' ? 'option' : 'presentation',
				getAriaLabel: row => row.kind === 'item' ? [paradisComboItemText(row.item), row.group, row.item.chip ?? row.item.detail].filter(part => !!part).join(', ') : null,
			},
		}));
		const listElement = this.list.getHTMLElement();
		listElement.id = `paradis-combo-list-${++paradisComboCount}`;

		const input = this.field.inputElement;
		input.setAttribute('role', 'combobox');
		input.setAttribute('aria-autocomplete', 'list');
		input.setAttribute('aria-expanded', 'false');
		input.setAttribute('aria-controls', listElement.id);

		// 一覧の中の押下でフォーカスを欄から奪わない（再試行のボタンも押せる: click は届く）
		this._register(addDisposableListener(this.popup, EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register(this.list.onMouseClick(e => {
			if (e.element?.kind === 'item') {
				this.choose(e.element.item);
			}
		}));
		this._register(this.list.onMouseOver(e => {
			if (e.element?.kind === 'item' && e.index !== undefined) {
				this.focusRow(e.index, false);
			}
		}));
		this._register(this.list.onDidChangeFocus(() => this.syncActiveDescendant()));

		this._register(addDisposableListener(this.element, EventType.MOUSE_DOWN, e => {
			if (!this.field.enabled) {
				return;
			}
			// 矢印を押したら開閉、欄を押したら開く（文字の位置は動かす）
			if ((e.target as HTMLElement).classList.contains('paradis-combo-chevron')) {
				e.preventDefault();
				if (this.isOpen) {
					this.close();
				} else {
					this.open();
				}
				this.field.focus();
			} else if (!this.isOpen) {
				this.open();
			}
		}));
		// 利用者が打ったときだけ絞る（InputBox の onDidChange は value の代入でも来る）
		this._register(addDisposableListener(input, EventType.INPUT, () => {
			const value = input.value;
			if (!this.isOpen) {
				this.open();
				this.field.value = value;
			}
			if (this.filter !== value) {
				this.filter = value;
				this.renderRows(undefined);
			}
		}));
		this._register(addDisposableListener(input, EventType.KEY_DOWN, e => this.onKeyDown(new StandardKeyboardEvent(e))));
		this._register(addDisposableListener(input, EventType.BLUR, e => {
			const next = e.relatedTarget as Node | null;
			if (!next || !this.popup.contains(next)) {
				this.close();
			}
		}));
		this._register(toDisposable(() => this.close()));
	}

	/** 選んでいる候補。 */
	get selected(): IParadisComboItem | undefined {
		return this._selected;
	}

	/** 候補を選んだことにする（利用者の操作ではないので {@link onDidSelect} は来ない）。閉じた欄にその名前を出す。 */
	set selected(item: IParadisComboItem | undefined) {
		this._selected = item;
		if (!this.isOpen) {
			this.showSelected();
		}
	}

	get isOpen(): boolean {
		return this.openView !== undefined;
	}

	get inputElement(): HTMLInputElement {
		return this.field.inputElement;
	}

	get enabled(): boolean {
		return this.field.enabled;
	}

	set enabled(enabled: boolean) {
		this.field.enabled = enabled;
		if (!enabled) {
			this.close();
		}
	}

	focus(): void {
		this.field.focus();
	}

	/**
	 * 候補を入れ替える。打った文字と注目している行（同じ id が残っていれば）は保つ。選んでいる候補が無くなったら選択を外す
	 * （呼ぶ側が {@link selected} を見て判断する）。
	 */
	setGroups(groups: readonly IParadisComboGroup[]): void {
		this.groups = groups;
		const focused = this.focusedItem();
		if (this._selected && !groups.some(group => group.items.some(item => item.id === this._selected!.id))) {
			this.selected = undefined;
		}
		this.renderRows(focused?.id);
	}

	/** 一覧の上の知らせ。undefined で隠す。 */
	setNotice(notice: IParadisComboNotice | undefined): void {
		this.noticeElement.classList.toggle('hidden', !notice);
		this.noticeElement.classList.toggle('warning', !!notice?.warning);
		this.noticeIcon.className = notice ? ThemeIcon.asClassName(notice.icon) : '';
		this.noticeText.textContent = notice?.text ?? '';
		this.noticeAction.label = notice?.actionLabel ?? '';
		this.noticeAction.element.classList.toggle('hidden', !notice?.actionLabel);
		this.layoutPopup();
	}

	open(): void {
		if (this.isOpen || !this.field.enabled) {
			return;
		}
		this.filter = '';
		this.field.value = '';
		this.field.setPlaceholder(this.options.placeholder);
		this.element.classList.add('open');
		this.field.inputElement.setAttribute('aria-expanded', 'true');
		this.renderRows(this._selected?.id);
		const view = this.contextViewService.showContextView({
			getAnchor: () => this.element,
			render: container => {
				container.appendChild(this.popup);
				this.layoutPopup();
				const focused = this.list.getFocus()[0];
				if (focused !== undefined && focused > this.rows.findIndex(isItem)) {
					this.list.reveal(focused);
				} else {
					this.list.scrollTop = 0;
				}
				return toDisposable(() => this.popup.remove());
			},
			layout: () => this.layoutPopup(),
			onDOMEvent: (e: UIEvent) => {
				// 欄と一覧の外を押したら閉じる（キーは欄で受ける）
				const target = e.target as Node | null;
				if (e.type === EventType.CLICK && target && !this.element.contains(target) && !this.popup.contains(target)) {
					this.close();
				}
			},
			onHide: () => this.onHidden(),
		});
		this.openView = view;
		this.openStore.add(addDisposableListener(getWindow(this.element), EventType.RESIZE, () => this.close()));
	}

	close(): void {
		const view = this.openView;
		if (!view) {
			return;
		}
		view.close();
		// close() で onHide が呼ばれないことがある（別の一覧に置き換わった後など）ので、ここでも片付ける
		this.onHidden();
	}

	private onHidden(): void {
		if (!this.openView) {
			return;
		}
		this.openView = undefined;
		this.openStore.clear();
		this.element.classList.remove('open');
		this.field.inputElement.setAttribute('aria-expanded', 'false');
		this.field.inputElement.removeAttribute('aria-activedescendant');
		this.showSelected();
	}

	private showSelected(): void {
		this.field.value = this._selected ? paradisComboItemText(this._selected) : '';
		this.filter = this.field.value;
	}

	private onKeyDown(e: StandardKeyboardEvent): void {
		if (!this.isOpen) {
			if (e.keyCode === KeyCode.DownArrow) {
				e.preventDefault();
				this.open();
			}
			return;
		}
		switch (e.keyCode) {
			case KeyCode.DownArrow:
			case KeyCode.UpArrow:
				e.preventDefault();
				this.move(e.keyCode === KeyCode.DownArrow ? 1 : -1);
				return;
			case KeyCode.Enter: {
				const item = this.focusedItem();
				if (item) {
					// ⌘⏎（作成など、外側の確定）は外側へ通す
					if (e.metaKey || e.ctrlKey) {
						return;
					}
					e.preventDefault();
					e.stopPropagation();
					this.choose(item);
				}
				return;
			}
			case KeyCode.Escape:
				// 一覧だけを閉じる。外側のモーダルまで閉じない
				e.preventDefault();
				e.stopPropagation();
				this.close();
				return;
			case KeyCode.Tab:
				this.close();
				return;
		}
	}

	private move(delta: 1 | -1): void {
		if (!this.rows.some(isItem)) {
			return;
		}
		const current = this.list.getFocus()[0];
		if (current === undefined) {
			this.focusRow(delta === 1 ? this.rows.findIndex(isItem) : this.rows.length - 1 - [...this.rows].reverse().findIndex(isItem), true);
			return;
		}
		// 見出しの行では止まらない
		if (delta === 1) {
			this.list.focusNext(1, false, undefined, isItem);
		} else {
			this.list.focusPrevious(1, false, undefined, isItem);
		}
		const next = this.list.getFocus()[0];
		if (next === this.rows.findIndex(isItem)) {
			this.list.scrollTop = 0;
		} else if (next !== undefined) {
			this.list.reveal(next);
		}
	}

	private focusRow(index: number, reveal: boolean): void {
		if (index < 0 || index >= this.rows.length) {
			return;
		}
		this.list.setFocus([index]);
		if (reveal) {
			this.list.reveal(index);
		}
	}

	private focusedItem(): IParadisComboItem | undefined {
		const index = this.list.getFocus()[0];
		const row = index === undefined ? undefined : this.rows[index];
		return row?.kind === 'item' ? row.item : undefined;
	}

	private choose(item: IParadisComboItem): void {
		this._selected = item;
		this.close();
		this.showSelected();
		this._onDidSelect.fire(item);
	}

	/** 行を並べ直し、`focusId` の行（無ければ先頭の候補）に注目する。 */
	private renderRows(focusId: string | undefined): void {
		this.rows = paradisComboRows(this.groups, this.element.classList.contains('open') ? this.filter : '');
		this.list.splice(0, this.list.length, this.rows);
		const hasItems = this.rows.some(isItem);
		this.emptyElement.classList.toggle('hidden', hasItems);
		const keep = focusId === undefined ? -1 : this.rows.findIndex(row => row.kind === 'item' && row.item.id === focusId);
		const index = keep >= 0 ? keep : this.rows.findIndex(isItem);
		if (index >= 0) {
			this.list.setFocus([index]);
		} else {
			this.list.setFocus([]);
		}
		this.layoutPopup();
		// 先頭の候補なら見出しごと見せる（reveal だと見出しの行が上に隠れる）。残した候補は見える所まで送る
		if (keep >= 0) {
			this.list.reveal(keep);
		} else {
			this.list.scrollTop = 0;
		}
		this.syncActiveDescendant();
	}

	private syncActiveDescendant(): void {
		const index = this.list.getFocus()[0];
		if (this.isOpen && index !== undefined) {
			this.field.inputElement.setAttribute('aria-activedescendant', this.list.getElementID(index));
		} else {
			this.field.inputElement.removeAttribute('aria-activedescendant');
		}
	}

	/** 一覧の幅と高さ。窓の内側に収め、上下で広い方へ出せるだけの高さにする（どちらに出すかはコンテキストビューが決める）。 */
	private layoutPopup(): void {
		if (!this.popup.isConnected) {
			return;
		}
		const window = getWindow(this.element);
		const anchor = this.element.getBoundingClientRect();
		const width = Math.max(0, Math.min(Math.max(anchor.width, POPUP_MIN_WIDTH), POPUP_MAX_WIDTH, window.innerWidth - 8));
		this.popup.style.width = `${width}px`;
		const below = window.innerHeight - anchor.bottom - 12;
		const above = anchor.top - 12;
		const room = below >= Math.min(POPUP_MAX_HEIGHT, 200) || below >= above ? below : above;
		const chrome = this.popup.offsetHeight - this.listHost.offsetHeight;
		const height = Math.max(ITEM_HEIGHT, Math.min(this.list.contentHeight, POPUP_MAX_HEIGHT - chrome, room - chrome));
		this.listHost.style.height = `${this.rows.length === 0 ? 0 : height}px`;
		this.list.layout(this.rows.length === 0 ? 0 : height, width - 2);
	}
}
