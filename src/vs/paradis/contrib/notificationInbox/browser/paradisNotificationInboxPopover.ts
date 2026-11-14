/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーのベルから開く受信箱。全スペースの完了・許可待ち・質問を1か所にため、行からペインへ移る。
//
// 作りはサービスステータスのポップオーバー（paradisServiceStatusPopover.ts）と同じ自前の DOM
// （position: fixed、layoutService.activeContainer 直下）。重なりは小窓の段（共通の印 `paradis-overlay-popover`、
// vs/paradis/browser/paradisModal.ts の表）で、ワークベンチの確認ダイアログ（2575）より下。内蔵ブラウザの上に出せるのも、
// この共通の印が overlayManager.ts の一覧に登録してあるため。

import './media/paradisNotificationInbox.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { paradisCloseWhenModalOpens } from '../../../browser/paradisAnchoredPopover.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import {
	IParadisInboxEntry,
	IParadisNotificationInboxService,
	PARADIS_NOTIFICATION_MENU_BAR_SETTING,
	paradisInboxEntryDetail,
	paradisInboxEntryLocation,
	paradisInboxKindLabel,
} from '../common/paradisNotificationInbox.js';

const $ = dom.$;

const POPOVER_WIDTH = 380;
/** 画面の端との余白。 */
const EDGE_MARGIN = 8;
/** 開いている間に相対時刻（「3 分前」）を書き直す間隔（paradis-16-17）。 */
const TIME_REFRESH_INTERVAL = 60_000;

/**
 * 受信箱のポップアップの左端と幅（px）。幅は既定の 380px か、ウィンドウの幅から両端の余白を引いた狭いほう
 * （ズームした小さいウィンドウや Web で、右へはみ出さないようにする）。ベルがあればベルの右端にそろえ、
 * 無ければウィンドウの右上に寄せる。
 */
export function paradisInboxPopoverPlacement(viewportWidth: number, anchorRight: number | undefined): { readonly left: number; readonly width: number } {
	const width = Math.max(0, Math.min(POPOVER_WIDTH, viewportWidth - EDGE_MARGIN * 2));
	const maxLeft = viewportWidth - width - EDGE_MARGIN;
	const left = anchorRight !== undefined ? Math.min(anchorRight - width, maxLeft) : maxLeft;
	return { left: Math.max(EDGE_MARGIN, left), width };
}

export interface IParadisNotificationInboxPopoverOptions {
	/** ベルのボタン。無ければ（ベルを隠している・コマンドから開いた）ウィンドウの右上に出す。 */
	readonly anchor: HTMLElement | undefined;
	readonly onClose: () => void;
}

/**
 * 受信箱のポップオーバー。台帳のスナップショットが変わるたびに描き直す。
 */
export class ParadisNotificationInboxPopover extends Disposable {

	private readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly list: HTMLElement;
	private readonly footer: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private rows: HTMLElement[] = [];
	/** 時刻の欄と、その行の通知。開いている間だけ 60 秒ごとに書き直す。 */
	private times: { readonly element: HTMLElement; readonly entry: IParadisInboxEntry }[] = [];
	/** Tab で止まる行（ロービング。paradis-16-14 案 A）。無ければ先頭の行。 */
	private currentEntryId: string | undefined;
	/** 右クリックのメニューを開いている間は、外側のクリックで閉じない（メニューは別の DOM にある）。 */
	private contextMenuOpen = false;
	/** 開く前にフォーカスがあった要素。閉じたらそこへ戻す（ターミナルで打っていた続きが消えないように）。 */
	private readonly previousFocus: Element | null;

	constructor(
		private readonly options: IParadisNotificationInboxPopoverOptions,
		@ILayoutService layoutService: ILayoutService,
		@IParadisNotificationInboxService private readonly inboxService: IParadisNotificationInboxService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.element = $('.paradis-notification-inbox-popover.paradis-overlay-popover.paradis-focus-none');
		this.element.tabIndex = -1;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('paradis.inbox.ariaLabel', "通知の受信箱"));
		this.header = dom.append(this.element, $('.pnip-header'));
		this.list = dom.append(this.element, $('.pnip-list'));
		// ダイアログと同じ名前だと、一覧に入るたびに同じ名前が二度読まれる
		this.list.setAttribute('aria-label', localize('paradis.inbox.listAriaLabel', "通知の一覧"));
		this.footer = dom.append(this.element, $('.pnip-footer'));

