/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「スペース」のビューの「プロジェクト」の見出しの上に置く Bot の帯（Q686 の 1、モック bots-paradot-mock.html 第 3 版）。
// 作りはメモの帯と同じ: 見出し 22px（開閉の矢印・「BOT」・Bot の数・あなたの番の数の丸・右端の ＋）。開くと 28px の行が
// 並び、帯の中だけスクロールし、下の境の線で高さを変えられる。開閉と高さは覚える。閉じても、ピン留めした Bot の行だけは
// 見出しの下に残る（スペースのピン留めと同じ）。ピン留めは Bot の台帳（IParadisBot.pinned）に持つので、別の窓・スマホでも同じ。
//
// 行を押すと {@link PARADIS_BOTS_OPEN_COMMAND} を呼ぶ（Bot のページを開く。登録は paradisBotsLaunch.contribution.ts。Web のビューには
// 登録が無いので、無ければ何もしない）。
// 帯は paradisBots.contribution の electron-browser から登録するので、Web のビューには出ない。

import './media/paradisBotsBand.css';
import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';
import { IParadisWorkspacesBand } from '../../workspaceSwitch/browser/paradisWorkspacesBands.js';
import { IParadisBotSummary, IParadisBotsService, ParadisBotsServiceResult, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { IParadisBotsBandState, PARADIS_BOTS_BAND_SIZES, PARADIS_BOTS_BAND_STORAGE_KEY, PARADIS_BOTS_OPEN_COMMAND, paradisBotFace, paradisBotNameProblemMessage, paradisBotRowMenu, ParadisBotRowMenuItem, paradisBotsBandDraggedHeight, paradisBotsBandListHeight, paradisBotsBandRows, paradisBotStatusLine, paradisBotsNeedsYouTotal, paradisParseBotsBandState, paradisSerializeBotsBandState, paradisValidateBotName } from '../common/paradisBotsBandModel.js';
import { ParadisBotCreateDialog } from './paradisBotCreateDialog.js';
import { ParadisBotGroupDialog } from './paradisBotGroupDialog.js';
import { paradisRequestBotPageTab } from './paradisBotPageTabRequest.js';
import { IParadisBotGroup, paradisBotGroupMembers, paradisBotGroupUnreadCount } from '../common/paradisBotGroups.js';
import { IParadisBotGroupsService, PARADIS_BOTS_OPEN_GROUP_COMMAND } from '../common/paradisBotGroupsApi.js';
import { renderParadisBotFace } from './paradisBotFace.js';

const $ = DOM.$;
/**
 * ビューへ登録する帯の入れ物。設定 {@link PARADIS_BOTS_ENABLED_SETTING} がオンの間だけ {@link ParadisBotsBand} を作る。
 * オフの間は何も描かず、Bot のサービス（作られると shared process へつなぐ）にも触れない。
 */
export class ParadisBotsBandSlot extends Disposable implements IParadisWorkspacesBand {

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	private readonly band = this._register(new MutableDisposable<ParadisBotsBand>());
	private readonly bandListener = this._register(new MutableDisposable());
	private viewHeight = 0;

	constructor(
		private readonly container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.update();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
				this.update();
				this._onDidChangeHeight.fire();
			}
		}));
	}

	/** 帯を出しているか。 */
	get shown(): boolean {
		return this.band.value !== undefined;
	}

	private update(): void {
		const enabled = this.configurationService.getValue<boolean>(PARADIS_BOTS_ENABLED_SETTING) === true;
		if (enabled === this.shown) {
			return;
		}
		if (enabled) {
			const band = this.instantiationService.createInstance(ParadisBotsBand, this.container);
			this.band.value = band;
			this.bandListener.value = band.onDidChangeHeight(() => this._onDidChangeHeight.fire());
			band.layout(this.viewHeight);
		} else {
			this.bandListener.clear();
			this.band.clear();
		}
	}

	layout(viewHeight: number): boolean {
		this.viewHeight = viewHeight;
		return this.band.value?.layout(viewHeight) ?? false;
	}
}

export class ParadisBotsBand extends Disposable implements IParadisWorkspacesBand {

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	private readonly root: HTMLElement;
	private readonly toggle: HTMLElement;
	private readonly twistie: HTMLElement;
	private readonly count: HTMLElement;
	private readonly badge: HTMLElement;
	private readonly list: HTMLElement;
	private readonly sash: Sash;
	private readonly rowDisposables = this._register(new DisposableStore());
	/** 今出している行（上下の矢印で動く先）。 */
	private rowElements: HTMLElement[] = [];

