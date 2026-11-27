/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータ・エミュレータのタブの見出しの「ペインに渡す」ボタン（q.html Q688 の案 B）。内蔵ブラウザのツールバーの
// 共有のボタン（paradisBrowserShareButton.ts）と同じ形と動きにする。
//
// ボタンは本体と ▾ の 2 つ。本体は、共有ダイアログの「モバイル端末」タブを、この端末の渡し先を開いた状態で出す
// （タブの右クリック「ターミナルに割り当てる…」と同じコマンド）。▾ は渡しているペインがあるときだけ出て、押すと
// 渡しているペインの一覧（ターミナルの名前と、行ごとの「渡すのをやめる」、下に「ほかのペインに渡す…」）を開く。
// 本体の右上の数は、この端末を渡しているペインの数。
//
// 状態の正は shared process の台帳（renderer では IParadisMobileCanvasModel）。台帳は、シミュレータのタブが見えている
// 間だけ定期的に読み直される（paradisSimulatorTabLabels.contribution.ts）。ここでは変化を受けて描き直すだけ。
// 一覧の見た目は内蔵ブラウザの一覧と同じ部品（.paradis-browser-share-popover）を使う。

import '../../agentBrowser/electron-browser/media/paradisBrowserShareButton.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { PARADIS_POPOVER_MOTION_CLASS, paradisRemovePopoverElement, paradisWatchPopoverDismiss } from '../../../browser/paradisAnchoredPopover.js';
import { ParadisCountBadge } from '../../../browser/paradisBadges.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisMobileAttachment, IParadisMobileDevice, paradisMobileAttachmentIsFor } from '../common/paradisMobileCanvas.js';
import { IParadisMobileCanvasModel } from './paradisMobileCanvasModel.js';

const $ = dom.$;

/** 共有ダイアログの「モバイル端末」タブを、その端末を開いた状態で出すコマンド（paradisAgentBrowser.contribution.ts）。 */
export const PARADIS_MOBILE_OPEN_ATTACH_DIALOG_COMMAND_ID = 'paradis.mobileCanvas.openAttachDialog';

const POPOVER_WIDTH = 320;
const ANCHOR_GAP = 4;
const EDGE_MARGIN = 8;

/** その端末（台帳の id）を渡しているペインの割り当て（台帳の順）。起動して id が替わった Android も同じ端末とみなす。 */
export function paradisSimulatorShareEntries(deviceId: string | undefined, attachments: readonly IParadisMobileAttachment[], devices: readonly IParadisMobileDevice[]): IParadisMobileAttachment[] {
	return deviceId === undefined ? [] : attachments.filter(attachment => paradisMobileAttachmentIsFor(devices, attachment.deviceId, deviceId));
}

/** 本体のホバーと読み上げの文言。 */
export function paradisSimulatorShareLabel(count: number): string {
	return count === 0
		? localize('paradis.simulatorShare.unshared', "ターミナルのペインに渡す")
		: localize('paradis.simulatorShare.shared', "ペインに渡しています: {0} 件（クリックで渡す先の設定）", count);
}

/** ▾ のホバーと読み上げの文言。 */
export function paradisSimulatorShareListLabel(count: number): string {
	return localize('paradis.simulatorShare.listButton', "この端末を使えるペインの一覧（{0} 件）", count);
}

/** 一覧の行の 2 行目。そのペインで、この端末が今の操作先か。 */
export function paradisSimulatorShareKindLabel(attachment: IParadisMobileAttachment): string {
	return attachment.current
		? localize('paradis.simulatorShare.kindCurrent', "このペインの操作先")
		: localize('paradis.simulatorShare.kindOther', "渡し済み（このペインの操作先は別の端末）");
}

/**
 * 見出しの「ペインに渡す」ボタン。{@link setDevice} で、どの端末（台帳の id）のボタンかを決める。
 */
export class ParadisSimulatorShareButton extends Disposable {

	readonly element: HTMLElement;
	private readonly _main: HTMLElement;
	private readonly _listButton: HTMLElement;
	private readonly _badge: ParadisCountBadge;
	private readonly _mainHover: IManagedHover;
	private readonly _listHover: IManagedHover;
	private readonly _popover = this._register(new MutableDisposable<ParadisSimulatorSharePopover>());
	private _deviceId: string | undefined;

