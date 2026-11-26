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
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { IParadisEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { IParadisAgentChatService } from '../../agentChat/browser/paradisAgentChatService.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';
import { IParadisHumanAskService, paradisHumanAskKey } from '../../humanAsk/common/paradisHumanAsk.js';
import { paradisBotAskId } from '../common/paradisBotAsk.js';
import { IParadisBotItem, IParadisBotItemLink, paradisBotItemWaitsForOwner, paradisIsBotItemClosed, paradisIsBotItemLocked, paradisIsBotItemSnoozed } from '../common/paradisBotItems.js';
import { IParadisBotSummary, IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { paradisBotFace } from '../common/paradisBotsBandModel.js';
import { IParadisBotAskSelection, paradisBotAskAnswer, paradisBotAskToggle, paradisBotItemEventLabel, paradisBotItemGroups, paradisBotItemStatusLabel, PARADIS_AGENT_CHAT_ACTIVE_CLASS, PARADIS_BOT_PAGE_TABS, ParadisBotPageTab, paradisBotStripHeader } from '../common/paradisBotPageModel.js';
import { ParadisBotSettingsPanel } from './paradisBotPageSettings.js';
import { renderParadisBotFace } from './paradisBotFace.js';
import { IParadisBotPatrolPort, ParadisBotPatrolSection } from './paradisBotPatrol.js';
import type { IParadisBotSuggestion } from '../common/paradisBotSuggestions.js';

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

/** 帯の高さ（CSS の `.paradis-bot-page-strip` と同じ）。ターミナルはこの分縮めて下げる。 */
const STRIP_HEIGHT = 40;

export class ParadisBotPage extends Disposable implements IParadisEditorTerminalOverlay {

	private readonly _onDidChangeTopInset = this._register(new Emitter<void>());
	readonly onDidChangeTopInset: Event<void> = this._onDidChangeTopInset.event;

	private readonly strip: HTMLElement;
	private readonly stripFace: HTMLElement;
	private readonly stripName: HTMLElement;
	private readonly stripStatus: HTMLElement;
	/** チャット表示を見ている間だけ出す、会話の記録から取ったモデル（見出しを畳んだ分）。 */
	private readonly stripModel: HTMLElement;
	/** チャット表示を見ている間だけ出す「ターミナルに戻る」（見出しを畳んだ分）。 */
	private readonly terminalButton: HTMLButtonElement;
	/** 見出しを畳んでいるペイン（Bot の帯を出している間だけ畳む）。 */
	private headerHiddenFor: number | undefined;
	private readonly tabElements = new Map<ParadisBotPageTab, HTMLElement>();
	private readonly itemsTab: HTMLElement;
	/** Bot ごとの設定・ファイルのタブ（入力中の値を描き直しの間も持つ）。 */
	private readonly settingsPanels = new Map<string, ParadisBotSettingsPanel>();
	/** Bot ごとの見回りの表示（書きかけの値を描き直しの間も持つ）。 */
	private readonly patrolSections = new Map<string, ParadisBotPatrolSection>();
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
	private suggestions: readonly IParadisBotSuggestion[] = [];
	/** 問いのカードで選んでいるもの（項目の問いごと）。 */
	private readonly selections = new Map<string, { options: number[][]; texts: string[] }>();
	private answering = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly resolver: IParadisBotPaneResolver,
		/** 見回りの口（定期実行の側）。無ければ「定期実行」の節と見回りの欄を出さない。 */
		private readonly patrolPort: IParadisBotPatrolPort | undefined,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IParadisHumanAskService private readonly humanAskService: IParadisHumanAskService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisAgentChatService private readonly agentChatService: IParadisAgentChatService,
	) {
		super();
		this.strip = DOM.append(container, $('.paradis-bot-page-strip'));
		this.strip.hidden = true;
		this.stripFace = DOM.append(this.strip, $('.paradis-bot-page-face'));
		const title = DOM.append(this.strip, $('.paradis-bot-page-title'));
		this.stripName = DOM.append(title, $('span.paradis-bot-page-name'));
		this.stripStatus = DOM.append(title, $('span.paradis-bot-page-status'));
		this.stripModel = DOM.append(title, $('span.paradis-bot-page-model'));
		const tabs = DOM.append(this.strip, $('.paradis-bot-page-tabs'));
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', localize('paradis.botPage.tabs', "Bot のページ"));
		this.tab(tabs, 'chat', localize('paradis.botPage.tab.chat', "会話"));
		this.itemsTab = this.tab(tabs, 'items', localize('paradis.botPage.tab.items', "項目"));
		this.tab(tabs, 'files', localize('paradis.botPage.tab.files', "ファイル"));
		this.tab(tabs, 'settings', localize('paradis.botPage.tab.settings', "設定"));
		this.itemsCount = DOM.append(this.itemsTab, $('span.paradis-bot-page-tab-count'));
		const terminalLabel = localize('paradis.botPage.showTerminal', "ターミナルに戻る");
		this.terminalButton = DOM.append(this.strip, $('button.paradis-bot-page-terminal.paradis-focus-ring-inset')) as HTMLButtonElement;
		this.terminalButton.type = 'button';
		this.terminalButton.setAttribute('aria-label', terminalLabel);
		this.terminalButton.title = terminalLabel;
		DOM.append(this.terminalButton, $(ThemeIcon.asCSSSelector(Codicon.terminal)));
		this._register(DOM.addDisposableListener(this.terminalButton, DOM.EventType.CLICK, () => {
			if (this.instanceId !== undefined) {
				this.agentChatService.showTerminal(this.instanceId);
			}
		}));
		// 見出しに出ていたもの（状態・モデル）は帯に写す。変わったら描き直す
		this._register(this.agentChatService.onDidChangeHeader(instanceId => {
			if (instanceId === this.instanceId && this.botId !== undefined) {
				this.renderStrip();
			}
		}));
		// チャット表示とターミナル表示の切り替え（入れ物の印）で、帯を 1 段にするかを決め直す
		const observer = new MutationObserver(() => {
			if (this.botId !== undefined) {
				this.renderStrip();
			}
		});
		observer.observe(container, { attributes: true, attributeFilter: ['class'] });
		this._register({ dispose: () => observer.disconnect() });
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
		if (this.patrolPort !== undefined) {
			this._register(this.patrolPort.onDidChange(() => {
				if (this.botId !== undefined) {
					this.patrolSections.get(this.botId)?.invalidate();
				}
			}));
		}
		this._register(this.humanAskService.onDidChange(() => {
			if (this.botId !== undefined && this.currentTab() === 'items') {
				this.renderPanel();
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
		this.syncHeaderHidden(botId !== undefined ? this.instanceId : undefined);
		if (botId === undefined) {
			this.container.classList.remove(ITEMS_CLASS);
			this.panel.hidden = true;
			this.panelStore.clear();
			DOM.clearNode(this.panel);
			this.items = [];
			return;
		}
		if (changed) {
			this.items = [];
			this.suggestions = [];
		}
		this.renderStrip();
		this.applyTab();
	}

	/**
	 * Bot の帯を出しているペインだけ、チャット表示の見出しを畳む（帯と合わせて 1 段にする）。畳んだ見出しの知らせ
	 * （許可待ち・質問待ちなど）とターミナルへ戻る口は帯が出す。ターミナル表示の間は見出し自体が出ていない。
	 */
	private syncHeaderHidden(instanceId: number | undefined): void {
		if (this.headerHiddenFor === instanceId) {
			return;
		}
		if (this.headerHiddenFor !== undefined) {
			this.agentChatService.setHeaderHidden(this.headerHiddenFor, false);
		}
		this.headerHiddenFor = instanceId;
		if (instanceId !== undefined) {
			this.agentChatService.setHeaderHidden(instanceId, true);
		}
	}

	/** チャット表示を見ているか（チャット表示が入れ物に付ける印）。 */
	private chatShown(): boolean {
		return this.container.classList.contains(PARADIS_AGENT_CHAT_ACTIVE_CLASS);
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
			this.panelStore.clear();
			DOM.clearNode(this.panel);
		}
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
		// チャット表示を見ている間は、畳んだ見出しの状態（許可待ち・質問待ちなど）とモデルを帯に出す。ターミナル表示の間は
		// 見出しの値が古いことがある（中継はチャット表示中のペインの分しか送らない）ので、Bot の台帳の値だけを出す
		const chat = this.chatShown();
		const header = chat && this.instanceId !== undefined ? this.agentChatService.headerState(this.instanceId) : undefined;
		const strip = paradisBotStripHeader(bot, header);
		this.stripStatus.textContent = strip.status;
		this.stripStatus.classList.toggle('attention', strip.attention);
		this.stripStatus.classList.toggle('busy', strip.busy);
		this.stripModel.textContent = strip.model;
		this.stripModel.hidden = strip.model.length === 0;
		this.terminalButton.hidden = !chat;
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
		const [items, suggestions] = await Promise.all([this.botsService.listItems({ botId }), this.botsService.listSuggestions(botId)]);
		if (seq !== this.loadSeq || this.botId !== botId || this._store.isDisposed) {
			return;
		}
		this.items = items;
		this.suggestions = suggestions;
		if (this.currentTab() === 'items') {
			this.renderPanel();
		}
	}

	// ---- 項目の面 -------------------------------------------------------------------------------

	private renderPanel(): void {
		if (this.botId === undefined) {
			return;
		}
		const active = DOM.getActiveElement();
		const hadFocus = DOM.isHTMLElement(active) && this.panel.contains(active);
		const scrollTop = this.panel.scrollTop;
		this.panelStore.clear();
		DOM.clearNode(this.panel);
		const body = DOM.append(this.panel, $('.paradis-bot-page-body'));
		const tab = this.currentTab();
		if (tab === 'files' || tab === 'settings') {
			const bot = this.bot(this.botId);
			if (bot !== undefined) {
				const panel = this.settingsPanel(bot.id);
				if (tab === 'files') {
					panel.renderFiles(body, bot, this.panelStore);
				} else {
					panel.renderSettings(body, bot, this.panelStore);
					this.patrolSection(bot.id)?.renderSettings(body, this.panelStore);
				}
			}
			this.panel.scrollTop = scrollTop;
			return;
		}
		const uid = this.openItems.get(this.botId);
		const item = uid !== undefined ? this.items.find(candidate => candidate.uid === uid) : undefined;
		if (item !== undefined) {
			this.renderItem(body, item);
		} else {
			this.renderList(body);
		}
		this.panel.scrollTop = scrollTop;
		if (hadFocus) {
			this.panel.focus();
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

	private patrolSection(botId: string): ParadisBotPatrolSection | undefined {
		if (this.patrolPort === undefined) {
			return undefined;
		}
		let section = this.patrolSections.get(botId);
		if (section === undefined) {
			section = new ParadisBotPatrolSection(botId, this.patrolPort, {
				notificationService: this.notificationService,
				contextViewService: this.contextViewService,
				configurationService: this.configurationService,
			}, () => {
				if (!this._store.isDisposed && this.botId === botId && (this.currentTab() === 'items' || this.currentTab() === 'settings')) {
					this.renderPanel();
				}
			}, () => {
				if (this.botId === botId) {
					this.setTab('settings');
				}
			});
			this.patrolSections.set(botId, section);
		}
		return section;
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
		if (this.botId !== undefined) {
			this.patrolSection(this.botId)?.renderHome(body, this.panelStore);
		}
		this.renderSuggestions(body);
	}

	/** 提案の節（Q677 の 8）。Bot のホームにだけ出し、ベルにも「あなたの番」にも数えない。 */
	private renderSuggestions(body: HTMLElement): void {
		if (this.suggestions.length === 0) {
			return;
		}
		DOM.append(body, $('.paradis-bot-page-section')).textContent = localize('paradis.botPage.sectionCount', "{0} · {1}", localize('paradis.botPage.suggestions', "提案"), this.suggestions.length);
		for (const suggestion of this.suggestions) {
			const card = DOM.append(body, $('.paradis-bot-page-suggestion'));
			DOM.append(card, $('.paradis-bot-page-suggestion-title')).textContent = suggestion.title;
			DOM.append(card, $('.paradis-bot-page-suggestion-text')).textContent = suggestion.request;
			const actions = DOM.append(card, $('.paradis-bot-page-ask-actions'));
			const start = this.panelStore.add(new ParadisButton(actions, { kind: 'primary', label: localize('paradis.botPage.suggestion.start', "始める") }));
			this.panelStore.add(start.onDidClick(() => void this.startSuggestion(suggestion)));
			const dismiss = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.suggestion.dismiss', "見送る") }));
			this.panelStore.add(dismiss.onDidClick(() => void this.dismissSuggestion(suggestion)));
		}
	}

	/**
	 * 「始める」: 依頼の文を、送らずに Bot の会話の入力欄へ入れて会話のタブへ戻す（持ち主が読んで直してから送る）。
	 * チャット表示の入力欄へ下書きとして入れ（書きかけは消さずに後ろへ足す）、チャット表示でないペインでは
	 * ターミナルの入力へ貼り付けとして入れる（改行のある文も途中で送られない）。
	 */
	private async startSuggestion(suggestion: IParadisBotSuggestion): Promise<void> {
		const result = await this.botsService.startSuggestion(suggestion.id);
		if (!result.ok) {
			this.notificationService.warn(localize('paradis.botPage.suggestion.failed', "提案を始められませんでした: {0}", result.message));
			void this.loadItems();
			return;
		}
		// 先に会話のタブへ戻す（チャット表示が見えていれば、入れた下書きへフォーカスが移る）
		this.setTab('chat');
		const inserted = this.instanceId !== undefined && this.agentChatService.insertDraft(this.instanceId, result.value.request) !== false;
		const instance = !inserted && this.instanceId !== undefined ? this.terminalService.getInstanceFromId(this.instanceId) : undefined;
		if (instance !== undefined && !instance.isDisposed) {
			await instance.sendText(result.value.request, false, true);
		}
		void this.loadItems();
	}

	private async dismissSuggestion(suggestion: IParadisBotSuggestion): Promise<void> {
		const result = await this.botsService.dismissSuggestion(suggestion.id);
		if (!result.ok) {
			this.notificationService.warn(localize('paradis.botPage.suggestion.dismissFailed', "提案を見送れませんでした: {0}", result.message));
		}
		void this.loadItems();
	}

	private renderRow(list: HTMLElement, item: IParadisBotItem): void {
		const row = DOM.append(list, $('button.paradis-bot-page-row.paradis-focus-ring-inset')) as HTMLButtonElement;
		row.type = 'button';
		DOM.append(row, $('span.paradis-bot-page-row-number')).textContent = `#${item.number}`;
		DOM.append(row, $('span.paradis-bot-page-row-title')).textContent = item.title;
		if (paradisBotItemWaitsForOwner(item, Date.now())) {
			createParadisChip(row, localize('paradis.botPage.chip.you', "あなたの番"), 'info');
		} else if (paradisIsBotItemClosed(item) || item.status === 'waiting') {
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
		}
	}

	/** Bot の問いのカード。答えは「聞く・答える」の台帳へ（受信箱と同じ道）。 */
	private renderAsk(body: HTMLElement, item: IParadisBotItem): void {
		const ask = item.ask!;
		const key = paradisHumanAskKey('bot', paradisBotAskId(item.uid, ask.eventId));
		let selection = this.selections.get(key);
		if (selection === undefined) {
			selection = { options: ask.questions.map(() => []), texts: [] };
			this.selections.set(key, selection);
		}
		const card = DOM.append(body, $('.paradis-bot-page-ask'));
		const head = DOM.append(card, $('.paradis-bot-page-ask-head'));
		createParadisChip(head, localize('paradis.botPage.ask.question', "質問"), 'info');
		DOM.append(head, $('span.paradis-bot-page-ask-title')).textContent = `#${item.number} ${item.title}`;
		if (ask.context) {
			DOM.append(card, $('.paradis-bot-page-ask-context')).textContent = ask.context;
		}
		const questions = ask.questions.length > 0 ? ask.questions : [undefined];
		questions.forEach((question, index) => {
			if (question !== undefined) {
				DOM.append(card, $('.paradis-bot-page-ask-prompt')).textContent = ask.questions.length > 1 ? `${index + 1}. ${question.prompt}` : question.prompt;
				const options = DOM.append(card, $('.paradis-bot-page-ask-options'));
				question.options.forEach((option, optionIndex) => {
					const chosen = selection!.options[index]?.includes(optionIndex) === true;
					const button = DOM.append(options, $('button.paradis-bot-page-ask-option.paradis-focus-ring-inset')) as HTMLButtonElement;
					button.type = 'button';
					button.classList.toggle('chosen', chosen);
					button.setAttribute('aria-pressed', String(chosen));
					DOM.append(button, $('span')).textContent = option.label;
					if (question.recommended === optionIndex) {
						DOM.append(button, $('span.paradis-bot-page-ask-recommended')).textContent = localize('paradis.botPage.ask.recommended', "おすすめ");
					}
					if (option.detail) {
						button.title = option.detail;
					}
					this.panelStore.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
						selection!.options[index] = paradisBotAskToggle(selection!.options[index] ?? [], optionIndex, question.multi === true);
						this.renderPanel();
					}));
				});
			}
			const frame = DOM.append(card, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.paradis-bot-page-ask-text'));
			const text = DOM.append(frame, $('textarea')) as HTMLTextAreaElement;
			text.rows = 1;
			text.value = selection!.texts[index] ?? '';
			text.placeholder = question !== undefined ? localize('paradis.botPage.ask.own', "自分の言葉で答える（任意）") : localize('paradis.botPage.ask.reply', "返事を書く");
			text.setAttribute('aria-label', text.placeholder);
			this.panelStore.add(DOM.addDisposableListener(text, DOM.EventType.INPUT, () => {
				selection!.texts[index] = text.value;
				submit.enabled = paradisBotAskAnswer(ask, selection as IParadisBotAskSelection) !== undefined && !this.answering;
			}));
		});
		const actions = DOM.append(card, $('.paradis-bot-page-ask-actions'));
		const submit = this.panelStore.add(new ParadisButton(actions, { kind: 'primary', label: localize('paradis.botPage.ask.submit', "答える") }));
		submit.enabled = paradisBotAskAnswer(ask, selection) !== undefined && !this.answering;
		this.panelStore.add(submit.onDidClick(() => {
			const answer = paradisBotAskAnswer(ask, selection as IParadisBotAskSelection);
			if (answer !== undefined) {
				void this.answer(key, answer);
			}
		}));
		const skip = this.panelStore.add(new ParadisButton(actions, { kind: 'ghost', label: localize('paradis.botPage.ask.skip', "飛ばす") }));
		this.panelStore.add(skip.onDidClick(() => void this.answer(key, { type: 'skip' })));
	}

	private async answer(key: string, answer: Parameters<IParadisHumanAskService['answer']>[1]): Promise<void> {
		if (this.answering) {
			return;
		}
		this.answering = true;
		this.renderPanel();
		try {
			const result = await this.humanAskService.answer(key, answer, 'bot');
			if (!result.ok) {
				this.notificationService.warn(result.reason === 'gone'
					? localize('paradis.botPage.ask.gone', "この問いはもう答えられません（Bot が先へ進んだか、ほかの場所で答えました）。")
					: localize('paradis.botPage.ask.failed', "答えを送れませんでした。少し待ってからもう一度送ってください。"));
			} else {
				this.selections.delete(key);
			}
		} finally {
			this.answering = false;
			if (!this._store.isDisposed) {
				void this.loadItems();
			}
		}
	}

	private renderComment(body: HTMLElement, item: IParadisBotItem): void {
		const frame = DOM.append(body, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.paradis-bot-page-comment'));
		const text = DOM.append(frame, $('textarea')) as HTMLTextAreaElement;
		text.rows = 2;
		text.placeholder = localize('paradis.botPage.comment', "Bot へコメントを書く");
		text.setAttribute('aria-label', text.placeholder);
		const actions = DOM.append(body, $('.paradis-bot-page-comment-actions'));
		const send = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.commentSend', "コメントを送る") }));
		send.enabled = false;
		this.panelStore.add(DOM.addDisposableListener(text, DOM.EventType.INPUT, () => send.enabled = text.value.trim().length > 0));
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
			void this.loadItems();
		}));
	}

	private renderActions(body: HTMLElement, item: IParadisBotItem): void {
		const actions = DOM.append(body, $('.paradis-bot-page-item-actions'));
		const done = this.panelStore.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.done', "完了にする") }));
		this.panelStore.add(done.onDidClick(() => void this.setStatus(item, 'done')));
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

	private async setStatus(item: IParadisBotItem, to: 'done' | 'canceled'): Promise<void> {
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
		// 帯・面と、下の会話を下げる印を外す（タブを閉じた・別の窓へ動いた・登録を外したとき）。畳んだ見出しは戻す
		this.syncHeaderHidden(undefined);
		this.strip.remove();
		this.panel.remove();
		this.container.classList.remove(ACTIVE_CLASS, ITEMS_CLASS);
		super.dispose();
	}
}
