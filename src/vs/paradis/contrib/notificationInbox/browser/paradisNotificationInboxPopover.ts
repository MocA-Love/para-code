/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーのベルから開く受信箱（q.html Q33 案A）。
//
// 作りはサービスステータスのポップオーバー（paradisServiceStatusPopover.ts）と同じ自前の DOM
// （position: fixed、layoutService.activeContainer 直下、z-index 2500）。ワークベンチのモーダル（2575）
// より上には上げない（上げると承認ダイアログなどを隠す）。内蔵ブラウザの上に出すため、クラス名
// `paradis-notification-inbox-popover` を overlayManager.ts の一覧に登録してある。

import './media/paradisNotificationInbox.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import {
	IParadisInboxEntry,
	IParadisNotificationInboxService,
	PARADIS_NOTIFICATION_MENU_BAR_SETTING,
	paradisInboxEntryLocation,
	paradisInboxKindLabel,
} from '../common/paradisNotificationInbox.js';

const $ = dom.$;

const POPOVER_WIDTH = 380;
/** 画面の端との余白。 */
const EDGE_MARGIN = 8;

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
	/** 右クリックのメニューを開いている間は、外側のクリックで閉じない（メニューは別の DOM にある）。 */
	private contextMenuOpen = false;

	constructor(
		private readonly options: IParadisNotificationInboxPopoverOptions,
		@ILayoutService layoutService: ILayoutService,
		@IParadisNotificationInboxService private readonly inboxService: IParadisNotificationInboxService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.element = $('.paradis-notification-inbox-popover');
		this.element.style.width = `${POPOVER_WIDTH}px`;
		this.element.tabIndex = -1;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('paradis.inbox.ariaLabel', "通知の受信箱"));
		this.header = dom.append(this.element, $('.pnip-header'));
		this.list = dom.append(this.element, $('.pnip-list'));
		this.list.setAttribute('role', 'list');
		this.footer = dom.append(this.element, $('.pnip-footer'));

		layoutService.activeContainer.appendChild(this.element);
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
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
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
		}
	}

	private reposition(): void {
		const targetWindow = dom.getWindow(this.element);
		const maxLeft = targetWindow.innerWidth - POPOVER_WIDTH - EDGE_MARGIN;
		if (this.options.anchor && this.options.anchor.isConnected) {
			const rect = this.options.anchor.getBoundingClientRect();
			// ベルの右端にそろえる（タイトルバーの中央寄りにあるので、左端にそろえると右へはみ出しやすい）。
			const left = Math.max(EDGE_MARGIN, Math.min(rect.right - POPOVER_WIDTH, maxLeft));
			this.element.style.top = `${rect.bottom + 6}px`;
			this.element.style.left = `${left}px`;
		} else {
			this.element.style.top = '40px';
			this.element.style.left = `${Math.max(EDGE_MARGIN, maxLeft)}px`;
		}
	}

	private render(): void {
		this.renderDisposables.clear();
		const scrollTop = this.list.scrollTop;
		dom.clearNode(this.header);
		dom.clearNode(this.list);
		dom.clearNode(this.footer);
		this.rows = [];

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
		if (snapshot.entries.length === 0) {
			const empty = dom.append(this.list, $('.pnip-empty'));
			empty.textContent = localize('paradis.inbox.empty', "通知はまだありません。エージェントの完了・許可待ち・質問が、全スペースの分ここにたまります。");
		}
		for (const entry of snapshot.entries) {
			this.renderRow(entry);
		}
		this.list.scrollTop = scrollTop;

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
		const row = dom.append(this.list, $('.pnip-row'));
		row.tabIndex = 0;
		row.setAttribute('role', 'listitem');
		row.classList.toggle('unread', !entry.read);
		row.classList.toggle('closed', !entry.live);
		this.rows.push(row);

		const top = dom.append(row, $('.pnip-row-top'));
		dom.append(top, $('span.pnip-dot')).setAttribute('aria-hidden', 'true');
		const chip = dom.append(top, $(`span.pnip-kind.${entry.kind}`));
		chip.textContent = paradisInboxKindLabel(entry.kind);
		const location = dom.append(top, $('span.pnip-location'));
		location.textContent = paradisInboxEntryLocation(entry);
		dom.append(top, $('span.pnip-time')).textContent = fromNow(entry.at, true);

		if (entry.message) {
			dom.append(row, $('.pnip-message')).textContent = entry.message;
		}
		if (!entry.live) {
			dom.append(row, $('.pnip-note')).textContent = localize('paradis.inbox.closedPane', "このペインは閉じています");
		}

		const state = entry.read ? localize('paradis.inbox.readState', "既読") : localize('paradis.inbox.unreadState', "未読");
		row.setAttribute('aria-label', `${state} ${paradisInboxKindLabel(entry.kind)} ${location.textContent} ${entry.message ?? ''}`);

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
			entry.read
				? toAction({ id: 'paradis.inbox.markUnread', label: localize('paradis.inbox.markUnread', "未読に戻す"), run: () => this.inboxService.markUnread(entry.id) })
				: toAction({ id: 'paradis.inbox.markRead', label: localize('paradis.inbox.markRead', "既読にする"), run: () => this.inboxService.markRead([entry.id]) }),
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
