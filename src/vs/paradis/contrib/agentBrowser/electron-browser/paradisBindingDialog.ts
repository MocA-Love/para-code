/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナルペイン紐付けのバインディングダイアログ（モーダル）。
// upstreamの Dialog ウィジェットには依存せず、workbenchコンテナへ自前のbackdrop+モーダルDOMを
// 重ねる方式（見た目・構造は scratchpad の UIモック para-code-agent-browser-binding-mock.html 準拠、
// 色はハードコードせず --vscode-* テーマトークンを使う）。

import './media/paradisBindingDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';
import { IParadisAgentBrowserBindingModel, IParadisPaneDescriptor } from './paradisAgentBrowserBindingModel.js';
import { getParadisClaudeSetupSnippet, getParadisCodexSetupSnippet, getParadisMcpEndpointForToken } from './paradisMcpSnippets.js';

const $ = dom.$;

// --- UI文字列（日本語。hygieneのunicodeチェック対策として1行ずつマーカーを付ける） ---
// allow-any-unicode-next-line
const STR_DIALOG_TITLE = localize('paradis.bindingDialog.title', "ブラウザページをエージェントと共有");
// allow-any-unicode-next-line
const STR_SUMMARY_SHARED = localize('paradis.bindingDialog.summaryShared', "共有中");
// allow-any-unicode-next-line
const STR_SUMMARY_NEEDS_MCP = localize('paradis.bindingDialog.summaryNeedsMcp', "MCP未接続");
// allow-any-unicode-next-line
const STR_SUMMARY_IDLE = localize('paradis.bindingDialog.summaryIdle', "未接続のペイン");
// allow-any-unicode-next-line
const STR_TAB_PANES = localize('paradis.bindingDialog.tabPanes', "ターミナルペイン");
// allow-any-unicode-next-line
const STR_TAB_SETUP = localize('paradis.bindingDialog.tabSetup', "MCP接続設定");
// allow-any-unicode-next-line
const STR_TAB_PERMS = localize('paradis.bindingDialog.tabPerms', "権限");
// allow-any-unicode-next-line
const STR_PILL_BOUND_HERE = localize('paradis.bindingDialog.pillBoundHere', "このページを共有中");
// allow-any-unicode-next-line
const STR_PILL_BOUND_ELSE = localize('paradis.bindingDialog.pillBoundElse', "別のページを共有中");
// allow-any-unicode-next-line
const STR_PILL_READY_AGENT = localize('paradis.bindingDialog.pillReadyAgent', "接続済み・空き");
// allow-any-unicode-next-line
const STR_PILL_NEEDS_MCP = localize('paradis.bindingDialog.pillNeedsMcp', "MCP未接続");
// allow-any-unicode-next-line
const STR_META_NO_MCP = localize('paradis.bindingDialog.metaNoMcp', "MCPサーバー未接続");
// allow-any-unicode-next-line
const STR_BTN_UNBIND = localize('paradis.bindingDialog.btnUnbind', "共有を解除");
// allow-any-unicode-next-line
const STR_BTN_BIND = localize('paradis.bindingDialog.btnBind', "このページと共有");
// allow-any-unicode-next-line
const strTerminalId = (id: number) => localize('paradis.bindingDialog.terminalId', "ターミナルID: {0}", id);
// allow-any-unicode-next-line
const STR_PAGE_PILL_UNBOUND = localize('paradis.bindingDialog.pagePillUnbound', "未共有");
// allow-any-unicode-next-line
const strPagePillBound = (paneName: string) => localize('paradis.bindingDialog.pagePillBound', "{0} と共有中", paneName);
// allow-any-unicode-next-line
const STR_KV_WINDOW = localize('paradis.bindingDialog.kvWindow', "ウィンドウ");
// allow-any-unicode-next-line
const STR_KV_SINCE = localize('paradis.bindingDialog.kvSince', "共有開始");
// allow-any-unicode-next-line
const STR_KV_PERMS = localize('paradis.bindingDialog.kvPerms', "権限");
// allow-any-unicode-next-line
const STR_KV_PERMS_VALUE = localize('paradis.bindingDialog.kvPermsValue', "読み取り+操作");
// allow-any-unicode-next-line
const STR_SEARCH_PLACEHOLDER = localize('paradis.bindingDialog.searchPlaceholder', "ペインを検索…");
// allow-any-unicode-next-line
const STR_SETUP_TITLE = localize('paradis.bindingDialog.setupTitle', "MCP接続設定");
// allow-any-unicode-next-line
const strSetupDesc = (paneName: string) => localize('paradis.bindingDialog.setupDesc', "選択中のペイン（{0}）にPara CodeのMCPサーバーを登録します。コマンドはこのペインの環境変数を参照するため、コピーしてそのまま実行するだけでこのペイン専用のエンドポイントに接続されます。", paneName);
// allow-any-unicode-next-line
const STR_SETUP_DESC_NO_PANE = localize('paradis.bindingDialog.setupDescNoPane', "ターミナルペインにPara CodeのMCPサーバーを登録します。コマンドはペインの環境変数を参照するため、コピーしてそのまま実行するだけでそのペイン専用のエンドポイントに接続されます。");
// allow-any-unicode-next-line
const STR_SETUP_CLAUDE_LABEL = localize('paradis.bindingDialog.setupClaudeLabel', "セットアップコマンド（stdio型、初回のみ）");
// allow-any-unicode-next-line
const STR_SETUP_CODEX_LABEL = localize('paradis.bindingDialog.setupCodexLabel', "~/.codex/config.toml に追記");
// allow-any-unicode-next-line
const STR_SETUP_ENDPOINT_LABEL = localize('paradis.bindingDialog.setupEndpointLabel', "このペインのエンドポイント（参考）");
// allow-any-unicode-next-line
const STR_FOOTER_HINT = localize('paradis.bindingDialog.footerHint', "共有中は該当ペインの接続アイコンが緑色になります");
// allow-any-unicode-next-line
const STR_BTN_CLOSE = localize('paradis.bindingDialog.btnClose', "閉じる");
// allow-any-unicode-next-line
const strBtnBindPrimary = (paneName: string) => localize('paradis.bindingDialog.btnBindPrimary', "{0} と共有する", paneName);
// allow-any-unicode-next-line
const strBtnUnbindPrimary = (paneName: string) => localize('paradis.bindingDialog.btnUnbindPrimary', "{0} との共有を解除する", paneName);
// allow-any-unicode-next-line
const strMinutesAgo = (minutes: number) => localize('paradis.bindingDialog.minutesAgo', "{0}分前", minutes);
// allow-any-unicode-next-line
const strHoursAgo = (hours: number) => localize('paradis.bindingDialog.hoursAgo', "{0}時間前", hours);
// allow-any-unicode-next-line
const STR_JUST_NOW = localize('paradis.bindingDialog.justNow', "たった今");
// allow-any-unicode-next-line
const STR_NO_PANES = localize('paradis.bindingDialog.noPanes', "ペイントークンを持つターミナルペインがありません。新しいターミナルを開いてください。");
// allow-any-unicode-next-line
const STR_BTN_NO_PANES = localize('paradis.bindingDialog.btnNoPanes', "共有できるペインがありません");
// allow-any-unicode-next-line
const STR_CLOSE_ARIA = localize('paradis.bindingDialog.closeAria', "閉じる");
// allow-any-unicode-next-line
const STR_PERM_READ_TITLE = localize('paradis.bindingDialog.permReadTitle', "ページの読み取り");
// allow-any-unicode-next-line
const STR_PERM_READ_DESC = localize('paradis.bindingDialog.permReadDesc', "共有したページのURL・タイトル・アクセシビリティスナップショットを、バインド先ペインのエージェントが読み取れます。");
// allow-any-unicode-next-line
const STR_PERM_DRIVE_TITLE = localize('paradis.bindingDialog.permDriveTitle', "ページの操作（CDP）");
// allow-any-unicode-next-line
const STR_PERM_DRIVE_DESC = localize('paradis.bindingDialog.permDriveDesc', "chrome-devtools-mcp等のCDPツールから、共有したページのクリック・入力・スクリーンショット取得などの操作ができます。Cookie等の保存データにも触れる可能性があります。");
// allow-any-unicode-next-line
const STR_PERM_ISOLATION_TITLE = localize('paradis.bindingDialog.permIsolationTitle', "ペイン分離");
// allow-any-unicode-next-line
const STR_PERM_ISOLATION_DESC = localize('paradis.bindingDialog.permIsolationDesc', "アクセスできるのは各ペインに共有されたページのみです。他のペインに共有されたページや、共有していないブラウザタブへのアタッチは拒否されます。");

