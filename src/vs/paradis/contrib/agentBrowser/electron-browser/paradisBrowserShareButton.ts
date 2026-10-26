/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのツールバーの共有のボタン（差し込み口のアイコン）。共有の操作と状態の表示を、このボタン 1 つにまとめる。
//
// 状態の正は para-browser の台帳（共有と許可）で、upstream の共有の印（agent audience）ではない。ボタンには
// このページを使えるペインの数をバッジで出し（ユーザーが共有したペインのほか、エージェントが自分で開いたタブ・
// 共有したページから開いたタブのペインも数える）、共有が無いときはバッジを出さない。
//
// ボタンは本体と ▾ の 2 つに分かれる。本体を押すと、共有中でも未共有でも共有のダイアログを開く。▾ は共有があるときだけ
// 出て、押すと一覧（ペインの名前・エージェント・共有の種類と、ペインごとの「共有を解く」、「ほかのペインと共有」）を開く。
// 押しても共有は解けない。行の「共有を解く」は、そのペインがこのページを使う経路（共有・エージェントが自分で開いたタブの
// 許可・そこから開いたタブ）を一度に外す。キーボードでは本体と ▾ の間を左右の矢印で動き、Enter / Space で押す。
//
// Copilot（upstream のチャットのツール）だけと共有したページ（para-browser の台帳に無いのに共有の印が付いている）は、
// アドレスバーの upstream の表示を隠したので、ここに「Copilot と共有」の行を 1 つ出して解けるようにする。
//
// 一覧は自前の DOM なので、内蔵ブラウザのネイティブビューの上に出すために、overlayManager.ts の共通の印
// `paradis-overlay-popover` を付ける（upstream のファイルは触らない）。閉じ方はダウンロードの一覧
// （paradisBrowserDownloadsPopover.ts）と同じで、外側クリック・Esc・リサイズ・ウィンドウのフォーカス喪失で閉じ、
// 閉じたら ▾ へフォーカスを戻す。

import './media/paradisBrowserShareButton.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { BaseActionViewItem, IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisAgentBrowserBindingModel, IParadisPaneDescriptor, ParadisPageShareKind, ParadisPaneAgentKind } from './paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from './paradisAgentBrowserTabsService.js';
import { IParadisShareButtonEntries, paradisShareButtonCount, paradisShareButtonEntries } from './paradisBrowserShareCount.js';

const $ = dom.$;

/** 一覧の Copilot の行の印（ペインのトークンと重ならない）。 */
const COPILOT_ROW_KEY = 'copilot';

/** 一覧の幅。狭いウィンドウでは左右をクランプして内側に収める。 */
const POPOVER_WIDTH = 340;
const ANCHOR_GAP = 4;
const EDGE_MARGIN = 8;

/** ウィンドウごとに開いている一覧（同じウィンドウで 2 つ開かない）。 */
const openPopovers = new Map<Window, ParadisBrowserSharePopover>();

/** スペースの切り替えなどで、開いている一覧をすべて閉じる。 */
export function closeAllBrowserSharePopovers(): void {
	for (const popover of [...openPopovers.values()]) {
		popover.close();
	}
}

/** 共有の種類の文字。 */
export function paradisPageShareKindLabel(kind: ParadisPageShareKind): string {
	switch (kind) {
		case 'user': return localize('paradis.shareButton.kindUser', "あなたが共有");
		case 'agentTab': return localize('paradis.shareButton.kindAgentTab', "エージェントが自分で開いたタブ");
		case 'openedTab': return localize('paradis.shareButton.kindOpenedTab', "共有したページから開いたタブ");
	}
}

function agentLabel(kind: ParadisPaneAgentKind): string {
	switch (kind) {
		case 'claude': return localize('paradis.shareButton.agentClaude', "Claude Code");
		case 'codex': return localize('paradis.shareButton.agentCodex', "Codex");
		case 'shell': return localize('paradis.shareButton.agentShell', "ターミナル");
	}
}

/** ボタンの本体のホバーと読み上げの文言。 */
export function paradisShareButtonLabel(count: number): string {
	return count === 0
		? localize('paradis.shareButton.unshared', "エージェントと共有")
		: localize('paradis.shareButton.sharedOpensDialog', "エージェントと共有中: {0} 件（クリックで共有の設定）", count);
}

/** ▾ のホバーと読み上げの文言。 */
export function paradisShareListButtonLabel(count: number): string {
	return localize('paradis.shareButton.listButton', "このページを使えるペインの一覧（{0} 件）", count);
}