	private state: IParadisBotsBandState;
	private viewHeight = 0;
	private appliedHeight = -1;
	/** 作ったばかりで、一覧に現れたら送って見せる Bot。 */
	private revealBotId: string | undefined;
	/** 作ったばかりで、一覧に現れたら送って見せるグループ。 */
	private revealGroupId: string | undefined;
	/** 描き直しをまたいでフォーカスを戻す行。 */
	private focusedBotId: string | undefined;

	constructor(
		container: HTMLElement,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IParadisBotGroupsService private readonly groupsService: IParadisBotGroupsService,
	) {
		super();
		this.state = paradisParseBotsBandState(this.storageService.get(PARADIS_BOTS_BAND_STORAGE_KEY, StorageScope.APPLICATION));

		this.root = DOM.append(container, $('.paradis-bots-band'));
		const header = DOM.append(this.root, $('.paradis-bots-band-header'));
		// 開閉の役は見出しの左側だけ（＋ のボタンを中に入れない。読み上げで中のボタンに届かなくなる）
		this.toggle = DOM.append(header, $('.paradis-bots-band-toggle.paradis-focus-ring-inset'));
		this.toggle.tabIndex = 0;
		this.toggle.setAttribute('role', 'button');
		this.twistie = DOM.append(this.toggle, $('.codicon'));
		DOM.append(this.toggle, $('span.paradis-bots-band-title')).textContent = localize('paradis.bots.band.title', "Bot");
		this.count = DOM.append(this.toggle, $('span.paradis-bots-band-count'));
		this.badge = DOM.append(this.toggle, $('span.paradis-bots-band-badge'));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), this.badge, localize('paradis.bots.band.needsYou', "あなたの番")));
		this._register(DOM.addDisposableListener(this.toggle, DOM.EventType.CLICK, () => this.setOpen(!this.state.open)));
		this._register(DOM.addDisposableListener(this.toggle, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				DOM.EventHelper.stop(e, true);
				this.setOpen(!this.state.open);
			}
		}));

		const add = DOM.append(header, $('.paradis-bots-band-add.paradis-focus-ring-inset'));
		const addLabel = localize('paradis.bots.band.add', "Bot かグループを作る");
		add.tabIndex = 0;
		add.setAttribute('role', 'button');
		add.setAttribute('aria-label', addLabel);
		DOM.append(add, $(ThemeIcon.asCSSSelector(Codicon.add)));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), add, addLabel));
		this._register(DOM.addDisposableListener(add, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this.showAddMenu(add);
		}));
		this._register(DOM.addDisposableListener(add, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				DOM.EventHelper.stop(e, true);
				this.showAddMenu(add);
			}
		}));

		this.list = DOM.append(this.root, $('.paradis-bots-band-list'));
		this.list.setAttribute('role', 'list');
		this.list.setAttribute('aria-label', localize('paradis.bots.band.listLabel', "Bot の一覧"));

		this.sash = this._register(new Sash(this.root, { getHorizontalSashTop: () => this.root.offsetHeight }, { orientation: Orientation.HORIZONTAL }));
		let sashStart: number | undefined;
		this._register(this.sash.onDidStart(() => sashStart = this.list.offsetHeight));
		this._register(this.sash.onDidChange(event => {
			if (sashStart === undefined) {
				return;
			}
			// 下へ引くと一覧が広がる
			this.state = { ...this.state, listHeight: paradisBotsBandDraggedHeight(sashStart, event.currentY - event.startY) };
			this.applyAndNotify();
		}));
		this._register(this.sash.onDidEnd(() => {
			sashStart = undefined;
			this.persist();
		}));

		this._register(this.botsService.onDidChange(() => this.render()));
		this._register(this.groupsService.onDidChange(() => this.render()));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PARADIS_BOTS_BAND_STORAGE_KEY, this._store)(() => {
			// ほかの窓で開閉・高さを変えた
			const next = paradisParseBotsBandState(this.storageService.get(PARADIS_BOTS_BAND_STORAGE_KEY, StorageScope.APPLICATION));
			if (next.open !== this.state.open || next.listHeight !== this.state.listHeight) {
				this.state = next;
				this.render();
			}
		}));
		this.render();
	}

	override dispose(): void {
		// 設定をオフにしたら帯ごと外す
		this.root.remove();
		super.dispose();
	}

	private get bots(): readonly IParadisBotSummary[] {
		return this.botsService.snapshot.bots;
	}

	layout(viewHeight: number): boolean {
		this.viewHeight = viewHeight;
		return this.applyHeight();
	}

	/** 一覧の高さを入れる。帯の高さが変わったら true。 */
	private applyHeight(): boolean {
		const rows = paradisBotsBandRows(this.bots, this.state.open).length + this.groupRowCount();
		const listHeight = paradisBotsBandListHeight(this.state, rows, this.viewHeight);
		this.list.style.height = `${listHeight}px`;
		this.list.classList.toggle('hidden', listHeight === 0);
		this.sash.state = this.state.open && rows > 0 ? SashState.Enabled : SashState.Disabled;
		this.sash.layout();
		const height = PARADIS_BOTS_BAND_SIZES.header + listHeight;
		const changed = height !== this.appliedHeight;
		this.appliedHeight = height;
		return changed;
	}

	private applyAndNotify(): void {
		if (this.applyHeight()) {
			this._onDidChangeHeight.fire();
		}
	}

	private setOpen(open: boolean): void {
		if (this.state.open === open) {
			return;
		}
		this.state = { ...this.state, open };
		this.persist();
		this.render();
	}

	private persist(): void {
		this.storageService.store(PARADIS_BOTS_BAND_STORAGE_KEY, paradisSerializeBotsBandState(this.state), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private render(): void {
		const bots = this.bots;
		const open = this.state.open;
		this.root.classList.toggle('open', open);
		this.twistie.className = ThemeIcon.asClassName(open ? Codicon.chevronDown : Codicon.chevronRight);
		this.toggle.setAttribute('aria-expanded', String(open));
		this.toggle.setAttribute('aria-label', open ? localize('paradis.bots.band.collapse', "Bot の一覧を畳む") : localize('paradis.bots.band.expand', "Bot の一覧を開く"));
		this.count.textContent = String(bots.length);
		const needsYou = paradisBotsNeedsYouTotal(bots);
		this.badge.textContent = needsYou > 99 ? '99+' : String(needsYou);
		this.badge.classList.toggle('hidden', needsYou === 0);

		const active = DOM.getActiveElement();
		const hadFocus = DOM.isHTMLElement(active) && this.list.contains(active);
		this.rowDisposables.clear();
		DOM.clearNode(this.list);
		const rows = paradisBotsBandRows(bots, open);
		if (rows.length === 0 && open && this.visibleGroups().length === 0) {
			DOM.append(this.list, $('.paradis-bots-band-empty')).textContent = localize('paradis.bots.band.empty', "Bot はまだいません。＋ から作れます");
		}
		const elements = this.rowElements = rows.map((bot, index) => this.renderRow(bot, index === 0));
		const groups = this.visibleGroups();
		if (groups.length > 0) {
			DOM.append(this.list, $('.paradis-bots-band-section')).textContent = localize('paradis.bots.band.groups', "グループ");
			const groupRows = groups.map((group, index) => this.renderGroupRow(group, rows.length === 0 && index === 0));
			this.rowElements = [...elements, ...groupRows];
			// 作ったグループは、一覧の高さで隠れていても送って見せる
			const revealGroup = this.revealGroupId !== undefined ? groups.findIndex(group => group.id === this.revealGroupId) : -1;
			if (revealGroup >= 0) {
				this.revealGroupId = undefined;
				groupRows[revealGroup].scrollIntoView({ block: 'nearest' });
				this.focusRow(this.rowElements, elements.length + revealGroup);
			}
		}
		this.applyAndNotify();

		const reveal = this.revealBotId !== undefined ? rows.findIndex(bot => bot.id === this.revealBotId) : -1;
		if (reveal >= 0) {
			this.revealBotId = undefined;
			elements[reveal].scrollIntoView({ block: 'nearest' });
			this.focusRow(elements, reveal);
		} else if (hadFocus && this.focusedBotId !== undefined) {
			const index = rows.findIndex(bot => bot.id === this.focusedBotId);
			if (index >= 0) {
				this.focusRow(elements, index);
			}
		}
	}

	private focusRow(elements: readonly HTMLElement[], index: number): void {
		for (const [i, element] of elements.entries()) {
			element.tabIndex = i === index ? 0 : -1;
		}
		elements[index].focus({ preventScroll: true });
	}

	private renderRow(bot: IParadisBotSummary, first: boolean): HTMLElement {
		const row = DOM.append(this.list, $('.paradis-bots-row.paradis-focus-ring-inset'));
		row.setAttribute('role', 'listitem');
		row.tabIndex = first ? 0 : -1;
		row.dataset.botId = bot.id;
		row.classList.toggle('paused', bot.paused);
		const status = paradisBotStatusLine(bot);
		row.setAttribute('aria-label', localize('paradis.bots.row.ariaLabel', "{0}、{1}", bot.name, status));
		renderParadisBotFace(row, paradisBotFace(bot));
		DOM.append(row, $('span.paradis-bots-row-name')).textContent = bot.name;
		DOM.append(row, $('span.paradis-bots-row-status')).textContent = status;
		if (bot.needsYou > 0) {
			DOM.append(row, $('span.paradis-bots-row-count')).textContent = bot.needsYou > 99 ? '99+' : String(bot.needsYou);
		}
		// 受け箱の未読（ほかの Bot からの伝言）。押すと Bot のページの会話を開く（話しかけて読ませられるように）
		const unread = paradisBotGroupUnreadCount(this.groupsService.snapshot, bot.id);
		if (unread > 0) {
			const unreadLabel = localize('paradis.bots.row.unread', "受け箱にまだ読まれていない伝言が {0} 通あります", unread);
			const chip = DOM.append(row, $('span.paradis-bots-row-unread.paradis-focus-ring-inset'));
			chip.setAttribute('role', 'button');
			chip.setAttribute('aria-label', unreadLabel);
			// キーボードでも押せるようにする（Enter・Space は行の「開く」ではなく、この印の「会話のタブで開く」に使う）
			chip.tabIndex = 0;
			DOM.append(chip, $(ThemeIcon.asCSSSelector(Codicon.mail)));
			DOM.append(chip, $('span')).textContent = unread > 99 ? '99+' : String(unread);
			this.rowDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), chip, unreadLabel));
			const openChat = () => {
				paradisRequestBotPageTab(bot.id, 'chat');
				this.open(bot);
			};
			this.rowDisposables.add(DOM.addDisposableListener(chip, DOM.EventType.CLICK, e => {
				DOM.EventHelper.stop(e, true);
				openChat();
			}));
			this.rowDisposables.add(DOM.addDisposableListener(chip, DOM.EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
					DOM.EventHelper.stop(e, true);
					openChat();
				}
			}));
		}

		// ピンの留め外し（スペースの行の .paradis-worktree-pin と同じ見た目。行を押したことにしない）
		const pinned = bot.pinned === true;
		const pin = DOM.append(row, $('.paradis-bots-row-pin'));
		pin.classList.toggle('pinned', pinned);
		pin.setAttribute('role', 'button');
		const pinLabel = pinned
			? localize('paradis.bots.row.unpinTooltip', "ピン留めを解除")
			: localize('paradis.bots.row.pinTooltip', "ピン留めする（Bot の帯を閉じても表示したままにする）");
		pin.setAttribute('aria-label', pinLabel);
		DOM.append(pin, $(ThemeIcon.asCSSSelector(pinned ? Codicon.pinned : Codicon.pin)));
		this.rowDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), pin, pinLabel));
		this.rowDisposables.add(DOM.addDisposableListener(pin, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			void this.setPinned(bot, !pinned);
		}));

		this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.FOCUS, () => this.focusedBotId = bot.id));
		this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => this.open(bot)));
		this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CONTEXT_MENU, e => {
			DOM.EventHelper.stop(e, true);
			const event = new StandardMouseEvent(DOM.getWindow(row), e);
			this.contextMenuService.showContextMenu({ getAnchor: () => event, getActions: () => this.rowActions(bot) });
		}));
		this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				DOM.EventHelper.stop(e, true);
				this.open(bot);
				return;
			}
			this.moveFocus(e, row);
		}));
		return row;
	}

	/** 上下の矢印・Home・End で、Bot とグループの行をまたいで動く。 */
	private moveFocus(e: KeyboardEvent, row: HTMLElement): void {
		const event = new StandardKeyboardEvent(e);
		const rows = this.rowElements;
		const index = rows.indexOf(row);
		const next = event.equals(KeyCode.DownArrow) ? Math.min(rows.length - 1, index + 1)
			: event.equals(KeyCode.UpArrow) ? Math.max(0, index - 1)
				: event.equals(KeyCode.Home) ? 0
					: event.equals(KeyCode.End) ? rows.length - 1
						: -1;
		if (next >= 0) {
			DOM.EventHelper.stop(e, true);
			this.focusRow(rows, next);
		}
	}

	private open(bot: IParadisBotSummary): void {
		if (CommandsRegistry.getCommand(PARADIS_BOTS_OPEN_COMMAND)) {
			void this.commandService.executeCommand(PARADIS_BOTS_OPEN_COMMAND, bot.id);
		}
	}

	private rowActions(bot: IParadisBotSummary): IAction[] {
		return paradisBotRowMenu(bot).map(item => item === '-' ? new Separator() : this.rowAction(bot, item));
	}

	private rowAction(bot: IParadisBotSummary, item: ParadisBotRowMenuItem): IAction {
		switch (item) {
			case 'pin': return new Action('paradis.bots.row.pin', localize('paradis.bots.row.pin', "ピン留め"), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.pin)}`, true, () => this.setPinned(bot, true));
			case 'unpin': return new Action('paradis.bots.row.unpin', localize('paradis.bots.row.unpin', "ピン留めを解除"), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.pinned)}`, true, () => this.setPinned(bot, false));
			case 'rename': return new Action('paradis.bots.row.rename', localize('paradis.bots.row.rename', "名前を変更..."), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.edit)}`, true, () => this.rename(bot));
			case 'pause': return new Action('paradis.bots.row.pause', localize('paradis.bots.row.pause', "停止"), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.stopCircle)}`, true, () => this.setPaused(bot, true));
			case 'resume': return new Action('paradis.bots.row.resume', localize('paradis.bots.row.resume', "再開"), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.play)}`, true, () => this.setPaused(bot, false));
			case 'remove': return new Action('paradis.bots.row.remove', localize('paradis.bots.row.remove', "削除..."), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.trash)}`, true, () => this.remove(bot));
		}
	}

	private async setPinned(bot: IParadisBotSummary, pinned: boolean): Promise<void> {
		this.report(await this.botsService.updateBot(bot.id, { pinned }));
	}

	private async setPaused(bot: IParadisBotSummary, paused: boolean): Promise<void> {
		const result = await this.botsService.updateBot(bot.id, { paused });
		if (this.report(result) && paused) {
			// 一時停止中は起動しない。動いているペインがあれば閉じてもらう
			await this.botsService.requestStop(bot.id);
		}
	}

	private async rename(bot: IParadisBotSummary): Promise<void> {
		const value = await this.quickInputService.input({
			title: localize('paradis.bots.rename.title', "Bot の名前を変更"),
			value: bot.name,
			validateInput: async input => {
				const checked = paradisValidateBotName(input, this.bots, bot.id);
				return checked.ok ? undefined : paradisBotNameProblemMessage(checked.problem);
			},
		});
		if (value === undefined) {
			return;
		}
		const checked = paradisValidateBotName(value, this.bots, bot.id);
		if (checked.ok && checked.name !== bot.name) {
			this.report(await this.botsService.updateBot(bot.id, { name: checked.name }));
		}
	}

	private async remove(bot: IParadisBotSummary): Promise<void> {
		const { confirmed } = await this.paradisDialogService.confirm({
			message: localize('paradis.bots.remove.message', "「{0}」を削除しますか?", bot.name),
			detail: localize('paradis.bots.remove.detail', "Bot を一覧から外し、この Bot の項目もコメントや回答ごと消します。記憶の整理の前に取った写しも消えます。元に戻せません。専用フォルダの人格メモと記憶は消さずに残します。"),
			primaryButton: localize('paradis.bots.remove.confirm', "削除"),
			destructive: true,
		});
		if (confirmed) {
			this.report(await this.botsService.removeBot(bot.id));
		}
	}

	/** 断られたら知らせる。通れば true。 */
	private report(result: ParadisBotsServiceResult<unknown>): boolean {
		if (!result.ok) {
			this.notificationService.error(localize('paradis.bots.failed', "Bot を変更できませんでした: {0}", result.message));
		}
		return result.ok;
	}

	/** 開いているときだけ出すグループ（ピン留めは無い）。 */
	private visibleGroups(): readonly IParadisBotGroup[] {
		return this.state.open ? this.groupsService.snapshot.groups : [];
	}

	/** グループの行と、その上の見出しの行の数。 */
	private groupRowCount(): number {
		const count = this.visibleGroups().length;
		return count > 0 ? count + 1 : 0;
	}

	private renderGroupRow(group: IParadisBotGroup, first: boolean): HTMLElement {
		const bots = this.bots;
		const members = paradisBotGroupMembers(group, new Set(bots.map(bot => bot.id))).map(id => bots.find(bot => bot.id === id)!);
		const row = DOM.append(this.list, $('.paradis-bots-row.paradis-bots-group-row.paradis-focus-ring-inset'));
		row.setAttribute('role', 'listitem');
		row.tabIndex = first ? 0 : -1;
		row.dataset.groupId = group.id;
		const faces = DOM.append(row, $('span.paradis-bots-group-faces'));
		for (const bot of members.slice(0, 3)) {
			renderParadisBotFace(faces, paradisBotFace(bot));
		}
		const names = members.map(bot => bot.name).join('・');
		DOM.append(row, $('span.paradis-bots-row-name')).textContent = group.name;
		DOM.append(row, $('span.paradis-bots-row-status')).textContent = names;
		row.setAttribute('aria-label', localize('paradis.bots.groupRow.ariaLabel', "グループ {0}、{1}", group.name, names));
		const open = () => void this.commandService.executeCommand(PARADIS_BOTS_OPEN_GROUP_COMMAND, group.id);
		this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, open));
		this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CONTEXT_MENU, e => {
			DOM.EventHelper.stop(e, true);
			const event = new StandardMouseEvent(DOM.getWindow(row), e);
			this.contextMenuService.showContextMenu({ getAnchor: () => event, getActions: () => this.groupActions(group, row) });
		}));
		this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				DOM.EventHelper.stop(e, true);
				open();
				return;
			}
			this.moveFocus(e, row);
		}));
		return row;
	}

	private groupActions(group: IParadisBotGroup, row: HTMLElement): IAction[] {
		return [
			new Action('paradis.bots.group.open', localize('paradis.bots.group.open', "開く"), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.commentDiscussion)}`, true, () => this.commandService.executeCommand(PARADIS_BOTS_OPEN_GROUP_COMMAND, group.id)),
			new Separator(),
			new Action('paradis.bots.group.edit', localize('paradis.bots.group.edit', "グループを変える..."), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.edit)}`, true, async () => this.instantiationService.createInstance(ParadisBotGroupDialog, row, group, () => undefined)),
			new Action('paradis.bots.group.remove', localize('paradis.bots.group.remove', "グループを削除..."), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.trash)}`, true, () => this.removeGroup(group)),
		];
	}

	private async removeGroup(group: IParadisBotGroup): Promise<void> {
		const { confirmed } = await this.paradisDialogService.confirm({
			message: localize('paradis.bots.group.removeMessage', "グループ「{0}」を削除しますか?", group.name),
			detail: localize('paradis.bots.group.removeDetail', "グループとその記録を消します。メンバーの Bot と項目は残ります。"),
			primaryButton: localize('paradis.bots.group.removeConfirm', "削除"),
			destructive: true,
		});
		if (confirmed) {
			this.report(await this.groupsService.removeGroup(group.id));
		}
	}

	private showAddMenu(anchor: HTMLElement): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				new Action('paradis.bots.add.bot', localize('paradis.bots.band.create', "新しい Bot..."), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.add)}`, true, async () => this.openCreateDialog(anchor)),
				new Action('paradis.bots.add.template', localize('paradis.bots.band.fromTemplate', "テンプレートから選ぶ..."), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.library)}`, true, async () => this.openCreateDialog(anchor, true)),
				new Action('paradis.bots.add.group', localize('paradis.bots.band.createGroup', "新しいグループ..."), `paradis-menu-icon ${ThemeIcon.asClassName(Codicon.commentDiscussion)}`, this.bots.length >= 2, async () => this.openGroupDialog(anchor)),
			],
		});
	}

	private openGroupDialog(anchor: HTMLElement): void {
		this.instantiationService.createInstance(ParadisBotGroupDialog, anchor, undefined, (groupId: string) => {
			this.revealGroupId = groupId;
			if (!this.state.open) {
				this.state = { ...this.state, open: true };
				this.persist();
			}
			this.render();
		});
	}

	private openCreateDialog(anchor: HTMLElement, openTemplates = false): void {
		this.instantiationService.createInstance(ParadisBotCreateDialog, anchor, (botId: string) => {
			// 作ったら帯を開き、新しい行まで送る（行は台帳の知らせで現れる）
			this.revealBotId = botId;
			if (!this.state.open) {
				this.state = { ...this.state, open: true };
				this.persist();
			}
			this.render();
		}, openTemplates);
	}
}