type DialogTab = 'panes' | 'setup' | 'perms';

export interface IParadisBindingDialogOptions {
	/** 開いた時点で選択状態にするペインのターミナルインスタンスID。 */
	readonly selectInstanceId?: number;
}

/**
 * バインディングダイアログ本体。1回のopenごとに生成し、閉じるとdisposeされる。
 */
export class ParadisBindingDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _summaryBar: HTMLElement;
	private readonly _colLeft: HTMLElement;
	private readonly _colMid: HTMLElement;
	private readonly _colRight: HTMLElement;
	private readonly _footer: HTMLElement;
	private readonly _tabElements = new Map<DialogTab, HTMLElement>();
	private readonly _renderDisposables = this._register(new DisposableStore());

	private _activeTab: DialogTab = 'panes';
	private _activeCli: 'claude' | 'codex' = 'claude';
	private _selectedToken: string | undefined;
	private _filterText = '';

	constructor(
		private readonly pageModel: IBrowserViewModel,
		options: IParadisBindingDialogOptions | undefined,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@ILayoutService layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		if (options?.selectInstanceId !== undefined) {
			const pane = this.bindingModel.getPanes().find(p => p.instanceId === options.selectInstanceId);
			this._selectedToken = pane?.token;
		}

		this._backdrop = $('.paradis-binding-dialog-backdrop');
		const modal = $('.paradis-binding-dialog');
		this._backdrop.appendChild(modal);

		// --- header ---
		const header = dom.append(modal, $('.pbd-header'));
		const titles = dom.append(header, $('.pbd-titles'));
		dom.append(titles, $('h2')).textContent = STR_DIALOG_TITLE;
		const closeBtn = dom.append(header, $('.pbd-close'));
		closeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', STR_CLOSE_ARIA);
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.close()));

		// --- summary bar ---
		this._summaryBar = dom.append(modal, $('.pbd-summary-bar'));

		// --- tabs ---
		const tabsBar = dom.append(modal, $('.pbd-tabs'));
		this._createTab(tabsBar, 'panes', Codicon.layout, STR_TAB_PANES);
		this._createTab(tabsBar, 'setup', Codicon.plug, STR_TAB_SETUP);
		this._createTab(tabsBar, 'perms', Codicon.lock, STR_TAB_PERMS);

		// --- columns ---
		const columns = dom.append(modal, $('.pbd-columns'));
		this._colLeft = dom.append(columns, $('.pbd-col-left'));
		this._colMid = dom.append(columns, $('.pbd-col-mid'));
		this._colRight = dom.append(columns, $('.pbd-col-right'));

		// --- footer ---
		this._footer = dom.append(modal, $('.pbd-footer'));

		// --- behavior ---
		modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.close();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this.close();
			}
		}));

		this._register(this.bindingModel.onDidChange(() => this._render()));
		this._register(this.pageModel.onDidChangeTitle(() => this._render()));
		this._register(this.pageModel.onDidChangeSharingState(() => this._render()));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._render();
		modal.focus();
		void this.bindingModel.refresh();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	// --- rendering ------------------------------------------------------

	private _createTab(container: HTMLElement, tab: DialogTab, icon: ThemeIcon, label: string): void {
		const element = dom.append(container, $('.pbd-tab'));
		element.appendChild($(`span${ThemeIcon.asCSSSelector(icon)}`));
		dom.append(element, $('span')).textContent = label;
		this._register(dom.addDisposableListener(element, 'click', () => {
			this._activeTab = tab;
			this._render();
		}));
		this._tabElements.set(tab, element);
	}

	private _panes(): IParadisPaneDescriptor[] {
		return this.bindingModel.getPanes();
	}

	private _paneDisplayName(pane: IParadisPaneDescriptor): string {
		return `${pane.title} — pane #${pane.instanceId}`;
	}

	private _selectedPane(): IParadisPaneDescriptor | undefined {
		const panes = this._panes();
		const selected = this._selectedToken ? panes.find(p => p.token === this._selectedToken) : undefined;
		if (selected) {
			return selected;
		}
		// 既定の選択: このページにバインド済みのペイン → 共有可能なエージェントペイン → 先頭。
		return panes.find(p => p.binding?.pageId === this.pageModel.id)
			?? panes.find(p => p.agentKind !== 'shell' && !p.binding)
			?? panes[0];
	}

	private _isBindablePane(pane: IParadisPaneDescriptor): boolean {
		// トークンを持つペインは、CLIの起動状況やMCP接続実績に関係なく常にバインド可能。
		// （バインド → CLI起動 → 接続、の順序も普通なので、事前にブロックしない。）
		return pane.binding?.pageId !== this.pageModel.id;
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._renderDisposables.clear();

		const panes = this._panes();
		const pageBindings = this.bindingModel.getBindingsForPage(this.pageModel.id);
		const boundPanes = panes.filter(p => !!p.binding);
		const needsMcpPanes = panes.filter(p => !p.binding && p.agentKind !== 'shell' && !p.mcpConnected);
		const idlePanes = panes.filter(p => !p.binding && !needsMcpPanes.includes(p));

		// tabs active state
		for (const [tab, element] of this._tabElements) {
			element.classList.toggle('active', tab === this._activeTab);
		}

		this._renderSummary(boundPanes.length, needsMcpPanes.length, idlePanes.length);
		this._renderLeft(panes, pageBindings);
		this._renderMid(panes);
		this._renderRight();
		this._renderFooter();
	}

	private _renderSummary(shared: number, needsMcp: number, idle: number): void {
		dom.clearNode(this._summaryBar);
		const chip = (kind: string, count: number, label: string) => {
			const element = dom.append(this._summaryBar, $(`.pbd-summary-chip.${kind}`));
			dom.append(element, $('.pbd-dot'));
			dom.append(element, $('b')).textContent = String(count);
			dom.append(element, $('span.pbd-lbl')).textContent = label;
		};
		chip('green', shared, STR_SUMMARY_SHARED);
		chip('amber', needsMcp, STR_SUMMARY_NEEDS_MCP);
		chip('gray', idle, STR_SUMMARY_IDLE);
	}

	private _renderLeft(panes: IParadisPaneDescriptor[], pageBindings: readonly { readonly token: string; readonly boundAt: number }[]): void {
		dom.clearNode(this._colLeft);

		const card = dom.append(this._colLeft, $('.pbd-page-card'));
		const faviconRow = dom.append(card, $('.pbd-favicon-row'));
		const favicon = dom.append(faviconRow, $('.pbd-favicon'));
		if (this.pageModel.favicon) {
			const img = dom.append(favicon, $('img')) as HTMLImageElement;
			img.src = this.pageModel.favicon;
			img.alt = '';
		} else {
			favicon.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.globe)}`));
		}
		const titleWrap = dom.append(faviconRow, $('div'));
		dom.append(titleWrap, $('.pbd-page-title')).textContent = this.pageModel.title || this.pageModel.url;
		dom.append(titleWrap, $('.pbd-page-url')).textContent = this.pageModel.url;

		const isBound = pageBindings.length > 0;
		const pill = dom.append(card, $(`.pbd-status-pill.${isBound ? 'bound' : 'unbound'}`));
		if (isBound) {
			dom.append(pill, $('.pbd-pulse'));
			const firstBoundPane = panes.find(p => p.binding?.pageId === this.pageModel.id);
			const name = firstBoundPane ? this._paneDisplayName(firstBoundPane) : '';
			dom.append(pill, $('span')).textContent = strPagePillBound(name);
		} else {
			dom.append(pill, $('span')).textContent = STR_PAGE_PILL_UNBOUND;
		}

		dom.append(card, $('.pbd-divider'));
		const kv = (key: string, value: string) => {
			const row = dom.append(card, $('.pbd-kv'));
			dom.append(row, $('span')).textContent = key;
			dom.append(row, $('b')).textContent = value;
		};
		kv(STR_KV_WINDOW, this.workspaceContextService.getWorkspace().folders[0]?.name ?? '—');
		if (isBound) {
			const earliest = Math.min(...pageBindings.map(b => b.boundAt));
			kv(STR_KV_SINCE, formatRelativeTime(earliest));
		}
		kv(STR_KV_PERMS, STR_KV_PERMS_VALUE);

		if (isBound) {
			const disconnect = dom.append(card, $('button.pbd-disconnect-btn'));
			disconnect.textContent = STR_BTN_UNBIND;
			this._renderDisposables.add(dom.addDisposableListener(disconnect, 'click', () => {
				void this.bindingModel.unbindPage(this.pageModel);
			}));
		}
	}

	private _renderMid(panes: IParadisPaneDescriptor[]): void {
		dom.clearNode(this._colMid);
		this._colMid.style.display = this._activeTab === 'setup' ? 'none' : 'flex';
		if (this._activeTab === 'setup') {
			return;
		}
		if (this._activeTab === 'perms') {
			this._renderPerms();
			return;
		}

		// search box
		const search = dom.append(this._colMid, $('.pbd-list-search'));
		search.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		const input = dom.append(search, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = STR_SEARCH_PLACEHOLDER;
		input.value = this._filterText;
		this._renderDisposables.add(dom.addDisposableListener(input, 'input', () => {
			this._filterText = input.value;
			this._renderPaneList(listContainer, panes);
		}));

		const listContainer = dom.append(this._colMid, $('.pbd-pane-list'));
		this._renderPaneList(listContainer, panes);
	}

	private _renderPaneList(container: HTMLElement, panes: IParadisPaneDescriptor[]): void {
		dom.clearNode(container);
		const filter = this._filterText.trim().toLowerCase();
		const visible = filter
			? panes.filter(p => this._paneDisplayName(p).toLowerCase().includes(filter))
			: panes;
		if (visible.length === 0) {
			dom.append(container, $('.pbd-empty')).textContent = STR_NO_PANES;
			return;
		}
		const selected = this._selectedPane();
		for (const pane of visible) {
			container.appendChild(this._renderPaneCard(pane, pane === selected));
		}
	}

	private _renderPaneCard(pane: IParadisPaneDescriptor, selected: boolean): HTMLElement {
		const card = $('.pbd-pane-card');
		card.classList.toggle('selected', selected);

		const row1 = dom.append(card, $('.pbd-row1'));
		const agentIcon = dom.append(row1, $(`.pbd-agent-icon.${pane.agentKind}`));
		agentIcon.appendChild($(`span${ThemeIcon.asCSSSelector(agentIconFor(pane.agentKind))}`));
		const titles = dom.append(row1, $('.pbd-titles'));
		dom.append(titles, $('.pbd-name')).textContent = this._paneDisplayName(pane);
		dom.append(titles, $('.pbd-meta')).textContent = this._paneMeta(pane);

		const boundHere = pane.binding?.pageId === this.pageModel.id;
		const boundElse = !!pane.binding && !boundHere;
		let pillClass: string;
		let pillText: string;
		if (boundHere) {
			pillClass = 'driving-here';
			pillText = STR_PILL_BOUND_HERE;
		} else if (boundElse) {
			pillClass = 'driving-else';
			pillText = STR_PILL_BOUND_ELSE;
		} else if (pane.mcpConnected) {
			// MCP/CDP接続実績あり（このペインのCLIが実際にMCPを叩いた）。
			pillClass = 'ready';
			pillText = STR_PILL_READY_AGENT;
		} else {
			// 接続実績なし。バインドは可能。CLI未起動/未接続というヒントに留める。
			pillClass = 'needs-mcp';
			pillText = STR_PILL_NEEDS_MCP;
		}
		dom.append(row1, $(`.pbd-pane-pill.${pillClass}`)).textContent = pillText;

		const row2 = dom.append(card, $('.pbd-row2'));
		const gridLoc = dom.append(row2, $('.pbd-grid-loc'));
		gridLoc.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.layout)}`));
		dom.append(gridLoc, $('span')).textContent = strTerminalId(pane.instanceId);

		const button = dom.append(row2, $('button.pbd-bind-btn')) as HTMLButtonElement;
		if (boundHere) {
			button.classList.add('unbind');
			button.textContent = STR_BTN_UNBIND;
			this._renderDisposables.add(dom.addDisposableListener(button, 'click', e => {
				e.stopPropagation();
				void this.bindingModel.unbindPane(this.pageModel, pane.token);
			}));
		} else {
			// バインドはトークンさえあれば常に可能（CLI起動やMCP接続の有無でブロックしない）。
			button.textContent = STR_BTN_BIND;
			this._renderDisposables.add(dom.addDisposableListener(button, 'click', e => {
				e.stopPropagation();
				void this.bindingModel.bindPageToPane(this.pageModel, pane.token);
			}));
		}

		this._renderDisposables.add(dom.addDisposableListener(card, 'click', () => {
			this._selectedToken = pane.token;
			this._render();
		}));
		return card;
	}

	private _paneMeta(pane: IParadisPaneDescriptor): string {
		// エージェント種別の推定はタイトルからのベストエフォートで外れやすい（claude起動中でも
		// タイトルにclaudeが出ない等）。誤って「未起動」と断定すると紛らわしいので、
		// トークンを常に表示し、MCP未接続はヒントとしてのみ出す。
		if (!pane.mcpConnected && !pane.binding) {
			return STR_META_NO_MCP;
		}
		return `${PARADIS_PANE_TOKEN_ENV_VAR}=${abbreviateToken(pane.token)}`;
	}

	private _renderPerms(): void {
		const list = dom.append(this._colMid, $('.pbd-perm-list'));
		const item = (icon: ThemeIcon, title: string, desc: string) => {
			const element = dom.append(list, $('.pbd-perm-item'));
			element.appendChild($(`span${ThemeIcon.asCSSSelector(icon)}`));
			const body = dom.append(element, $('div'));
			dom.append(body, $('.pbd-perm-title')).textContent = title;
			dom.append(body, $('.pbd-perm-desc')).textContent = desc;
		};
		item(Codicon.eye, STR_PERM_READ_TITLE, STR_PERM_READ_DESC);
		item(Codicon.warning, STR_PERM_DRIVE_TITLE, STR_PERM_DRIVE_DESC);
		item(Codicon.lock, STR_PERM_ISOLATION_TITLE, STR_PERM_ISOLATION_DESC);
	}

	private _renderRight(): void {
		dom.clearNode(this._colRight);
		const pane = this._selectedPane();

		const card = dom.append(this._colRight, $('.pbd-setup-card'));
		dom.append(card, $('h3')).textContent = STR_SETUP_TITLE;
		dom.append(card, $('.pbd-desc')).textContent = pane
			? strSetupDesc(this._paneDisplayName(pane))
			: STR_SETUP_DESC_NO_PANE;

		// CLI tabs
		const cliTabs = dom.append(card, $('.pbd-cli-tabs'));
		const cliTab = (kind: 'claude' | 'codex', label: string) => {
			const element = dom.append(cliTabs, $('.pbd-cli-tab'));
			element.classList.toggle('active', this._activeCli === kind);
			dom.append(element, $('span')).textContent = label;
			this._renderDisposables.add(dom.addDisposableListener(element, 'click', () => {
				this._activeCli = kind;
				this._render();
			}));
		};
		cliTab('claude', 'Claude Code CLI');
		cliTab('codex', 'Codex CLI');

		// snippet
		const label = this._activeCli === 'claude' ? STR_SETUP_CLAUDE_LABEL : STR_SETUP_CODEX_LABEL;
		const snippet = this._activeCli === 'claude' ? getParadisClaudeSetupSnippet() : getParadisCodexSetupSnippet();
		dom.append(card, $('.pbd-field-label')).textContent = label;
		const codeBlock = dom.append(card, $('.pbd-code-block'));
		dom.append(codeBlock, $('pre')).textContent = snippet.trimEnd();
		this._appendCopyButton(codeBlock, snippet, 'pbd-copy-btn');

		// endpoint
		if (pane) {
			dom.append(card, $('.pbd-field-label')).textContent = STR_SETUP_ENDPOINT_LABEL;
			const endpointRow = dom.append(card, $('.pbd-endpoint-row'));
			const endpoint = getParadisMcpEndpointForToken(pane.token);
			dom.append(endpointRow, $('.pbd-url')).textContent = endpoint;
			this._appendCopyButton(endpointRow, endpoint, 'pbd-icon-btn');
		}
	}

	private _appendCopyButton(container: HTMLElement, text: string, className: string): void {
		const button = dom.append(container, $(`.${className}`));
		const icon = button.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.copy)}`));
		this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => {
			void this.clipboardService.writeText(text);
			button.classList.add('copied');
			icon.className = ThemeIcon.asClassName(Codicon.check);
			this._renderDisposables.add(disposableTimeout(() => {
				button.classList.remove('copied');
				icon.className = ThemeIcon.asClassName(Codicon.copy);
			}, 1200));
		}));
	}

	private _renderFooter(): void {
		dom.clearNode(this._footer);
		const hint = dom.append(this._footer, $('.pbd-hint'));
		hint.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.info)}`));
		dom.append(hint, $('span')).textContent = STR_FOOTER_HINT;

		const closeButton = dom.append(this._footer, $('button.pbd-btn')) as HTMLButtonElement;
		closeButton.textContent = STR_BTN_CLOSE;
		this._renderDisposables.add(dom.addDisposableListener(closeButton, 'click', () => this.close()));

		const pane = this._selectedPane();
		const primary = dom.append(this._footer, $('button.pbd-btn.primary')) as HTMLButtonElement;
		if (pane && pane.binding?.pageId === this.pageModel.id) {
			primary.textContent = strBtnUnbindPrimary(this._paneDisplayName(pane));
			this._renderDisposables.add(dom.addDisposableListener(primary, 'click', () => {
				void this.bindingModel.unbindPane(this.pageModel, pane.token);
			}));
		} else if (pane && this._isBindablePane(pane)) {
			primary.textContent = strBtnBindPrimary(this._paneDisplayName(pane));
			this._renderDisposables.add(dom.addDisposableListener(primary, 'click', () => {
				void this.bindingModel.bindPageToPane(this.pageModel, pane.token);
			}));
		} else {
			// ここに来るのは選択ペインが無いとき（ペインが1つも無い）だけ。
			primary.textContent = STR_BTN_NO_PANES;
			primary.disabled = true;
		}
	}
}

// --- helpers -------------------------------------------------------------

function agentIconFor(kind: 'claude' | 'codex' | 'shell'): ThemeIcon {
	switch (kind) {
		case 'claude': return Codicon.sparkle;
		case 'codex': return Codicon.hubot;
		case 'shell': return Codicon.terminal;
	}
}

function abbreviateToken(token: string): string {
	if (token.length <= 12) {
		return token;
	}
	return `${token.slice(0, 4)}…${token.slice(-3)}`;
}

function formatRelativeTime(epochMs: number): string {
	const deltaMinutes = Math.floor((Date.now() - epochMs) / 60000);
	if (deltaMinutes < 1) {
		return STR_JUST_NOW;
	}
	if (deltaMinutes < 60) {
		return strMinutesAgo(deltaMinutes);
	}
	return strHoursAgo(Math.floor(deltaMinutes / 60));
}
