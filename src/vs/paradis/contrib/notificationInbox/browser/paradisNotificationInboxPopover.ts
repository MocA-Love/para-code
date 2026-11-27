/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーのベルから開く受信箱。全スペースの完了・許可待ち・質問を1か所にため、行からペインへ移る。
//
// 中は 2 つの一覧に分かれる。「あなたの番」は「人が答えるもの」の台帳（humanAsk）の待ちをカードで出し、小さい問いは
// 行の中のボタンで、大きい問いは S のモーダル（paradisNotificationInboxAskDialog.ts）で答える。「通知」は今までの一覧
// （完了を含む記録。行を押すとペインへ移る）。
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
import { Disposable, DisposableMap, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { paradisCloseWhenModalOpens } from '../../../browser/paradisAnchoredPopover.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IParadisHumanAskEntry, IParadisHumanAskService, ParadisHumanAskAnswer } from '../../humanAsk/common/paradisHumanAsk.js';
import { IParadisInboxAskCard, IParadisInboxClampSize, paradisBuildInboxAskCard } from './paradisNotificationInboxAskCard.js';
import { paradisInboxAskRefusedText } from '../common/paradisNotificationInboxAsk.js';
import {
	IParadisInboxEntry,
	IParadisNotificationInboxService,
	PARADIS_NOTIFICATION_MENU_BAR_SETTING,
	paradisInboxEntryDetail,
	paradisInboxEntryLocation,
	paradisInboxKindLabel,
} from '../common/paradisNotificationInbox.js';

// カードと溢れの判定は paradisNotificationInboxAskCard.ts へ移した（チャット表示の会話の中からも使う）。前からの読み手のため、ここからも出す
export { measureParadisInboxClamp, paradisInboxClampOverflows } from './paradisNotificationInboxAskCard.js';
export type { IParadisInboxClampSize } from './paradisNotificationInboxAskCard.js';

const $ = dom.$;

const POPOVER_WIDTH = 460;
/** 画面の端との余白。 */
const EDGE_MARGIN = 8;
/** 開いている間に相対時刻（「3 分前」）を書き直す間隔（paradis-16-17）。 */
const TIME_REFRESH_INTERVAL = 60_000;
/** ほかの場所で答えられたカードを、答えを出したまま残す時間（押そうとした行が突然ずれないように、すぐには消さない）。 */
const SETTLED_LINGER = 4_000;
/** カードが増減して行が動いた直後に、ボタンを押しても送らない時間（動く前の行を押すつもりだった指を、別の行の「許可」に通さない）。 */
const SHIFT_GUARD = 600;

type ParadisInboxTab = 'asks' | 'notifications';


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
	/** 大きい問いのモーダルを開く。小窓はモーダルが開くと閉じるので、モーダルは開いた側（ベルの係）が持つ。 */
	readonly onOpenAsk?: (key: string, focusText: boolean) => void;
	/** 今の時刻（行が動いた直後の押し間違いの守り。テストで差し替える）。 */
	readonly now?: () => number;
	/** 行数を切り詰めた欄の、見えている高さと全体の高さ（描いた後の溢れの判定。テストで差し替える。既定は実物の DOM を測る）。 */
	readonly measureClamp?: (element: HTMLElement) => IParadisInboxClampSize | undefined;
}

/**
 * 受信箱のポップオーバー。台帳のスナップショットが変わるたびに描き直す。
 */
export class ParadisNotificationInboxPopover extends Disposable {