/** ボタンのどちらを押したか。 */
export type ParadisShareButtonPart = 'main' | 'list';

/**
 * 押したときに開くもの。本体はいつもダイアログ。▾ は共有があるときだけ一覧で、共有が無くなった直後に押された
 * ときは（▾ を隠す前の取りこぼし）ダイアログを開く。
 */
export function paradisShareButtonTarget(part: ParadisShareButtonPart, count: number): 'dialog' | 'list' {
	return part === 'list' && count > 0 ? 'list' : 'dialog';
}

/**
 * ツールバーの共有のボタン。ツールバーの context（このボタンが載っているブラウザエディタ）のページを見る。
 */
export class ParadisBrowserShareActionViewItem extends BaseActionViewItem {

	private _main: HTMLElement | undefined;
	private _listButton: HTMLElement | undefined;
	private _mainHover: IManagedHover | undefined;
	private _listHover: IManagedHover | undefined;
	private _badge: HTMLElement | undefined;
	private readonly _editorListener = this._register(new MutableDisposable());
	private readonly _modelListener = this._register(new MutableDisposable());
	private _popover: ParadisBrowserSharePopover | undefined;

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@IParadisAgentBrowserBindingModel private readonly _bindingModel: IParadisAgentBrowserBindingModel,
		@IHoverService private readonly _hoverService: IHoverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super(undefined, action, options);
		this._register(this._bindingModel.onDidChange(() => this._update()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		if (!this.element) {
			return;
		}
		this.element.classList.add('paradis-browser-share-item');

		// 本体（ダイアログを開く）。ツールバーの中のタブで止まる所はここ 1 つ
		const main = this._main = dom.append(this.element, $('span.paradis-browser-share-main'));
		main.tabIndex = 0;
		main.role = 'button';
		main.setAttribute('aria-haspopup', 'dialog');
		dom.append(main, $(`span.action-label.paradis-browser-share-glyph${ThemeIcon.asCSSSelector(Codicon.plug)}`));
		this._badge = dom.append(main, $('span.paradis-browser-share-badge'));
		this._badge.setAttribute('aria-hidden', 'true');

		// ▾（一覧を開く）。共有があるときだけ出す。本体から右の矢印で移る
		const listButton = this._listButton = dom.append(this.element, $(`span.paradis-browser-share-list-button${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		listButton.tabIndex = -1;
		listButton.role = 'button';
		listButton.setAttribute('aria-haspopup', 'dialog');
		listButton.setAttribute('aria-expanded', 'false');

		this._mainHover = this._register(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), main, ''));
		this._listHover = this._register(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), listButton, ''));

		// Enter / Space は ActionBar がアクションを直接走らせ、onClick を通らない。▾ で一覧を開けるよう、先にここで受ける。
		// 左右の矢印は本体と ▾ の間を動く（端からはみ出す向きは ActionBar に任せて、隣の項目へ移る）
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			const onList = this._isListPart(event.target);
			if (keyboardEvent.keyCode === KeyCode.Enter || keyboardEvent.keyCode === KeyCode.Space) {
				dom.EventHelper.stop(event, true);
				this._activate(onList ? 'list' : 'main', event);
			} else if (keyboardEvent.keyCode === KeyCode.RightArrow && !onList && this._isListVisible()) {
				dom.EventHelper.stop(event, true);
				this._focusPart('list');
			} else if (keyboardEvent.keyCode === KeyCode.LeftArrow && onList) {
				dom.EventHelper.stop(event, true);
				this._focusPart('main');
			}
		}));
		this._watchEditor();
		this._update();
	}

	override setActionContext(newContext: unknown): void {
		super.setActionContext(newContext);
		this._watchEditor();
		this._update();
	}

	override onClick(event: dom.EventLike): void {
		// クリック・タップの EventLike は DOM のイベント（GestureEvent も Event）で、押した要素は target にある
		this._activate(this._isListPart((event as Partial<Event>).target) ? 'list' : 'main', event);
	}

	override focus(fromRight?: boolean): void {
		this._focusPart(fromRight && this._isListVisible() ? 'list' : 'main');
	}

	override isFocused(): boolean {
		return !!this.element && dom.isAncestorOfActiveElement(this.element);
	}

	override blur(): void {
		this._main?.blur();
		this._listButton?.blur();
		if (this._main) {
			this._main.tabIndex = -1;
		}
		if (this._listButton) {
			this._listButton.tabIndex = -1;
		}
	}

	override setFocusable(focusable: boolean): void {
		if (this._main) {
			this._main.tabIndex = focusable ? 0 : -1;
		}
		if (!focusable && this._listButton) {
			this._listButton.tabIndex = -1;
		}
	}

	private _activate(part: ParadisShareButtonPart, event: dom.EventLike): void {
		if (paradisShareButtonTarget(part, paradisShareButtonCount(this._entries())) === 'dialog') {
			// 共有のダイアログ（アクションの本体）を開く。一覧が開いていれば先に閉じる
			this._popover?.close();
			super.onClick(event);
			return;
		}
		dom.EventHelper.stop(event, true);
		this._togglePopover();
	}

	private _isListPart(target: unknown): boolean {
		return !!this._listButton && dom.isHTMLElement(target) && this._listButton.contains(target);
	}

	private _isListVisible(): boolean {
		return !!this._listButton && !this._listButton.hidden;
	}

	private _focusPart(part: ParadisShareButtonPart): void {
		const target = part === 'list' ? this._listButton : this._main;
		const other = part === 'list' ? this._main : this._listButton;
		if (!target) {
			return;
		}
		target.tabIndex = 0;
		if (other) {
			other.tabIndex = -1;
		}
		target.focus();
	}

	private get _editor(): BrowserEditor | undefined {
		return this._context instanceof BrowserEditor ? this._context : undefined;
	}

	private _entries(): IParadisShareButtonEntries {
		const model = this._editor?.model;
		return model ? paradisShareButtonEntries(this._bindingModel.getPageShares(model.id), model.sharingState) : { shares: [], copilot: false };
	}

	private _watchEditor(): void {
		this._editorListener.value = this._editor?.onDidChangeModel(() => {
			// 別のページになった・エディタを閉じた: 前のページの一覧は閉じる
			this._popover?.close();
			this._watchModel();
			this._update();
		});
		this._watchModel();
	}

	private _watchModel(): void {
		this._modelListener.value = this._editor?.model?.onDidChangeSharingState(() => this._update());
	}

	private _togglePopover(): void {
		const anchor = this._listButton;
		const model = this._editor?.model;
		if (!anchor || !model) {
			return;
		}
		const targetWindow = dom.getWindow(anchor);
		const existing = openPopovers.get(targetWindow);
		if (existing) {
			existing.close();
			if (existing === this._popover) {
				return;
			}
		}
		const popover: ParadisBrowserSharePopover = this._instantiationService.createInstance(ParadisBrowserSharePopover, anchor, model,
			() => this.actionRunner.run(this.action, this._context),
			hadFocus => {
				if (openPopovers.get(popover.targetWindow) === popover) {
					openPopovers.delete(popover.targetWindow);
				}
				if (this._popover === popover) {
					this._popover = undefined;
				}
				if (hadFocus && anchor.isConnected) {
					this._focusPart(this._isListVisible() ? 'list' : 'main');
				}
			});
		this._popover = popover;
		openPopovers.set(popover.targetWindow, popover);
	}

	override dispose(): void {
		this._popover?.close();
		super.dispose();
	}

	private _update(): void {
		const element = this.element;
		const main = this._main;
		const listButton = this._listButton;
		if (!element || !main || !listButton) {
			return;
		}
		const count = paradisShareButtonCount(this._entries());
		element.classList.toggle('checked', count > 0);
		if (this._badge) {
			this._badge.textContent = count > 0 ? String(count) : '';
		}
		const label = paradisShareButtonLabel(count);
		main.setAttribute('aria-label', label);
		this._mainHover?.update(label);
		if (count === 0 && dom.isActiveElement(listButton)) {
			// ▾ を隠す前に、フォーカスを本体へ移す（隠れた要素にフォーカスが残ると、キーボードで迷子になる）
			this._focusPart('main');
		} else if (count === 0 && listButton.tabIndex === 0) {
			// フォーカスは無くても、タブで止まる所が隠れた ▾ に残らないよう本体へ戻す
			listButton.tabIndex = -1;
			main.tabIndex = 0;
		}
		listButton.hidden = count === 0;
		const listLabel = paradisShareListButtonLabel(count);
		listButton.setAttribute('aria-label', listLabel);
		this._listHover?.update(listLabel);
	}
}

/**
 * このページを使えるペインの一覧。共有が無くなったら閉じる。
 */
class ParadisBrowserSharePopover extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _message: HTMLElement;
	private readonly _container: HTMLElement;
	private readonly _footerButton: HTMLButtonElement;
	private _rowButtons: HTMLButtonElement[] = [];
	private readonly _rowStore = this._register(new MutableDisposable());
	private _disposed = false;

	constructor(
		private readonly _anchor: HTMLElement,
		private readonly _model: IBrowserViewModel,
		private readonly _shareWithOtherPane: () => void,
		private readonly _onDidClose: (hadFocus: boolean) => void,
		@IParadisAgentBrowserBindingModel private readonly _bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisAgentBrowserTabsService private readonly _tabsService: IParadisAgentBrowserTabsService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();
		this._container = layoutService.getContainer(dom.getWindow(_anchor));
		this._element = $('.paradis-browser-share-popover.paradis-overlay-popover');
		this._element.tabIndex = -1;
		this._element.setAttribute('role', 'dialog');
		const title = localize('paradis.shareButton.popoverTitle', "このページを使えるペイン");
		this._element.setAttribute('aria-label', title);
		dom.append(this._element, $('.pbs-header')).textContent = title;

		// 操作が効かなかったときの知らせ（通知のトーストは内蔵ブラウザの裏に隠れるので、一覧の中に出す）
		this._message = dom.append(this._element, $('.pbs-message'));
		this._message.setAttribute('role', 'status');
		this._message.hidden = true;

		this._list = dom.append(this._element, $('.pbs-list'));
		this._list.setAttribute('role', 'list');

		const footer = dom.append(this._element, $('.pbs-footer'));
		this._footerButton = dom.append(footer, $<HTMLButtonElement>('button.pbs-link'));
		this._footerButton.textContent = localize('paradis.shareButton.shareOther', "ほかのペインと共有…");
		this._register(dom.addDisposableListener(this._footerButton, dom.EventType.CLICK, () => {
			this.close();
			this._shareWithOtherPane();
		}));

		this._render();
		this._register(this._bindingModel.onDidChange(() => this._render()));
		this._register(this._model.onDidChangeSharingState(() => this._render()));

		this._container.appendChild(this._element);
		this._anchor.setAttribute('aria-expanded', 'true');
		this._layout();
		this._registerListeners();
		(this._rowButtons[0] ?? this._footerButton).focus();
	}

	get targetWindow(): Window {
		return dom.getWindow(this._container);
	}

	private _render(): void {
		if (this._disposed) {
			return;
		}
		const entries = paradisShareButtonEntries(this._bindingModel.getPageShares(this._model.id), this._model.sharingState);
		if (paradisShareButtonCount(entries) === 0) {
			this.close();
			return;
		}
		const focusedToken = this._rowButtons.find(button => dom.isActiveElement(button))?.dataset.token;
		const panes = new Map<string, IParadisPaneDescriptor>(this._bindingModel.getPanes().map(pane => [pane.token, pane]));
		const store = new DisposableStore();
		this._rowStore.value = store;
		dom.clearNode(this._list);
		this._rowButtons = [];
		if (entries.copilot) {
			const row = dom.append(this._list, $('.pbs-row'));
			row.setAttribute('role', 'listitem');
			dom.append(row, $(`span.pbs-icon${ThemeIcon.asCSSSelector(Codicon.copilot)}`));
			const text = dom.append(row, $('.pbs-text'));
			const name = localize('paradis.shareButton.copilotName', "Copilot");
			dom.append(text, $('.pbs-name')).textContent = name;
			dom.append(text, $('.pbs-kind')).textContent = localize('paradis.shareButton.kindCopilot', "Copilot のチャットと共有");
			const button = dom.append(row, $<HTMLButtonElement>('button.pbs-unshare'));
			button.textContent = localize('paradis.shareButton.unshare', "共有を解く");
			button.dataset.token = COPILOT_ROW_KEY;
			button.setAttribute('aria-label', localize('paradis.shareButton.unshareAria', "{0} との共有を解く", name));
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._run(button, () => this._model.setSharedWithAgent(false))));
			this._rowButtons.push(button);
		}
		for (const share of entries.shares) {
			const pane = panes.get(share.token);
			const row = dom.append(this._list, $('.pbs-row'));
			row.setAttribute('role', 'listitem');
			dom.append(row, $(`span.pbs-icon${ThemeIcon.asCSSSelector(Codicon.terminal)}`));
			const text = dom.append(row, $('.pbs-text'));
			const name = pane
				? localize('paradis.shareButton.paneName', "{0} · {1}", agentLabel(pane.agentKind), pane.title)
				: localize('paradis.shareButton.paneMissing', "このウィンドウに無いペイン");
			dom.append(text, $('.pbs-name')).textContent = name;
			dom.append(text, $('.pbs-kind')).textContent = paradisPageShareKindLabel(share.kind);
			const button = dom.append(row, $<HTMLButtonElement>('button.pbs-unshare'));
			button.textContent = localize('paradis.shareButton.unshare', "共有を解く");
			button.dataset.token = share.token;
			button.setAttribute('aria-label', localize('paradis.shareButton.unshareAria', "{0} との共有を解く", name));
			// そのペインがこのページを使う経路（共有・自分で開いたタブの許可・そこから開いたタブ）を一度に外す
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._run(button, () => this._tabsService.unsharePageFromPane(share.token, this._model.id))));
			this._rowButtons.push(button);
		}
		if (focusedToken !== undefined) {
			// 行を作り直してもフォーカスを失わない（同じペインの行、無ければ先頭へ）
			(this._rowButtons.find(button => button.dataset.token === focusedToken) ?? this._rowButtons[0])?.focus();
		}
		if (this._element.isConnected) {
			this._layout();
		}
	}

	private async _run(button: HTMLButtonElement, operation: () => Promise<unknown>): Promise<void> {
		button.disabled = true;
		this._message.hidden = true;
		try {
			await operation();
		} catch (error) {
			if (!this._disposed) {
				button.disabled = false;
				this._message.textContent = localize('paradis.shareButton.unshareFailed', "共有を解けませんでした: {0}", toErrorMessage(error));
				this._message.hidden = false;
			}
		}
	}

	private _layout(): void {
		const containerPosition = dom.getDomNodePagePosition(this._container);
		const width = Math.min(POPOVER_WIDTH, Math.max(200, containerPosition.width - EDGE_MARGIN * 2));
		this._element.style.width = `${width}px`;
		const anchorPosition = dom.getDomNodePagePosition(this._anchor);
		const anchorBottom = anchorPosition.top - containerPosition.top + anchorPosition.height;
		this._element.style.maxHeight = `${Math.max(120, containerPosition.height - anchorBottom - ANCHOR_GAP - EDGE_MARGIN)}px`;
		// ボタンの右端に一覧の右端を揃える
		const anchorRight = anchorPosition.left - containerPosition.left + anchorPosition.width;
		const left = Math.min(
			Math.max(EDGE_MARGIN, anchorRight - width),
			Math.max(EDGE_MARGIN, containerPosition.width - width - EDGE_MARGIN),
		);
		this._element.style.top = `${Math.round(anchorBottom + ANCHOR_GAP)}px`;
		this._element.style.left = `${Math.round(left)}px`;
	}

	private _registerListeners(): void {
		const targetWindow = dom.getWindow(this._container);
		this._register(dom.addDisposableListener(this._element, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Escape) {
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				this.close();
			} else if (keyboardEvent.keyCode === KeyCode.Tab || keyboardEvent.keyCode === KeyCode.DownArrow || keyboardEvent.keyCode === KeyCode.UpArrow) {
				// フォーカスを一覧の中で回す。外へ逃がすと開いたまま別の場所へ移り、閉じ方が分からなくなる
				this._moveFocus(keyboardEvent.keyCode === KeyCode.UpArrow || (keyboardEvent.keyCode === KeyCode.Tab && keyboardEvent.shiftKey));
				keyboardEvent.preventDefault();
			}
		}));
		this._register(dom.addDisposableListener(this._element, dom.EventType.FOCUS_OUT, event => {
			const next = event.relatedTarget as Node | null;
			if (next && !this._element.contains(next) && !this._anchor.contains(next)) {
				this.close();
			}
		}));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_DOWN, event => {
			const target = event.target as Node | null;
			if (target && (this._element.contains(target) || this._anchor.contains(target))) {
				return;
			}
			this.close();
		}, true));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.RESIZE, () => this.close()));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.BLUR, () => this.close()));
	}

	private _moveFocus(backwards: boolean): void {
		const focusable = [...this._rowButtons, this._footerButton].filter(button => !button.disabled);
		if (focusable.length === 0) {
			return;
		}
		const index = focusable.findIndex(element => dom.isActiveElement(element));
		const next = backwards
			? (index <= 0 ? focusable.length - 1 : index - 1)
			: (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
		focusable[next].focus();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._anchor.setAttribute('aria-expanded', 'false');
		// フォーカスはボタンへ戻す（戻し先は ▾ が隠れていれば本体。ボタンの側が決める）
		const hadFocus = dom.isAncestorOfActiveElement(this._element);
		this._element.remove();
		super.dispose();
		this._onDidClose(hadFocus);
	}
}