		this.previousFocus = dom.getActiveElement();
		const anchor = this.visibleAnchor();
		(anchor ? layoutService.getContainer(dom.getWindow(anchor)) : layoutService.activeContainer).appendChild(this.element);
		// 小窓はモーダルより上の段にあるので、モーダルが開いたら閉じる（幕の上に浮かせない）
		this._register(paradisCloseWhenModalOpens(this.element, () => this.options.onClose()));
		this.render();
		this.reposition();
		this.element.focus();

		this._register(this.inboxService.onDidChange(() => this.render()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_NOTIFICATION_MENU_BAR_SETTING)) {
				this.render();
			}
		}));
		const targetWindow = dom.getWindow(this.element);
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.RESIZE, () => this.reposition()));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_DOWN, e => this.onWindowMouseDown(e), true));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, e => this.onKeyDown(new StandardKeyboardEvent(e))));
		// 描き直すのは台帳が変わったときだけなので、時刻だけは別に進める（閉じたら dispose で止まる）
		this._register(new IntervalTimer()).cancelAndSet(() => this.refreshTimes(), TIME_REFRESH_INTERVAL, targetWindow);
	}

	override dispose(): void {
		const active = dom.getActiveElement();
		const hadFocus = !active || dom.isAncestor(active, this.element) || active === dom.getWindow(this.element).document.body;
		this.element.remove();
		if (hadFocus && dom.isHTMLElement(this.previousFocus) && this.previousFocus.isConnected) {
			this.previousFocus.focus();
		}
		super.dispose();
	}

	/** ベルが画面に出ているときだけ返す。狭い幅でタイトルバーのツールバーごと隠れていると大きさが 0 になる。 */
	private visibleAnchor(): HTMLElement | undefined {
		const anchor = this.options.anchor;
		if (!anchor || !anchor.isConnected) {
			return undefined;
		}
		const rect = anchor.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 ? anchor : undefined;
	}

	private onWindowMouseDown(e: MouseEvent): void {
		const node = e.target as Node | null;
		if (!node || this.contextMenuOpen || dom.isAncestor(node, this.element) || (this.options.anchor && dom.isAncestor(node, this.options.anchor))) {
			return;
		}
		this.options.onClose();
	}

	private onKeyDown(event: StandardKeyboardEvent): void {
		if (event.equals(KeyCode.Escape)) {
			event.preventDefault();
			this.options.onClose();
			return;
		}
		if (event.equals(KeyCode.DownArrow) || event.equals(KeyCode.UpArrow)) {
			event.preventDefault();
			const current = this.rows.findIndex(row => row === dom.getActiveElement());
			const next = event.equals(KeyCode.DownArrow)
				? Math.min(this.rows.length - 1, current + 1)
				: Math.max(0, current < 0 ? 0 : current - 1);
			this.rows[next]?.focus();
			return;
		}
		// 行の上だけ。下の段のチェックや見出しのボタンでは何もしない
		if ((event.equals(KeyCode.Home) || event.equals(KeyCode.End)) && this.rows.includes(dom.getActiveElement() as HTMLElement)) {
			event.preventDefault();
			this.rows[event.equals(KeyCode.Home) ? 0 : this.rows.length - 1]?.focus();
		}
	}

	/** フォーカスの来た行を、Tab で止まる行にする（他の行は tabIndex = -1）。 */
	private setCurrentRow(row: HTMLElement): void {
		this.currentEntryId = row.dataset.entryId;
		for (const candidate of this.rows) {
			const current = candidate === row;
			candidate.tabIndex = current ? 0 : -1;
			candidate.setAttribute('aria-selected', String(current));
		}
	}

	private refreshTimes(): void {
		for (const { element, entry } of this.times) {
			element.textContent = this.timeText(entry);
		}
	}

	private timeText(entry: IParadisInboxEntry): string {
		const time = fromNow(entry.at, true);
		return entry.kind === 'review'
			? localize('paradis.inbox.reviewTime', "完了 · {0}", time)
			: time;
	}

	private reposition(): void {
		const targetWindow = dom.getWindow(this.element);
		const anchor = this.visibleAnchor();
		// ベルの右端にそろえる（タイトルバーの中央寄りにあるので、左端にそろえると右へはみ出しやすい）。
		const rect = anchor?.getBoundingClientRect();
		const placement = paradisInboxPopoverPlacement(targetWindow.innerWidth, rect?.right);
		this.element.style.width = `${placement.width}px`;
		this.element.style.top = rect ? `${rect.bottom + 6}px` : '40px';
		this.element.style.left = `${placement.left}px`;
	}

	private render(): void {
		// 描き直しでフォーカスしていた行が消えないよう、同じ行へ戻す。
		const active = dom.getActiveElement();
		const focusedEntryId = active && dom.isAncestor(active, this.list) ? (active as HTMLElement).dataset.entryId : undefined;
		const focusWasInside = !!active && dom.isAncestor(active, this.element);
		this.renderDisposables.clear();
		const scrollTop = this.list.scrollTop;
		dom.clearNode(this.header);
		dom.clearNode(this.list);
		dom.clearNode(this.footer);
		this.rows = [];
		this.times = [];

		const snapshot = this.inboxService.snapshot;

		// --- 見出し ---
		dom.append(this.header, $('span.pnip-title')).textContent = localize('paradis.inbox.title', "受信箱");
		const unread = dom.append(this.header, $('span.pnip-unread'));
		unread.textContent = localize('paradis.inbox.unreadCount', "未読 {0}", snapshot.unreadCount);
		dom.append(this.header, $('span.pnip-grow'));
		const readAll = dom.append(this.header, $('button.pnip-link')) as HTMLButtonElement;
		readAll.textContent = localize('paradis.inbox.markAllRead', "すべて既読にする");
		readAll.disabled = snapshot.unreadCount === 0;
		this.renderDisposables.add(dom.addDisposableListener(readAll, dom.EventType.CLICK, () => void this.inboxService.markAllRead()));

		// --- 一覧 ---
		// 行を option にした listbox（paradis-16-14 案 A）。空のときは案内の文だけなので listbox にしない
		if (snapshot.entries.length > 0) {
			this.list.setAttribute('role', 'listbox');
		} else {
			this.list.removeAttribute('role');
		}
		if (snapshot.entries.length === 0) {
			const empty = dom.append(this.list, $('.pnip-empty'));
			empty.textContent = localize('paradis.inbox.empty', "通知はまだありません。エージェントの完了・許可待ち・質問が、全スペースの分ここにたまります。");
		}
		for (const entry of snapshot.entries) {
			this.renderRow(entry);
		}
		const currentRow = this.rows.find(row => row.dataset.entryId === this.currentEntryId) ?? this.rows[0];
		if (currentRow) {
			this.setCurrentRow(currentRow);
		}
		this.list.scrollTop = scrollTop;
		if (focusedEntryId !== undefined) {
			const row = this.rows.find(candidate => candidate.dataset.entryId === focusedEntryId);
			(row ?? this.element).focus();
		} else if (focusWasInside && !dom.isAncestor(dom.getActiveElement(), this.element)) {
			this.element.focus();
		}

		// --- 下の段 ---
		if (isMacintosh || isWindows) {
			const menuBar = dom.append(this.footer, $('label.pnip-menubar'));
			const checkbox = dom.append(menuBar, $('input')) as HTMLInputElement;
			checkbox.type = 'checkbox';
			checkbox.checked = this.configurationService.getValue<boolean>(PARADIS_NOTIFICATION_MENU_BAR_SETTING) === true;
			dom.append(menuBar, $('span')).textContent = isMacintosh
				? localize('paradis.inbox.menuBarToggle', "メニューバーにも表示する")
				: localize('paradis.inbox.trayToggle', "通知領域にも表示する");
			this.renderDisposables.add(dom.addDisposableListener(checkbox, dom.EventType.CHANGE, () => {
				void this.configurationService.updateValue(PARADIS_NOTIFICATION_MENU_BAR_SETTING, checkbox.checked);
			}));
		}
		dom.append(this.footer, $('span.pnip-grow'));
		const settings = dom.append(this.footer, $('button.pnip-link')) as HTMLButtonElement;
		settings.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.gear)}`));
		dom.append(settings, $('span')).textContent = localize('paradis.inbox.settings', "通知設定");
		this.renderDisposables.add(dom.addDisposableListener(settings, dom.EventType.CLICK, () => {
			this.options.onClose();
			void this.commandService.executeCommand('paradis.notifications.openSettings');
		}));
	}

	private renderRow(entry: IParadisInboxEntry): void {
		const row = dom.append(this.list, $('.pnip-row.paradis-focus-subtle'));
		row.tabIndex = -1;
		row.dataset.entryId = entry.id;
		row.setAttribute('role', 'option');
		row.classList.toggle('unread', !entry.read);
		row.classList.toggle('closed', !entry.live);
		this.rows.push(row);

		// 1 段目: スペース名と時刻。色の付いた札は対応が要るもの（許可待ち・質問）だけに付け、ありふれた「完了」は時刻の横の小さい文字にする。
		const top = dom.append(row, $('.pnip-row-top'));
		dom.append(top, $('span.pnip-dot')).setAttribute('aria-hidden', 'true');
		if (entry.kind !== 'review') {
			dom.append(top, $(`span.pnip-kind.${entry.kind}`)).textContent = paradisInboxKindLabel(entry.kind);
		}
		const space = dom.append(top, $('span.pnip-space'));
		space.textContent = entry.space;
		this.renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), space, paradisInboxEntryLocation(entry)));
		dom.append(top, $('span.pnip-grow'));
		const time = dom.append(top, $('span.pnip-time'));
		time.textContent = this.timeText(entry);
		this.times.push({ element: time, entry });
		// 相対時刻だけでは分からない日時をホバーで出す（paradis-16-17）
		this.renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), time, new Date(entry.at).toLocaleString()));

		// 2 段目: worktree とタブ（スペース名と区切りが混ざらないよう分けて出す）。
		const detail = paradisInboxEntryDetail(entry);
		if (detail) {
			dom.append(row, $('.pnip-detail')).textContent = detail;
		}

		if (entry.message) {
			// 本文は 1 行（許可待ち・質問は待っている内容が要点なので 2 行）で切れることがあるので、ホバーで全文を出す。
			const message = dom.append(row, $('.pnip-message'));
			message.textContent = entry.message;
			this.renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), message, entry.message));
		}
		const closedNote = entry.live ? undefined : localize('paradis.inbox.closedPane', "このペインは閉じています");
		if (closedNote) {
			dom.append(row, $('.pnip-note')).textContent = closedNote;
		}

		const state = entry.read ? localize('paradis.inbox.readState', "既読") : localize('paradis.inbox.unreadState', "未読");
		// 閉じたペインは押しても移動せず既読になるだけなので、そのことも名前に入れる。空の部分は入れない（末尾に空白を残さない）
		row.setAttribute('aria-label', [state, paradisInboxKindLabel(entry.kind), paradisInboxEntryLocation(entry), entry.message, closedNote].filter(part => !!part).join(' '));

		this.renderDisposables.add(dom.addDisposableListener(row, dom.EventType.FOCUS, () => this.setCurrentRow(row)));
		this.renderDisposables.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.open(entry)));
		this.renderDisposables.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				this.open(entry);
			} else if (event.equals(KeyCode.ContextMenu) || event.equals(KeyCode.Shift | KeyCode.F10)) {
				event.preventDefault();
				const rect = row.getBoundingClientRect();
				this.showContextMenu(entry, { x: rect.left + 16, y: rect.bottom });
			}
		}));
		this.renderDisposables.add(dom.addDisposableListener(row, dom.EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this.showContextMenu(entry, { x: e.clientX, y: e.clientY });
		}));
	}

	/** 行を押した。開いているペインならそこへ移動して閉じる。閉じたペインは既読にするだけ。 */
	private open(entry: IParadisInboxEntry): void {
		if (!entry.live) {
			void this.inboxService.markRead([entry.id]);
			return;
		}
		this.options.onClose();
		void this.inboxService.reveal(entry);
	}

	private showContextMenu(entry: IParadisInboxEntry, anchor: { x: number; y: number }): void {
		const actions: IAction[] = [
			toAction({
				id: 'paradis.inbox.reveal',
				label: localize('paradis.inbox.reveal', "このペインへ移動"),
				enabled: entry.live,
				run: () => this.open(entry),
			}),
			// 件数はペイン単位なので、既読もペイン単位にそろえる（1行だけ既読にしても件数が減らないため）。
			entry.read
				? toAction({ id: 'paradis.inbox.markUnread', label: localize('paradis.inbox.markUnread', "未読に戻す"), run: () => this.inboxService.markUnread(entry.id) })
				: toAction({ id: 'paradis.inbox.markPaneRead', label: localize('paradis.inbox.markPaneRead', "このペインの通知を既読にする"), run: () => this.inboxService.markPanesRead([entry.paneKey]) }),
			new Separator(),
			toAction({ id: 'paradis.inbox.remove', label: localize('paradis.inbox.remove', "一覧から消す"), run: () => this.inboxService.remove(entry.id) }),
		];
		this.contextMenuOpen = true;
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			onHide: () => {
				this.contextMenuOpen = false;
				if (!this._store.isDisposed) {
					this.element.focus();
				}
			},
		});
	}
}