	constructor(
		container: HTMLElement,
		@IParadisMobileCanvasModel private readonly _model: IParadisMobileCanvasModel,
		@ICommandService private readonly _commandService: ICommandService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this.element = dom.append(container, $('.paradis-simulator-share'));
		// 本体（ダイアログを開く）。タブで止まる所はここ 1 つ。左右の矢印で ▾ と行き来する
		this._main = dom.append(this.element, $('span.paradis-simulator-share-main.paradis-focus-ring-inset'));
		this._main.tabIndex = 0;
		this._main.role = 'button';
		this._main.setAttribute('aria-haspopup', 'dialog');
		dom.append(this._main, $(`span.paradis-simulator-share-glyph${ThemeIcon.asCSSSelector(Codicon.plug)}`));
		this._badge = new ParadisCountBadge(this._main, 'overlay');
		this._listButton = dom.append(this.element, $(`span.paradis-simulator-share-list${ThemeIcon.asCSSSelector(Codicon.chevronDown)}.paradis-focus-ring-inset`));
		this._listButton.tabIndex = -1;
		this._listButton.role = 'button';
		this._listButton.setAttribute('aria-haspopup', 'dialog');
		this._listButton.setAttribute('aria-expanded', 'false');
		this._mainHover = this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this._main, ''));
		this._listHover = this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this._listButton, ''));

		this._register(dom.addDisposableListener(this._main, dom.EventType.CLICK, () => this._openDialog()));
		this._register(dom.addDisposableListener(this._listButton, dom.EventType.CLICK, event => {
			dom.EventHelper.stop(event, true);
			this._togglePopover();
		}));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			const onList = dom.isHTMLElement(event.target) && this._listButton.contains(event.target);
			if (keyboardEvent.keyCode === KeyCode.Enter || keyboardEvent.keyCode === KeyCode.Space) {
				dom.EventHelper.stop(event, true);
				if (onList) {
					this._togglePopover();
				} else {
					this._openDialog();
				}
			} else if (keyboardEvent.keyCode === KeyCode.RightArrow && !onList && !this._listButton.hidden) {
				dom.EventHelper.stop(event, true);
				this._focusPart(this._listButton, this._main);
			} else if (keyboardEvent.keyCode === KeyCode.LeftArrow && onList) {
				dom.EventHelper.stop(event, true);
				this._focusPart(this._main, this._listButton);
			}
		}));
		this._register(this._model.onDidChange(() => this._update()));
		this._update();
	}

	/** どの端末のボタンか（台帳の id。iOS は `ios:core-simulator:<udid>`、Android は `android:serial:<serial>` など）。 */
	setDevice(deviceId: string | undefined): void {
		if (deviceId === this._deviceId) {
			return;
		}
		this._deviceId = deviceId;
		this._popover.clear();
		this._update();
	}

	/** この端末を渡しているペインの割り当て。 */
	entries(): IParadisMobileAttachment[] {
		return paradisSimulatorShareEntries(this._deviceId, this._model.snapshot.attachments, this._model.snapshot.devices);
	}

	/** 開いている一覧を閉じる（タブを替えた・隠れたとき）。 */
	closePopover(): void {
		this._popover.clear();
	}

	private _openDialog(): void {
		this._popover.clear();
		if (this._deviceId !== undefined) {
			void this._commandService.executeCommand(PARADIS_MOBILE_OPEN_ATTACH_DIALOG_COMMAND_ID, this._deviceId);
		}
	}

	private _togglePopover(): void {
		if (this._popover.value) {
			this._popover.clear();
			return;
		}
		if (this.entries().length === 0) {
			this._openDialog();
			return;
		}
		this._popover.value = this._instantiationService.createInstance(ParadisSimulatorSharePopover, this._listButton, () => this.entries(), () => this._openDialog(), (hadFocus: boolean) => {
			// 自分から閉じた（外側のクリック・Esc・行が無くなった）。MutableDisposable から外し、フォーカスをボタンへ戻す
			this._popover.clearAndLeak();
			if (hadFocus && this._listButton.isConnected) {
				this._focusPart(this._listButton.hidden ? this._main : this._listButton, this._listButton.hidden ? this._listButton : this._main);
			}
		});
	}

	private _focusPart(target: HTMLElement, other: HTMLElement): void {
		target.tabIndex = 0;
		other.tabIndex = -1;
		target.focus();
	}

	private _update(): void {
		const count = this.entries().length;
		this.element.classList.toggle('checked', count > 0);
		this.element.hidden = this._deviceId === undefined;
		this._badge.update(count, 'plain');
		const label = paradisSimulatorShareLabel(count);
		this._main.setAttribute('aria-label', label);
		this._mainHover.update(label);
		if (count === 0 && dom.isActiveElement(this._listButton)) {
			this._focusPart(this._main, this._listButton);
		} else if (count === 0) {
			this._listButton.tabIndex = -1;
			this._main.tabIndex = 0;
		}
		this._listButton.hidden = count === 0;
		const listLabel = paradisSimulatorShareListLabel(count);
		this._listButton.setAttribute('aria-label', listLabel);
		this._listHover.update(listLabel);
	}
}

/**
 * この端末を渡しているペインの一覧。渡しているペインが無くなったら閉じる。見た目は内蔵ブラウザの一覧と同じ。
 */
