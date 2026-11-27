/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページ（設計の PR 10、Q686 の 2 の置き方 (ii)「1 つのタブで会話が主、上のタブで 項目…」）。
//
// Bot のターミナルのエディタのタブに重ねる（エディタのターミナルへの重ね合わせの口 paradisRegisterEditorTerminalOverlay）。
// タブの上端に Bot の顔・名前・上のタブ（会話・項目）の帯を置き、「会話」では下にある今のチャット表示（かターミナル）を
// そのまま見せる。入力・許可・質問の経路には触れない。「項目」では会話の上に項目の一覧と項目のページの面を重ねる。
//
// 「あなたの番」の項目では Bot の問いだけを扱い（ツールの許可は出さない。許可はペインのチャット表示と受信箱）、答えは
// 「聞く・答える」の台帳へ送る（受信箱と同じ道。台帳が項目のコメントにして Bot へ届ける）。
//
// 重ねる先のタブは、Bot のペインのときだけ帯を出す（どのペインが Bot のものかは {@link IParadisBotPaneResolver}）。
// タブが別のペインに替わった・ペインが終わった・タブを閉じたときは、帯も面も外す。

import './media/paradisBotPage.css';
import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { IParadisEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';
import { IParadisHumanAskService, ParadisHumanAskAnswer, paradisHumanAskKey } from '../../humanAsk/common/paradisHumanAsk.js';
import { IParadisInboxAskCardOptions, PARADIS_INBOX_ASK_SCOPE_CLASS, paradisBuildInboxAskCard } from '../../notificationInbox/browser/paradisNotificationInboxAskCard.js';
import { ParadisInboxAskDialog } from '../../notificationInbox/browser/paradisNotificationInboxAskDialog.js';
import { paradisInboxAskRefusedText } from '../../notificationInbox/common/paradisNotificationInboxAsk.js';
import { paradisBotAskId } from '../common/paradisBotAsk.js';
import { IParadisBotItem, IParadisBotItemLink, paradisBotItemWaitsForOwner, paradisIsBotItemClosed, paradisIsBotItemLocked, paradisIsBotItemSnoozed } from '../common/paradisBotItems.js';
import { IParadisBotSummary, IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { paradisBotFace, paradisBotStatusLine } from '../common/paradisBotsBandModel.js';
import { paradisBotItemEventLabel, paradisBotItemGroups, paradisBotItemStatusLabel, PARADIS_BOT_PAGE_TABS, ParadisBotPageTab } from '../common/paradisBotPageModel.js';
import { ParadisBotSettingsPanel } from './paradisBotPageSettings.js';
import { renderParadisBotFace } from './paradisBotFace.js';

const $ = DOM.$;

/** どのペインが Bot のものかを答える。トークンの値は出さず、ハッシュで照らす（electron-browser の実装）。 */
export interface IParadisBotPaneResolver {
	/** Bot のペインの組み合わせが変わったかもしれない（Bot の増減・ペインの起動と終了）。 */
	readonly onDidChange: Event<void>;
	botFor(instanceId: number): Promise<string | undefined>;
}

/** 帯を重ねたターミナルの入れ物に付ける印（CSS で、下の会話を帯の分だけ下げる）。 */
const ACTIVE_CLASS = 'paradis-bot-page-active';
/** 項目の面を出している間の印（下の会話とターミナルを隠す）。 */
const ITEMS_CLASS = 'paradis-bot-page-items';

/** 後回しの期限の選択肢（時間）。 */
const SNOOZE_HOURS: readonly { readonly hours: number; readonly label: string }[] = [
	{ hours: 1, label: localize('paradis.botPage.snooze1h', "1 時間") },
	{ hours: 24, label: localize('paradis.botPage.snooze1d', "明日まで") },
	{ hours: 24 * 7, label: localize('paradis.botPage.snooze1w', "1 週間") },
];

function clock(time: number): string {
	const date = new Date(time);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 項目のリンクの行き先（PR は GitHub、URL はそのまま。専用フォルダのファイルは開かない）。 */
function linkTarget(link: IParadisBotItemLink): URI | undefined {
	if (link.kind === 'url' && /^https?:\/\//.test(link.ref)) {
		return URI.parse(link.ref);
	}
	const pr = link.kind === 'pr' ? /^(?<repo>[\w.-]+\/[\w.-]+)#(?<number>\d+)$/.exec(link.ref) : undefined;
	return pr?.groups ? URI.parse(`https://github.com/${pr.groups.repo}/pull/${pr.groups.number}`) : undefined;
}

/** 問いのカードが出た・替わった直後に、答えを送るボタンを効かせない時間（受信箱・チャット表示と同じ 0.6 秒）。 */
const ASK_GUARD_MS = 600;

/** 問いのカードの、ここで持つ状態（送っている最中・断られた理由・中身が枠から溢れた）。 */
interface IParadisBotPageAskState {
	readonly sending: boolean;
	readonly refused?: string;
	readonly overflowing?: boolean;
}

/** 帯の高さ（CSS の `.paradis-bot-page-strip` と同じ）。ターミナルはこの分縮めて下げる。 */
const STRIP_HEIGHT = 40;

export class ParadisBotPage extends Disposable implements IParadisEditorTerminalOverlay {

	private readonly _onDidChangeTopInset = this._register(new Emitter<void>());
	readonly onDidChangeTopInset: Event<void> = this._onDidChangeTopInset.event;

	private readonly strip: HTMLElement;
	private readonly stripFace: HTMLElement;
	private readonly stripName: HTMLElement;
	private readonly stripStatus: HTMLElement;
	private readonly tabElements = new Map<ParadisBotPageTab, HTMLElement>();
	private readonly itemsTab: HTMLElement;
	/** Bot ごとの設定・ファイルのタブ（入力中の値を描き直しの間も持つ）。 */
	private readonly settingsPanels = new Map<string, ParadisBotSettingsPanel>();
	private readonly itemsCount: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly panelStore = this._register(new DisposableStore());

	private instanceId: number | undefined;
	private botId: string | undefined;
	/** 対象の解決の番号（古い解決の結果で上書きしない）。 */
	private resolveSeq = 0;
	private loadSeq = 0;
	/** Bot ごとに開いていたタブと項目（タブを替えて戻っても同じ所を見せる）。 */
	private readonly tabs = new Map<string, ParadisBotPageTab>();
	private readonly openItems = new Map<string, string>();
	private items: readonly IParadisBotItem[] = [];
	/** 問いのカードの状態（台帳の鍵ごと）。 */
	private readonly askStates = new Map<string, IParadisBotPageAskState>();
	/** 今出している問いの鍵と、その守りの終わる時刻。 */
	private askShown: string | undefined;
	private askGuardUntil = 0;
	/** 描いた後に問いのカードが枠から溢れた（描き直してモーダルへ回す）。 */
	private askOverflowed = false;
	private readonly askDialog = this._register(new MutableDisposable<ParadisInboxAskDialog>());
	/** 書きかけのコメント（項目ごと）。描き直しても消さない。 */
	private readonly commentDrafts = new Map<string, string>();
	/** 今の面を描いたときの中身の印（同じなら描き直さない。関係のない変化で入力欄を作り直さないため）。 */
	private panelSignature: string | undefined;
	/** 日本語の変換中は描き直さず、確定してから描く。 */
	private composing = false;
	private renderAfterComposition = false;
	/** 今の面の入力欄（作り直したときに、同じ欄へフォーカスを戻す）。 */
	private readonly focusTargets = new Map<string, HTMLTextAreaElement>();
	private readonly focusKeys = new WeakMap<HTMLElement, string>();

	constructor(
		private readonly container: HTMLElement,
		private readonly resolver: IParadisBotPaneResolver,
		/** 問いのカードの、行数を切り詰めた欄の測り方（テストで差し替える。既定は実物の DOM を測る）。 */
		private readonly measureClamp: IParadisInboxAskCardOptions['measureClamp'] | undefined,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IParadisHumanAskService private readonly humanAskService: IParadisHumanAskService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.strip = DOM.append(container, $('.paradis-bot-page-strip'));
		this.strip.hidden = true;
		this.stripFace = DOM.append(this.strip, $('.paradis-bot-page-face'));
		const title = DOM.append(this.strip, $('.paradis-bot-page-title'));
		this.stripName = DOM.append(title, $('span.paradis-bot-page-name'));
		this.stripStatus = DOM.append(title, $('span.paradis-bot-page-status'));
		const tabs = DOM.append(this.strip, $('.paradis-bot-page-tabs'));
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', localize('paradis.botPage.tabs', "Bot のページ"));
		this.tab(tabs, 'chat', localize('paradis.botPage.tab.chat', "会話"));
		this.itemsTab = this.tab(tabs, 'items', localize('paradis.botPage.tab.items', "項目"));
		this.tab(tabs, 'files', localize('paradis.botPage.tab.files', "ファイル"));
		this.tab(tabs, 'settings', localize('paradis.botPage.tab.settings', "設定"));
		this.itemsCount = DOM.append(this.itemsTab, $('span.paradis-bot-page-tab-count'));
		this._register(DOM.addDisposableListener(tabs, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.LeftArrow) || event.equals(KeyCode.RightArrow)) {
				DOM.EventHelper.stop(e, true);
				const index = PARADIS_BOT_PAGE_TABS.indexOf(this.currentTab());
				const next = PARADIS_BOT_PAGE_TABS[(index + (event.equals(KeyCode.RightArrow) ? 1 : PARADIS_BOT_PAGE_TABS.length - 1)) % PARADIS_BOT_PAGE_TABS.length];
				this.setTab(next);
				this.tabElements.get(next)?.focus();
			}
		}));

		this.panel = DOM.append(container, $('.paradis-bot-page-panel'));
		this.panel.hidden = true;
		this.panel.setAttribute('role', 'tabpanel');
		this.panel.tabIndex = -1;
		this._register(DOM.addDisposableListener(this.panel, 'compositionstart', () => this.composing = true));
		this._register(DOM.addDisposableListener(this.panel, 'compositionend', () => {
			this.composing = false;
			if (this.renderAfterComposition) {
				this.renderAfterComposition = false;
				this.renderPanel();
			}
		}));

		this._register(this.resolver.onDidChange(() => this.resolve()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
				this.resolve();
			}
		}));
		this._register(this.botsService.onDidChange(() => {
			this.renderStrip();
			if (this.botId !== undefined && this.currentTab() === 'items') {
				void this.loadItems();
			} else if (this.botId !== undefined && this.currentTab() === 'settings') {
				// 動かす・ピン留め・顔は台帳の値で描き直す（入力中の値はパネルが持つ）
				this.renderPanel();
			}
		}));
		// 問いが答えられた・取り下げられた・届けている最中になった（カードを描き直し、項目の側も読み直す。中身が同じなら描き直さない）
		this._register(this.humanAskService.onDidChange(() => {
			if (this.botId !== undefined && this.currentTab() === 'items') {
				this.renderPanel();
				void this.loadItems();
			}
		}));
	}

	setInstance(instanceId: number | undefined): void {
		if (this.instanceId === instanceId) {
			return;
		}
		this.instanceId = instanceId;
		this.resolve();
	}

	/** 今のペインが Bot のものかを照らし直す。違えば帯と面を外す。 */
	private resolve(): void {
		const seq = ++this.resolveSeq;
		const instanceId = this.instanceId;
		// 設定をオフにしたら、開いているタブの帯も外す
		if (instanceId === undefined || this.configurationService.getValue<boolean>(PARADIS_BOTS_ENABLED_SETTING) !== true) {
			this.setBot(undefined);
			return;
		}
		this.resolver.botFor(instanceId).then(botId => {
			if (seq === this.resolveSeq && !this._store.isDisposed) {
				this.setBot(botId !== undefined && this.bot(botId) !== undefined ? botId : undefined);
			}
		}, () => {
			if (seq === this.resolveSeq && !this._store.isDisposed) {
				this.setBot(undefined);
			}
		});
	}

	/** 今、帯を出している Bot（テストと呼ぶ側のため）。 */
	get currentBotId(): string | undefined {
		return this.botId;
	}

	private bot(botId: string): IParadisBotSummary | undefined {
		return this.botsService.snapshot.bots.find(bot => bot.id === botId);
	}

	topInset(): number {
		return this.botId !== undefined ? STRIP_HEIGHT : 0;
	}

	private setBot(botId: string | undefined): void {
		const changed = this.botId !== botId;
		const wasShown = this.botId !== undefined;
		this.botId = botId;
		if (wasShown !== (botId !== undefined)) {
			this._onDidChangeTopInset.fire();
		}
		this.strip.hidden = botId === undefined;
		this.container.classList.toggle(ACTIVE_CLASS, botId !== undefined);
		if (botId === undefined) {
			this.container.classList.remove(ITEMS_CLASS);
			this.panel.hidden = true;
			this.clearPanel();
			this.items = [];
			return;
		}
		if (changed) {
			this.items = [];
		}
		this.renderStrip();
		this.applyTab();
	}

	private tab(parent: HTMLElement, tab: ParadisBotPageTab, label: string): HTMLElement {
		const element = DOM.append(parent, $('button.paradis-bot-page-tab.paradis-focus-ring-inset')) as HTMLButtonElement;
		element.type = 'button';
		element.setAttribute('role', 'tab');
		DOM.append(element, $('span')).textContent = label;
		this._register(DOM.addDisposableListener(element, DOM.EventType.CLICK, () => this.setTab(tab)));
		this.tabElements.set(tab, element);
		return element;
	}

	private currentTab(): ParadisBotPageTab {
		return this.botId !== undefined ? this.tabs.get(this.botId) ?? 'chat' : 'chat';
	}

	private setTab(tab: ParadisBotPageTab): void {
		if (this.botId === undefined) {
			return;
		}
		this.tabs.set(this.botId, tab);
		this.applyTab();
	}

	private applyTab(): void {
		const tab = this.currentTab();
		for (const [value, element] of this.tabElements) {
			element.classList.toggle('selected', tab === value);
			element.setAttribute('aria-selected', String(tab === value));
			element.tabIndex = tab === value ? 0 : -1;
		}
		this.panel.hidden = tab === 'chat';
		this.container.classList.toggle(ITEMS_CLASS, tab !== 'chat');
		if (tab === 'items') {
			this.renderPanel();
			void this.loadItems();
		} else if (tab !== 'chat') {
			this.renderPanel();
		} else {
			this.clearPanel();
		}
	}

	private clearPanel(): void {
		this.panelStore.clear();
		DOM.clearNode(this.panel);
		this.focusTargets.clear();
		this.panelSignature = undefined;
		// 変換中に面ごと外れると compositionend が届かないことがあるので、ここで戻す（戻さないと次の面が描かれない）
		this.composing = false;
		this.renderAfterComposition = false;
	}

	private renderStrip(): void {
		const bot = this.botId !== undefined ? this.bot(this.botId) : undefined;
		if (bot === undefined) {
			if (this.botId !== undefined) {
				// Bot が消えた
				this.setBot(undefined);
			}
			return;
		}
		DOM.clearNode(this.stripFace);
		renderParadisBotFace(this.stripFace, paradisBotFace(bot));
		this.stripName.textContent = bot.name;
		this.stripStatus.textContent = paradisBotStatusLine(bot);
		this.itemsCount.textContent = bot.needsYou > 0 ? (bot.needsYou > 99 ? '99+' : String(bot.needsYou)) : '';
		this.itemsCount.hidden = bot.needsYou === 0;
		this.itemsTab.setAttribute('aria-label', bot.needsYou > 0
			? localize('paradis.botPage.tab.itemsCount', "項目、{0} 件があなたの番", bot.needsYou)
			: localize('paradis.botPage.tab.items', "項目"));
	}

	private async loadItems(): Promise<void> {
		const botId = this.botId;
		if (botId === undefined) {
			return;
		}
		const seq = ++this.loadSeq;
		const items = await this.botsService.listItems({ botId });
		if (seq !== this.loadSeq || this.botId !== botId || this._store.isDisposed) {
			return;
		}
		this.items = items;
		if (this.currentTab() === 'items') {
			this.renderPanel();
		}
	}

	// ---- 項目の面 -------------------------------------------------------------------------------

	/** 開いている項目の問いの、台帳の鍵。 */
	private askKey(item: IParadisBotItem): string | undefined {
		return item.ask !== undefined ? paradisHumanAskKey('bot', paradisBotAskId(item.uid, item.ask.eventId)) : undefined;
	}

	/** 面に出す中身の印。開いている項目・一覧の項目・問いの台帳の中身とカードの状態が変わったときだけ描き直す。 */
	private signature(item: IParadisBotItem | undefined): string {
		const key = item !== undefined ? this.askKey(item) : undefined;
		const entry = key !== undefined ? this.humanAskService.snapshot.entries.find(candidate => candidate.key === key) : undefined;
		return JSON.stringify([this.botId, item !== undefined ? item : this.items, entry, key !== undefined ? this.askStates.get(key) : undefined]);
	}

	private renderPanel(): void {
		if (this.botId === undefined) {
			return;
		}
		const tab = this.currentTab();
		// ファイル・設定の面は、入力中の値をパネル（ParadisBotSettingsPanel）が持つので、呼ばれるたびに描き直す
		const settings = tab === 'files' || tab === 'settings';
		const uid = this.openItems.get(this.botId);
		const item = uid !== undefined ? this.items.find(candidate => candidate.uid === uid) : undefined;
		const signature = settings ? undefined : this.signature(item);
		if (signature !== undefined && signature === this.panelSignature) {
			return;
		}
		// 変換中に作り直すと確定前の文字が消えるので、確定を待つ
		if (this.composing) {
			this.renderAfterComposition = true;
			return;
		}
		const active = DOM.getActiveElement();
		const focused = DOM.isHTMLElement(active) && this.panel.contains(active) ? active : undefined;
		// 入力欄にいたら、作り直した同じ欄へ戻す（値は項目ごとの書きかけから戻る）
		const focusKey = focused !== undefined ? this.focusKeys.get(focused) : undefined;
		const selection = focusKey !== undefined && DOM.isHTMLTextAreaElement(focused) ? [focused.selectionStart, focused.selectionEnd] as const : undefined;
		const scrollTop = this.panel.scrollTop;
		this.panelStore.clear();
		DOM.clearNode(this.panel);
		this.focusTargets.clear();
		this.panelSignature = signature;
		const body = DOM.append(this.panel, $('.paradis-bot-page-body'));
		if (settings) {
			const bot = this.bot(this.botId);
			if (bot !== undefined) {
				const panel = this.settingsPanel(bot.id);
				if (tab === 'files') {
					panel.renderFiles(body, bot, this.panelStore);
				} else {
					panel.renderSettings(body, bot, this.panelStore);
				}
			}
			this.panel.scrollTop = scrollTop;
			return;
		}
		if (item !== undefined) {
			this.renderItem(body, item);
		} else {
			this.renderList(body);
		}
		this.panel.scrollTop = scrollTop;
		const again = focusKey !== undefined ? this.focusTargets.get(focusKey) : undefined;
		if (again) {
			again.focus();
			if (selection) {
				again.setSelectionRange(selection[0], selection[1]);
			}
		} else if (focused) {
			this.panel.focus();
		}
		// 受信箱と同じく、描いた後に問いの中身が枠から溢れたら、行の中で答えさせずモーダルへ回す
		if (this.askOverflowed) {
			this.askOverflowed = false;
			this.renderPanel();
		}
	}

	private settingsPanel(botId: string): ParadisBotSettingsPanel {
		let panel = this.settingsPanels.get(botId);
		if (panel === undefined) {
			panel = new ParadisBotSettingsPanel(botId, {
				botsService: this.botsService,
				paradisDialogService: this.paradisDialogService,
				notificationService: this.notificationService,
				contextViewService: this.contextViewService,
				configurationService: this.configurationService,
			}, () => {
				if (!this._store.isDisposed && this.botId === botId) {
					this.renderPanel();
				}
			});
			this.settingsPanels.set(botId, panel);
		}
		return panel;
	}

	private trackFocus(text: HTMLTextAreaElement, key: string): void {
		this.focusTargets.set(key, text);
		this.focusKeys.set(text, key);
	}

	private renderList(body: HTMLElement): void {
		const groups = paradisBotItemGroups(this.items, Date.now());
		const section = (label: string, items: readonly IParadisBotItem[], options: { readonly empty?: string; readonly collapsed?: boolean } = {}) => {
			if (items.length === 0 && options.empty === undefined) {
				return;
			}
			const head = DOM.append(body, $('.paradis-bot-page-section'));
			const details = options.collapsed ? DOM.append(body, $('details.paradis-bot-page-fold')) as HTMLDetailsElement : undefined;
			if (details) {
				head.remove();
				DOM.append(DOM.append(details, $('summary.paradis-bot-page-section.paradis-focus-ring-inset')), $('span')).textContent = localize('paradis.botPage.sectionCount', "{0} · {1}", label, items.length);
			} else {
				head.textContent = localize('paradis.botPage.sectionCount', "{0} · {1}", label, items.length);
			}
			const list = DOM.append(details ?? body, $('.paradis-bot-page-list'));
			if (items.length === 0 && options.empty !== undefined) {
				DOM.append(list, $('.paradis-bot-page-empty')).textContent = options.empty;
			}
			for (const item of items) {
				this.renderRow(list, item);
			}
		};
		section(localize('paradis.botPage.group.you', "あなたの番"), groups.you, { empty: localize('paradis.botPage.group.youEmpty', "待っているものはありません。") });
		section(localize('paradis.botPage.group.working', "進行中"), groups.working);
		section(localize('paradis.botPage.group.planned', "予定"), groups.planned, { collapsed: true });
		section(localize('paradis.botPage.group.snoozed', "後回し"), groups.snoozed, { collapsed: true });
		section(localize('paradis.botPage.group.closed', "終了"), groups.closed, { collapsed: true });
		if (this.items.length === 0) {
			DOM.append(body, $('.paradis-bot-page-hint')).textContent = localize('paradis.botPage.noItems', "Bot が作業を項目にすると、ここに並びます。");
		}
	}

	private renderRow(list: HTMLElement, item: IParadisBotItem): void {
		const row = DOM.append(list, $('button.paradis-bot-page-row.paradis-focus-ring-inset')) as HTMLButtonElement;
		row.type = 'button';
		DOM.append(row, $('span.paradis-bot-page-row-number')).textContent = `#${item.number}`;
		DOM.append(row, $('span.paradis-bot-page-row-title')).textContent = item.title;
		if (paradisBotItemWaitsForOwner(item, Date.now())) {
			createParadisChip(row, localize('paradis.botPage.chip.you', "あなたの番"), 'info');
		} else if (paradisIsBotItemClosed(item)) {
			createParadisChip(row, paradisBotItemStatusLabel(item));
		}
		DOM.append(row, $('span.paradis-bot-page-row-time')).textContent = fromNow(item.lastActivityAt, true);
		this.panelStore.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => this.openItem(item.uid)));
	}

	private openItem(uid: string | undefined): void {
		if (this.botId === undefined) {
			return;
		}
		if (uid === undefined) {
			this.openItems.delete(this.botId);
		} else {
			this.openItems.set(this.botId, uid);
		}
		this.panel.scrollTop = 0;
		this.renderPanel();
	}

	private renderItem(body: HTMLElement, item: IParadisBotItem): void {
		const now = Date.now();
		const nav = DOM.append(body, $('.paradis-bot-page-nav'));
		const back = DOM.append(nav, $('button.paradis-bot-page-back.paradis-focus-ring-inset')) as HTMLButtonElement;
		back.type = 'button';
		DOM.append(back, $(ThemeIcon.asCSSSelector(Codicon.chevronLeft)));
		DOM.append(back, $('span')).textContent = localize('paradis.botPage.back', "項目の一覧");
		this.panelStore.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => this.openItem(undefined)));
		DOM.append(nav, $('span.paradis-bot-page-meta')).textContent = localize('paradis.botPage.itemMeta', "項目 #{0} · {1}", item.number, fromNow(item.lastActivityAt, true));
		createParadisChip(nav, paradisBotItemWaitsForOwner(item, now) ? localize('paradis.botPage.chip.you', "あなたの番") : paradisBotItemStatusLabel(item), paradisBotItemWaitsForOwner(item, now) ? 'info' : 'neutral');
		if (paradisIsBotItemSnoozed(item, now) && item.snoozedUntil !== undefined) {
			createParadisChip(nav, localize('paradis.botPage.snoozedUntil', "後回し（{0} まで）", new Date(item.snoozedUntil).toLocaleString()));
		}

		DOM.append(body, $('h2.paradis-bot-page-item-title')).textContent = item.title;
		if (item.description) {
			DOM.append(body, $('.paradis-bot-page-text')).textContent = item.description;
		}
		if (item.doneMeans) {
			DOM.append(body, $('.paradis-bot-page-label')).textContent = localize('paradis.botPage.doneMeans', "完了の条件");
			DOM.append(body, $('.paradis-bot-page-text')).textContent = item.doneMeans;
		}
		if (item.closeNote) {
			DOM.append(body, $('.paradis-bot-page-label')).textContent = localize('paradis.botPage.closeNote', "閉じたときのひとこと");
			DOM.append(body, $('.paradis-bot-page-text')).textContent = item.closeNote;
		}
		if (item.links.length > 0) {
			DOM.append(body, $('.paradis-bot-page-label')).textContent = localize('paradis.botPage.links', "リンク");
			const links = DOM.append(body, $('.paradis-bot-page-links'));
			for (const link of item.links) {
				const target = linkTarget(link);
				const row = DOM.append(links, $(target ? 'button.paradis-bot-page-link.paradis-focus-ring-inset' : 'span.paradis-bot-page-link'));
				DOM.append(row, $(ThemeIcon.asCSSSelector(link.kind === 'pr' ? Codicon.gitPullRequest : link.kind === 'file' ? Codicon.file : Codicon.link)));
				DOM.append(row, $('span')).textContent = link.ref;
				if (target) {
					(row as HTMLButtonElement).type = 'button';
					this.panelStore.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => void this.openerService.open(target)));
				}
			}
		}

		DOM.append(body, $('.paradis-bot-page-label')).textContent = localize('paradis.botPage.events', "記録");
		const events = DOM.append(body, $('.paradis-bot-page-events'));
		for (const event of item.events.slice(-50)) {
			const line = DOM.append(events, $('.paradis-bot-page-event'));
			DOM.append(line, $('span.paradis-bot-page-event-time')).textContent = clock(event.at);
			DOM.append(line, $('span.paradis-bot-page-event-text')).textContent = paradisBotItemEventLabel(event, (this.botId !== undefined ? this.bot(this.botId)?.name : undefined) ?? 'Bot');
		}

		const locked = paradisIsBotItemLocked(item);
		if (item.ask !== undefined && paradisBotItemWaitsForOwner(item, now) && !locked) {
			this.renderAsk(body, item);
		}
		if (!locked && !paradisIsBotItemClosed(item)) {
			this.renderComment(body, item);
			this.renderActions(body, item);
		} else if (!locked) {
			this.renderReopen(body, item);
		}
	}

	/**
	 * Bot の問いのカード。受信箱の「あなたの番」のカードそのもの（出た直後 0.6 秒は押しても効かない守り、中身が枠から
	 * 溢れたら・問いが多ければモーダルで答える）。答えは「聞く・答える」の台帳へ（受信箱と同じ道）。
	 */
	private renderAsk(body: HTMLElement, item: IParadisBotItem): void {
		const key = this.askKey(item);
		const entry = key !== undefined ? this.humanAskService.snapshot.entries.find(candidate => candidate.key === key) : undefined;
		if (key === undefined || entry === undefined) {
			return;
		}
		if (this.askShown !== key) {
			this.askShown = key;
			this.askGuardUntil = Date.now() + ASK_GUARD_MS;
		}
		const state = this.askStates.get(key) ?? { sending: false };
		const holder = DOM.append(body, $(`.paradis-bot-page-ask.${PARADIS_INBOX_ASK_SCOPE_CLASS}`));
		const card = this.panelStore.add(paradisBuildInboxAskCard(entry, '', {
			sending: state.sending,
			refused: state.refused,
			overflowing: state.overflowing === true,
			now: () => Date.now(),
			guardUntil: () => this.askGuardUntil,
			...(this.measureClamp !== undefined ? { measureClamp: this.measureClamp } : {}),
			answer: (answerKey, answer) => void this.answer(answerKey, answer),
			openAsk: (askKey, focusText) => this.openAskDialog(askKey, focusText),
		}, this.hoverService));
		holder.appendChild(card.element);
		if (state.overflowing !== true && card.overflows?.() === true) {
			this.askStates.set(key, { ...state, overflowing: true });
			this.askOverflowed = true;
		}
	}

	/** 受信箱と同じモーダルで答える（問いが多い・長い選択肢・自分で書く答え・中身が溢れた）。 */
	private openAskDialog(key: string, focusText: boolean): void {
		const container = this.container.closest<HTMLElement>('.monaco-workbench') ?? this.container.ownerDocument.body;
		this.askDialog.value = new ParadisInboxAskDialog({ container, key, focusText, onClose: () => this.askDialog.clear() }, this.humanAskService);
	}

	private async answer(key: string, answer: ParadisHumanAskAnswer): Promise<void> {
		if (this.askStates.get(key)?.sending) {
			return;
		}
		this.askStates.set(key, { ...this.askStates.get(key), sending: true });
		this.renderPanel();
		const result = await this.humanAskService.answer(key, answer, 'bot');
		if (this._store.isDisposed) {
			return;
		}
		if (result.ok) {
			this.askStates.delete(key);
		} else {
			this.askStates.set(key, { ...this.askStates.get(key), sending: false, refused: paradisInboxAskRefusedText(result.reason) });
		}
		this.renderPanel();
		void this.loadItems();
	}

	private renderComment(body: HTMLElement, item: IParadisBotItem): void {
		const frame = DOM.append(body, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.paradis-bot-page-comment'));
		const text = DOM.append(frame, $('textarea')) as HTMLTextAreaElement;
		text.rows = 2;
		this.trackFocus(text, 'comment');
		text.value = this.commentDrafts.get(item.uid) ?? '';
		text.placeholder = localize('paradis.botPage.comment', "Bot へコメントを書く");
		text.setAttribute('aria-label', text.placeholder);
		const actions = DOM.append(body, $('.paradis-bot-page-comment-actions'));
		const send = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.commentSend', "コメントを送る") }));
		send.enabled = text.value.trim().length > 0;
		this.panelStore.add(DOM.addDisposableListener(text, DOM.EventType.INPUT, () => {
			if (text.value) {
				this.commentDrafts.set(item.uid, text.value);
			} else {
				this.commentDrafts.delete(item.uid);
			}
			send.enabled = text.value.trim().length > 0;
		}));
		this.panelStore.add(send.onDidClick(async () => {
			const value = text.value.trim();
			if (!value) {
				return;
			}
			send.enabled = false;
			const result = await this.botsService.ownerComment(item.uid, { text: value, plain: true });
			if (!result.ok) {
				this.notificationService.warn(localize('paradis.botPage.commentFailed', "コメントを送れませんでした: {0}", result.message));
				send.enabled = true;
				return;
			}
			this.commentDrafts.delete(item.uid);
			text.value = '';
			void this.loadItems();
		}));
	}

	private renderActions(body: HTMLElement, item: IParadisBotItem): void {
		const actions = DOM.append(body, $('.paradis-bot-page-item-actions'));
		const done = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.done', "完了にする...") }));
		this.panelStore.add(done.onDidClick(async () => {
			const { confirmed } = await this.paradisDialogService.confirm({
				message: localize('paradis.botPage.doneMessage', "項目 #{0} を完了にしますか?", item.number),
				detail: localize('paradis.botPage.doneDetail', "Bot にも完了にしたことを伝えます。閉じた項目は、項目のページの「戻す」で開き直せます。"),
				primaryButton: localize('paradis.botPage.doneConfirm', "完了にする"),
			});
			if (confirmed) {
				await this.setStatus(item, 'done');
			}
		}));
		const snoozed = paradisIsBotItemSnoozed(item, Date.now());
		const snooze = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: snoozed ? localize('paradis.botPage.unsnooze', "後回しを解く") : localize('paradis.botPage.snooze', "後回し...") }));
		this.panelStore.add(snooze.onDidClick(() => {
			if (snoozed) {
				void this.snooze(item, undefined);
				return;
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => snooze.element,
				getActions: (): IAction[] => SNOOZE_HOURS.map(choice => new Action(`paradis.botPage.snooze.${choice.hours}`, choice.label, undefined, true, () => this.snooze(item, Date.now() + choice.hours * 3_600_000))),
			});
		}));
		const cancel = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.cancel', "取りやめる...") }));
		this.panelStore.add(cancel.onDidClick(async () => {
			const { confirmed } = await this.paradisDialogService.confirm({
				message: localize('paradis.botPage.cancelMessage', "項目 #{0} を取りやめますか?", item.number),
				detail: localize('paradis.botPage.cancelDetail', "Bot にも取りやめたことを伝えます。"),
				primaryButton: localize('paradis.botPage.cancelConfirm', "取りやめる"),
				destructive: true,
			});
			if (confirmed) {
				await this.setStatus(item, 'canceled');
			}
		}));
	}

	/** 閉じた項目（完了・取りやめ）を開き直す。 */
	private renderReopen(body: HTMLElement, item: IParadisBotItem): void {
		const actions = DOM.append(body, $('.paradis-bot-page-item-actions'));
		const reopen = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.reopen', "戻す"), title: localize('paradis.botPage.reopenTitle', "この項目を進行中に戻します。Bot にも伝えます。") }));
		this.panelStore.add(reopen.onDidClick(() => void this.setStatus(item, 'working')));
	}

	private async setStatus(item: IParadisBotItem, to: 'done' | 'canceled' | 'working'): Promise<void> {
		const result = await this.botsService.ownerSetStatus(item.uid, to);
		if (!result.ok) {
			this.notificationService.warn(localize('paradis.botPage.statusFailed', "項目を変えられませんでした: {0}", result.message));
		}
		void this.loadItems();
	}

	private async snooze(item: IParadisBotItem, until: number | undefined): Promise<void> {
		const result = await this.botsService.ownerSnooze(item.uid, until);
		if (!result.ok) {
			this.notificationService.warn(localize('paradis.botPage.snoozeFailed', "後回しにできませんでした: {0}", result.message));
		}
		void this.loadItems();
	}

	override dispose(): void {
		// 帯・面と、下の会話を下げる印を外す（タブを閉じた・別の窓へ動いた・登録を外したとき）
		this.strip.remove();
		this.panel.remove();
		this.container.classList.remove(ACTIVE_CLASS, ITEMS_CLASS);
		super.dispose();
	}
}