	private readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly list: HTMLElement;
	private readonly asks: HTMLElement;
	private readonly footer: HTMLElement;
	private readonly tabs: ParadisSegmented<ParadisInboxTab>;
	private readonly headerActions: HTMLElement;
	private tab: ParadisInboxTab;
	/** 「あなたの番」のカード（鍵 → カード）。台帳が変わっても、中身の変わらないカードは作り直さない（フォーカスを残す）。 */
	private readonly askCards = this._register(new DisposableMap<string, IParadisInboxAskCard>());
	/** この小窓に「待ち」として出したことのある鍵。開いている間に回答済みになったものだけ、答えを 1 行出して残す。 */
	private readonly shownWaiting = new Set<string>();
	/** 回答済みを出し終えて、一覧から消した鍵。 */
	private readonly dismissed = new Set<string>();
	private readonly lingerTimers = this._register(new DisposableMap<string, IDisposable>());
	/** ここから送って、台帳が受け取るのを待っている鍵と、送った時刻。 */
	private readonly sending = new Map<string, number>();
	/** ここから送って断られた鍵と、その理由の 1 行。 */
	private readonly refused = new Map<string, string>();
	private askOrder = '';
	/** 描いた後に中身が枠から溢れていた許可（行の中の許可を出さず、モーダルへ回す）。 */
	private readonly overflowing = new Set<string>();
	/** 「あなたの番」を一度描いた（その後に増えた・入れ替わったカードは、最初の 1 件でも少しの間ボタンを効かせない）。 */
	private asksRendered = false;
	private asksEmpty: HTMLElement | undefined;
	private guardUntil = 0;
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
		@IParadisHumanAskService private readonly humanAskService: IParadisHumanAskService,
	) {
		super();

		this.element = $('.paradis-notification-inbox-popover.paradis-overlay-popover.paradis-focus-none');
		this.element.tabIndex = -1;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('paradis.inbox.ariaLabel', "通知の受信箱"));
		this.header = dom.append(this.element, $('.pnip-header'));
		dom.append(this.header, $('span.pnip-title')).textContent = localize('paradis.inbox.title', "受信箱");
		// 待っているものがあれば「あなたの番」から開く
		this.tab = this.visibleAsks().length > 0 ? 'asks' : 'notifications';
		this.tabs = this._register(new ParadisSegmented<ParadisInboxTab>(this.header, {
			items: [{ value: 'asks', label: localize('paradis.inbox.tab.asks', "あなたの番") }, { value: 'notifications', label: localize('paradis.inbox.tab.notifications', "通知") }],
			value: this.tab,
			ariaLabel: localize('paradis.inbox.tabs', "受信箱の表示"),
		}));
		this.tabs.element.classList.add('pnip-tabs');
		this._register(this.tabs.onDidChange(tab => {
			this.tab = tab;
			this.render();
		}));
		dom.append(this.header, $('span.pnip-grow'));
		this.headerActions = dom.append(this.header, $('span.pnip-header-actions'));
		this.asks = dom.append(this.element, $('.pnip-list.pnip-asks'));
		this.asks.setAttribute('role', 'list');
		this.asks.setAttribute('aria-label', localize('paradis.inbox.asksAriaLabel', "あなたの番の一覧"));
		this.list = dom.append(this.element, $('.pnip-list.pnip-notifications'));
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
		// 開いている間は、待ちが届いても表示を勝手に切り替えない（押そうとした「通知」の行が、届いたカードのボタンに
		// 入れ替わるため）。届いたことは切り替えの「あなたの番」の件数で知らせる
		this._register(this.humanAskService.onDidChange(() => this.render()));
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
		for (const card of this.askCards.values()) {
			card.time.textContent = fromNow(card.askedAt, true);
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
		dom.clearNode(this.headerActions);
		dom.clearNode(this.list);
		dom.clearNode(this.footer);
		this.rows = [];
		this.times = [];

		const snapshot = this.inboxService.snapshot;

		// --- 見出し ---
		// 切り替えの文字に件数を入れる（切り替えの部品は文字だけを持つので、ボタンの文字を書き直す）。数は台帳の数え方
		// （待ちで、ほかの 1 件に寄せていないもの）。「通知」は未読があるときだけ点を出す
		const [asksTab, notificationsTab] = this.tabs.element.children;
		const waiting = this.humanAskService.snapshot.counts.total;
		asksTab.textContent = waiting > 0 ? localize('paradis.inbox.tab.asksCount', "あなたの番 {0}", waiting) : localize('paradis.inbox.tab.asks', "あなたの番");
		notificationsTab.classList.toggle('pnip-tab-unread', snapshot.unreadCount > 0);
		notificationsTab.setAttribute('aria-label', snapshot.unreadCount > 0
			? localize('paradis.inbox.tab.notificationsUnread', "通知（未読 {0}）", snapshot.unreadCount)
			: localize('paradis.inbox.tab.notifications', "通知"));
		this.asks.classList.toggle('pnip-hidden', this.tab !== 'asks');
		this.list.classList.toggle('pnip-hidden', this.tab !== 'notifications');
		this.renderAsks(focusWasInside);
		if (this.tab === 'notifications') {
			const unread = dom.append(this.headerActions, $('span.pnip-unread'));
			unread.textContent = localize('paradis.inbox.unreadCount', "未読 {0}", snapshot.unreadCount);
			const readAll = dom.append(this.headerActions, $('button.pnip-link')) as HTMLButtonElement;
			readAll.textContent = localize('paradis.inbox.markAllRead', "すべて既読にする");
			readAll.disabled = snapshot.unreadCount === 0;
			this.renderDisposables.add(dom.addDisposableListener(readAll, dom.EventType.CLICK, () => void this.inboxService.markAllRead()));
		}

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
		if (this.tab === 'asks') {
			dom.append(this.footer, $('span')).textContent = localize('paradis.inbox.asksFooter', "答えは元のペイン・項目・タスクへ送ります");
		} else if (isMacintosh || isWindows) {
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

	// ---- あなたの番 ------------------------------------------------------------------------------

	/**
	 * 一覧に出す台帳の 1 件。待ちのものと、この小窓に待ちとして出している間に回答済み・取り下げになったもの
	 * （答えを 1 行出して数秒残す）。ほかの 1 件に寄せたものは出さない。
	 */
	private visibleAsks(): IParadisHumanAskEntry[] {
		return this.humanAskService.snapshot.entries.filter(entry => entry.foldedInto === undefined && !this.dismissed.has(entry.key)
			&& (entry.state === 'waiting' || this.shownWaiting.has(entry.key)));
	}

	private renderAsks(focusWasInside: boolean): void {
		const entries = this.visibleAsks();
		const keys = new Set(entries.map(entry => entry.key));
		for (const key of [...this.askCards.keys()]) {
			if (!keys.has(key)) {
				this.askCards.deleteAndDispose(key);
				this.overflowing.delete(key);
				this.lingerTimers.deleteAndDispose(key);
				this.sending.delete(key);
				this.refused.delete(key);
			}
		}
		// 行が増減・入れ替わったり、カードの高さが変わったり（回答済みになってボタンが消える・注記の行が増える）したら、
		// 少しの間ボタンを効かせない。ここから送った分の「届けています」は、押した本人の操作なので数えない
		const order = entries.map(entry => `${entry.key} ${entry.state} ${entry.failedAt ?? ''} ${entry.questions.length} ${entry.actions.length}`).join('\n');
		if (order !== this.askOrder) {
			if (this.asksRendered) {
				this.guardUntil = (this.options.now ?? Date.now)() + SHIFT_GUARD;
			}
			this.askOrder = order;
		}
		this.asksRendered = true;
		this.asksEmpty?.remove();
		this.asksEmpty = undefined;
		if (entries.length === 0) {
			this.asksEmpty = dom.append(this.asks, $('.pnip-empty'));
			this.asksEmpty.textContent = localize('paradis.inbox.asksEmpty', "あなたの番はありません。エージェントの質問と許可の確認が、全スペースの分ここに並びます。");
		}
		let previous: Element | null = null;
		for (const entry of entries) {
			if (entry.state === 'waiting') {
				this.shownWaiting.add(entry.key);
				// 台帳が受け取った（届けている最中になった）・届かずに戻ってきたら、ここの「送っています」は役目を終える
				// （前の回答の「届かなかった」の印は、送った時刻より古いので見ない）
				if (entry.pending !== undefined || (entry.failedAt ?? 0) >= (this.sending.get(entry.key) ?? Infinity)) {
					this.sending.delete(entry.key);
				}
			} else if (!this.lingerTimers.has(entry.key)) {
				const key = entry.key;
				const timer = setTimeout(() => {
					this.dismissed.add(key);
					this.render();
				}, SETTLED_LINGER);
				this.lingerTimers.set(key, { dispose: () => clearTimeout(timer) });
			}
			const signature = JSON.stringify([entry, this.sending.has(entry.key), this.refused.get(entry.key), this.overflowing.has(entry.key)]);
			let card = this.askCards.get(entry.key);
			if (card === undefined || card.signature !== signature) {
				// 作り直すカードの中にフォーカスがあれば、同じ役目のボタンへ戻す
				const active = dom.getActiveElement();
				const focused = card !== undefined ? [...card.controls].find(([, control]) => control === active)?.[0] : undefined;
				const next = this.buildAskCard(entry, signature);
				if (card !== undefined) {
					card.element.replaceWith(next.element);
				}
				this.askCards.set(entry.key, next);
				card = next;
				if (focused !== undefined) {
					(card.controls.get(focused) ?? (focusWasInside ? this.element : undefined))?.focus();
				}
			}
			// 並びを台帳の順に合わせる（もう正しい位置にあるカードは動かさない。動かすとフォーカスが外れる）
			const expected: Element | null = previous === null ? this.asks.firstElementChild : previous.nextElementSibling;
			if (expected !== card.element) {
				this.asks.insertBefore(card.element, expected);
			}
			previous = card.element;
		}
		// 描いた後に中身が溢れた許可（全角の多いコマンドは見積もりより多く折り返す）は、行の中の許可を外して作り直す
		let overflowed = false;
		for (const [key, card] of this.askCards) {
			if (!this.overflowing.has(key) && card.overflows?.() === true) {
				this.overflowing.add(key);
				overflowed = true;
			}
		}
		if (overflowed) {
			this.renderAsks(focusWasInside);
		}
	}

	private buildAskCard(entry: IParadisHumanAskEntry, signature: string): IParadisInboxAskCard {
		return paradisBuildInboxAskCard(entry, signature, {
			sending: this.sending.has(entry.key),
			refused: this.refused.get(entry.key),
			overflowing: this.overflowing.has(entry.key),
			now: () => (this.options.now ?? Date.now)(),
			guardUntil: () => this.guardUntil,
			measureClamp: this.options.measureClamp,
			answer: (key, answer) => this.answer(key, answer),
			openAsk: (key, focusText) => this.options.onOpenAsk?.(key, focusText),
			revealPane: ask => {
				if (ask.paneKey !== undefined && ask.windowId !== undefined) {
					this.options.onClose();
					void this.inboxService.revealPane({ paneKey: ask.paneKey, windowId: ask.windowId, ...(ask.stateKey !== undefined ? { stateKey: ask.stateKey } : {}) });
				}
			},
		}, this.hoverService);
	}

	/** 行の中のボタンで答える。結果（断られた理由）はカードに 1 行出す。届いたかどうかは台帳の知らせで分かる。 */
	private answer(key: string, answer: ParadisHumanAskAnswer): void {
		if (this.sending.has(key)) {
			return;
		}
		this.sending.set(key, (this.options.now ?? Date.now)());
		this.refused.delete(key);
		this.render();
		void this.humanAskService.answer(key, answer, 'inbox').then(result => {
			if (this._store.isDisposed) {
				return;
			}
			if (!result.ok) {
				this.sending.delete(key);
				this.refused.set(key, paradisInboxAskRefusedText(result.reason));
			}
			this.render();
		});
	}

	// ---- 通知 -------------------------------------------------------------------------------------

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