class ParadisSimulatorSharePopover extends Disposable {

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
		private readonly _entries: () => IParadisMobileAttachment[],
		private readonly _shareWithOtherPane: () => void,
		private readonly _onDidClose: (hadFocus: boolean) => void,
		@IParadisMobileCanvasModel private readonly _model: IParadisMobileCanvasModel,
		@IParadisPaneTokenService private readonly _paneTokens: IParadisPaneTokenService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ILayoutService layoutService: ILayoutService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		this._container = layoutService.getContainer(dom.getWindow(_anchor));
		this._element = $('.paradis-browser-share-popover.paradis-simulator-share-popover.paradis-focus-none.paradis-overlay-popover');
		this._element.classList.add(PARADIS_POPOVER_MOTION_CLASS);
		this._element.tabIndex = -1;
		this._element.setAttribute('role', 'dialog');
		const title = localize('paradis.simulatorShare.popoverTitle', "この端末を使えるペイン");
		this._element.setAttribute('aria-label', title);
		dom.append(this._element, $('.pbs-header')).textContent = title;
		this._message = dom.append(this._element, $('.pbs-message'));
		this._message.setAttribute('role', 'status');
		this._message.hidden = true;
		this._list = dom.append(this._element, $('.pbs-list'));
		this._list.setAttribute('role', 'list');
		const footer = dom.append(this._element, $('.pbs-footer'));
		this._footerButton = dom.append(footer, $<HTMLButtonElement>('button.pbs-link'));
		this._footerButton.textContent = localize('paradis.simulatorShare.shareOther', "ほかのペインに渡す…");
		this._register(dom.addDisposableListener(this._footerButton, dom.EventType.CLICK, () => {
			this.dispose();
			this._shareWithOtherPane();
		}));

		this._render();
		this._register(this._model.onDidChange(() => this._render()));
		this._register(this._terminalService.onAnyInstanceTitleChange(() => this._render()));
		this._register(this._paneTokens.onDidChange(() => this._render()));

		this._container.appendChild(this._element);
		this._anchor.setAttribute('aria-expanded', 'true');
		this._layout();
		this._registerListeners();
		(this._rowButtons[0] ?? this._footerButton).focus();
	}

	private _terminalName(paneToken: string): string | undefined {
		const instanceId = this._paneTokens.getInstanceForToken(paneToken);
		return instanceId === undefined ? undefined : this._terminalService.getInstanceFromId(instanceId)?.title;
	}

	private _render(): void {
		if (this._disposed) {
			return;
		}
		const entries = this._entries();
		if (entries.length === 0) {
			this.dispose();
			return;
		}
		const focusedKey = this._rowButtons.find(button => dom.isActiveElement(button))?.dataset.key;
		const store = new DisposableStore();
		this._rowStore.value = store;
		dom.clearNode(this._list);
		this._rowButtons = [];
		for (const attachment of entries) {
			const row = dom.append(this._list, $('.pbs-row'));
			row.setAttribute('role', 'listitem');
			dom.append(row, $(`span.pbs-icon${ThemeIcon.asCSSSelector(Codicon.terminal)}`));
			const text = dom.append(row, $('.pbs-text'));
			const name = this._terminalName(attachment.paneToken) ?? localize('paradis.simulatorShare.paneMissing', "このウィンドウに無いペイン");
			dom.append(text, $('.pbs-name')).textContent = name;
			dom.append(text, $('.pbs-kind')).textContent = paradisSimulatorShareKindLabel(attachment);
			const button = dom.append(row, $<HTMLButtonElement>(`button.pbs-unshare${ThemeIcon.asCSSSelector(Codicon.close)}`));
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, localize('paradis.simulatorShare.unshare', "渡すのをやめる")));
			const key = `${attachment.paneToken}\n${attachment.deviceId}`;
			button.dataset.key = key;
			button.setAttribute('aria-label', localize('paradis.simulatorShare.unshareAria', "{0} に渡すのをやめる", name));
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._run(button, () => this._model.detach(attachment.paneToken, attachment.deviceId))));
			this._rowButtons.push(button);
		}
		if (focusedKey !== undefined) {
			(this._rowButtons.find(button => button.dataset.key === focusedKey) ?? this._rowButtons[0])?.focus();
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
				this._message.textContent = localize('paradis.simulatorShare.unshareFailed', "渡すのをやめられませんでした: {0}", toErrorMessage(error));
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
		// ▾ の右端に一覧の右端を揃える
		const anchorRight = anchorPosition.left - containerPosition.left + anchorPosition.width;
		const left = Math.min(Math.max(EDGE_MARGIN, anchorRight - width), Math.max(EDGE_MARGIN, containerPosition.width - width - EDGE_MARGIN));
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
				this.dispose();
			} else if (keyboardEvent.keyCode === KeyCode.Tab || keyboardEvent.keyCode === KeyCode.DownArrow || keyboardEvent.keyCode === KeyCode.UpArrow) {
				// フォーカスを一覧の中で回す（外へ逃がすと開いたまま別の場所へ移り、閉じ方が分からなくなる）
				this._moveFocus(keyboardEvent.keyCode === KeyCode.UpArrow || (keyboardEvent.keyCode === KeyCode.Tab && keyboardEvent.shiftKey));
				keyboardEvent.preventDefault();
			}
		}));
		this._register(paradisWatchPopoverDismiss(targetWindow, { element: this._element, anchor: this._anchor, close: () => this.dispose(), closeOnFocusOut: true, closeOnResize: true, closeOnBlur: true }));
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

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._anchor.setAttribute('aria-expanded', 'false');
		const hadFocus = dom.isAncestorOfActiveElement(this._element);
		paradisRemovePopoverElement(this._element);
		super.dispose();
		this._onDidClose(hadFocus);
	}
}
