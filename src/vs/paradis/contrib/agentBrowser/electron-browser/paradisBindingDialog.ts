/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナルペイン紐付けのバインディングダイアログ（モーダル）。
// upstreamの Dialog ウィジェットには依存せず、workbenchコンテナへ自前のbackdrop+モーダルDOMを
// 重ねる方式。構造は確定デザインモック（aaaa.html: ページバー1本 + ペイン行の行内「共有/解除」+
// 「MCP接続設定」タブ）に準拠し、色はハードコードせず --vscode-* テーマトークンを使う。

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
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { appendParadisAgentLogoSvg } from '../../limitsMonitor/electron-browser/paradisLimitsLogos.js';
import { IParadisMcpCliConfigStatus, IParadisMcpConfigStatus, IParadisMcpSetupResult, ParadisMcpCli } from '../common/paradisAgentBrowser.js';
import { IParadisAgentBrowserBindingModel, IParadisPaneDescriptor } from './paradisAgentBrowserBindingModel.js';
import { paradisGetBindingErrorMessage, paradisGetPaneBindingAction, paradisRunDialogBind } from './paradisDialogPageResolver.js';
import { getParadisClaudeSetupSnippet, getParadisCodexSetupSnippet } from './paradisMcpSnippets.js';

const $ = dom.$;

// --- UI文字列（日本語。hygieneのunicodeチェック対策として1行ずつマーカーを付ける） ---
// allow-any-unicode-next-line
const STR_DIALOG_TITLE = localize('paradis.bindingDialog.title', "ブラウザページをエージェントと共有");
// allow-any-unicode-next-line
const STR_CLOSE_ARIA = localize('paradis.bindingDialog.closeAria', "閉じる");
// allow-any-unicode-next-line
const STR_TAB_PANES = localize('paradis.bindingDialog.tabPanes', "ターミナルペイン");
// allow-any-unicode-next-line
const STR_TAB_MCP = localize('paradis.bindingDialog.tabMcp', "MCP接続設定");
// allow-any-unicode-next-line
const STR_TAB_MCP_WARN_ARIA = localize('paradis.bindingDialog.tabMcpWarnAria', "要対応の設定があります");
// allow-any-unicode-next-line
const STR_PAGE_PILL_SHARED = localize('paradis.bindingDialog.pagePillShared', "共有中");
// allow-any-unicode-next-line
const STR_PAGE_PILL_UNSHARED = localize('paradis.bindingDialog.pagePillUnshared', "未共有");
// allow-any-unicode-next-line
const STR_SEARCH_PLACEHOLDER = localize('paradis.bindingDialog.searchPlaceholder', "ペインを検索…");
// allow-any-unicode-next-line
const STR_NO_PANES = localize('paradis.bindingDialog.noPanes', "共有できるターミナルペインがありません。新しいターミナルでエージェントCLIを起動してください。");
// allow-any-unicode-next-line
const STR_SCOPE_NOTE = localize('paradis.bindingDialog.scopeNote', "別のスペースにあるペインはここには表示されません（スペースを跨ぐ共有は未対応）");
// allow-any-unicode-next-line
const strSubBoundHere = (since: string) => localize('paradis.bindingDialog.subBoundHere', "このページを共有中 · {0}から", since);
// allow-any-unicode-next-line
const strSubBoundElse = (title: string) => localize('paradis.bindingDialog.subBoundElse', "別のページを共有中: {0}", title);
// allow-any-unicode-next-line
const STR_SUB_READY = localize('paradis.bindingDialog.subReady', "接続済み・空き");
// allow-any-unicode-next-line
const STR_SUB_NEEDS_MCP = localize('paradis.bindingDialog.subNeedsMcp', "MCP未接続 — 共有は可能。接続はMCP接続設定タブから");
// allow-any-unicode-next-line
const STR_BTN_ROW_SHARE = localize('paradis.bindingDialog.btnRowShare', "共有");
// allow-any-unicode-next-line
const STR_BTN_ROW_UNSHARE = localize('paradis.bindingDialog.btnRowUnshare', "解除");
// allow-any-unicode-next-line
const STR_FOOTER_HINT = localize('paradis.bindingDialog.footerHint', "エージェントは共有したこのページだけを読み取り・操作できます");
// allow-any-unicode-next-line
const STR_BTN_CLOSE = localize('paradis.bindingDialog.btnClose', "閉じる");
// allow-any-unicode-next-line
const strBindFailed = (detail: string) => localize('paradis.bindingDialog.bindFailed', "共有に失敗しました: {0}", detail);
// allow-any-unicode-next-line
const STR_META_SCOPE_PENDING = localize('paradis.bindingDialog.metaScopePending', "スペース情報の同期中です。しばらくしてから再試行してください。");
// allow-any-unicode-next-line
const STR_META_SCOPE_MISMATCH = localize('paradis.bindingDialog.metaScopeMismatch', "このページとは別のスペースにあるため共有できません。");
// allow-any-unicode-next-line
const strMinutesAgo = (minutes: number) => localize('paradis.bindingDialog.minutesAgo', "{0}分前", minutes);
// allow-any-unicode-next-line
const strHoursAgo = (hours: number) => localize('paradis.bindingDialog.hoursAgo', "{0}時間前", hours);
// allow-any-unicode-next-line
const STR_JUST_NOW = localize('paradis.bindingDialog.justNow', "たった今");

// --- MCP接続設定タブ ---
// allow-any-unicode-next-line
const STR_MCP_PILL_CONFIGURED = localize('paradis.bindingDialog.mcpPillConfigured', "設定済み");
// allow-any-unicode-next-line
const STR_MCP_PILL_UNCONFIGURED = localize('paradis.bindingDialog.mcpPillUnconfigured', "未設定");
// allow-any-unicode-next-line
const STR_MCP_PILL_NEEDS_FIX = localize('paradis.bindingDialog.mcpPillNeedsFix', "要修正");
// allow-any-unicode-next-line
const STR_MCP_PILL_FAILED = localize('paradis.bindingDialog.mcpPillFailed', "判定できません");
// allow-any-unicode-next-line
const STR_MCP_PILL_LOADING = localize('paradis.bindingDialog.mcpPillLoading', "確認中");
// allow-any-unicode-next-line
const STR_BTN_AUTO_SETUP = localize('paradis.bindingDialog.btnAutoSetup', "自動セットアップ");
// allow-any-unicode-next-line
const STR_BTN_FIX = localize('paradis.bindingDialog.btnFix', "ワンクリックで修正");
// allow-any-unicode-next-line
const STR_SETUP_RUNNING = localize('paradis.bindingDialog.setupRunning', "実行中…");
// allow-any-unicode-next-line
const strMcpDetailConfigured = (path: string) => localize('paradis.bindingDialog.mcpDetailConfigured', "{0} に para-browser（shim方式）を検出しました。Para Codeの再起動後もサーバーポートに自動追従します。", path);
// allow-any-unicode-next-line
const strMcpDetailUnconfigured = (path: string) => localize('paradis.bindingDialog.mcpDetailUnconfigured', "para-browser（MCPサーバー）が未登録です。自動セットアップで {0} に追加します。", path);
// allow-any-unicode-next-line
const strMcpDetailNeedsFix = (port: number) => localize('paradis.bindingDialog.mcpDetailNeedsFix', "chrome-devtools 系エントリが古いポート（127.0.0.1:{0}）を固定参照しています。現在のエンドポイントに接続できません。ワンクリックでポートファイル参照方式（shim）へ書き換えます。", port);
// allow-any-unicode-next-line
const strMcpDetailManualOnly = (path: string) => localize('paradis.bindingDialog.mcpDetailManualOnly', "para-browser（MCPサーバー）が未登録です。{0} に既存のMCP設定があるため自動セットアップは行えません。下の「手動でセットアップする」からコマンドをコピーして追加してください。", path);
// allow-any-unicode-next-line
const STR_MCP_DETAIL_FAILED = localize('paradis.bindingDialog.mcpDetailFailed', "設定ファイルを読み取れませんでした。下の「手動でセットアップする」を参照してください。");
// allow-any-unicode-next-line
const STR_MCP_DETAIL_LOADING = localize('paradis.bindingDialog.mcpDetailLoading', "設定を確認しています…");
// allow-any-unicode-next-line
const STR_MANUAL_SUMMARY = localize('paradis.bindingDialog.manualSummary', "手動でセットアップする（コマンドを表示）");
// allow-any-unicode-next-line
const STR_SETUP_CLAUDE_LABEL = localize('paradis.bindingDialog.setupClaudeLabel', "Claude Code（stdio型、初回のみ）");
// allow-any-unicode-next-line
const STR_SETUP_CODEX_LABEL = localize('paradis.bindingDialog.setupCodexLabel', "~/.codex/config.toml に追記");
// allow-any-unicode-next-line
const STR_SETUP_CLAUDE_UNAVAILABLE = localize('paradis.bindingDialog.setupClaudeUnavailable', "claude CLI が PATH 上に見つかりませんでした。下のコマンドをターミナルにコピーして手動で登録してください。");
// allow-any-unicode-next-line
const strSetupChannelError = (detail: string) => localize('paradis.bindingDialog.setupChannelError', "実行に失敗しました: {0}", detail);
// allow-any-unicode-next-line
const strSetupCodexTarget = (path: string) => localize('paradis.bindingDialog.setupCodexTarget', "設定ファイル: {0}", path);
// allow-any-unicode-next-line
const strSetupServerSuccess = (server: string) => localize('paradis.bindingDialog.setupServerSuccess', "{0} を登録しました", server);
// allow-any-unicode-next-line
const strSetupServerAlready = (server: string) => localize('paradis.bindingDialog.setupServerAlready', "{0} は既に設定済みです", server);
// allow-any-unicode-next-line
const strSetupServerError = (server: string, detail: string) => localize('paradis.bindingDialog.setupServerError', "{0} の登録に失敗しました: {1}", server, detail);

/** エージェントCLIのユーザー向け表示名（製品名のため非localize）。 */
const CLI_DISPLAY_NAME: Readonly<Record<ParadisMcpCli, string>> = { claude: 'Claude Code', codex: 'Codex' };
/** 設定ファイルの表示用フレンドリーパス（未設定時は絶対パスが取れないため既定パスを出す）。 */
const CLI_CONFIG_PATH: Readonly<Record<ParadisMcpCli, string>> = { claude: '~/.claude.json', codex: '~/.codex/config.toml' };

type DialogTab = 'panes' | 'mcp';

/** CLIごとの「自動セットアップ / 修正」実行状態。 */
interface IParadisSetupState {
	readonly busy: boolean;
	readonly result?: IParadisMcpSetupResult;
	/** IPC呼び出し自体が失敗したときのメッセージ（shared process未起動等）。 */
	readonly error?: string;
}

export interface IParadisBindingDialogOptions {
	/** 開いた時点で選択状態にするペインのターミナルインスタンスID。 */
	readonly selectInstanceId?: number;
}

/**
 * バインディングダイアログ本体。1回のopenごとに生成し、閉じるとdisposeされる。
 */
export class ParadisBindingDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _pageBar: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _footer: HTMLElement;
	private readonly _tabElements = new Map<DialogTab, HTMLElement>();
	private _mcpTabBadge: HTMLElement | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());

	private _activeTab: DialogTab = 'panes';
	private _filterText = '';
	private _bindError: string | undefined;
	private _mcpStatus: IParadisMcpConfigStatus | undefined;
	private readonly _setupStates = new Map<ParadisMcpCli, IParadisSetupState>();

	constructor(
		private readonly pageModel: IBrowserViewModel,
		// 呼び出し元ペインの識別に使われていたが、行内アクションUIでは選択の概念がないため未使用。
		// API互換のため引数は維持する。
		_options: IParadisBindingDialogOptions | undefined,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@ILayoutService layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();

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

		// --- page bar ---
		this._pageBar = dom.append(modal, $('.pbd-pagebar'));

		// --- tabs ---
		const tabsBar = dom.append(modal, $('.pbd-tabs'));
		this._createTab(tabsBar, 'panes', STR_TAB_PANES);
		this._createTab(tabsBar, 'mcp', STR_TAB_MCP);

		// --- body ---
		this._body = dom.append(modal, $('.pbd-body'));

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
		void this._loadMcpStatus();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	// --- rendering ------------------------------------------------------

	private _createTab(container: HTMLElement, tab: DialogTab, label: string): void {
		const element = dom.append(container, $('.pbd-tab'));
		dom.append(element, $('span.pbd-tab-label')).textContent = label;
		if (tab === 'mcp') {
			this._mcpTabBadge = dom.append(element, $('.pbd-tab-badge.warn'));
			this._mcpTabBadge.title = STR_TAB_MCP_WARN_ARIA;
			this._mcpTabBadge.style.display = 'none';
		}
		this._register(dom.addDisposableListener(element, 'click', () => {
			this._activeTab = tab;
			this._render();
		}));
		this._tabElements.set(tab, element);
	}

	private _panes(): IParadisPaneDescriptor[] {
		return this.bindingModel.getPanesForPage(this.pageModel);
	}

	private _paneDisplayName(pane: IParadisPaneDescriptor): string {
		return `${pane.title} — pane #${pane.instanceId}`;
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._renderDisposables.clear();

		for (const [tab, element] of this._tabElements) {
			element.classList.toggle('active', tab === this._activeTab);
		}
		this._renderMcpTabBadge();
		this._renderPageBar();
		dom.clearNode(this._body);
		if (this._activeTab === 'panes') {
			this._renderPanesTab();
		} else {
			this._renderMcpTab();
		}
		this._renderFooter();
	}

	private _renderMcpTabBadge(): void {
		if (!this._mcpTabBadge) {
			return;
		}
		const needsAttention = this._mcpStatus !== undefined
			&& (this._mcpStatus.claude.state !== 'configured' || this._mcpStatus.codex.state !== 'configured');
		this._mcpTabBadge.style.display = needsAttention ? '' : 'none';
	}

	private _renderPageBar(): void {
		dom.clearNode(this._pageBar);
		const favicon = dom.append(this._pageBar, $('.pbd-favicon'));
		if (this.pageModel.favicon) {
			const img = dom.append(favicon, $('img')) as HTMLImageElement;
			img.src = this.pageModel.favicon;
			img.alt = '';
		} else {
			favicon.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.globe)}`));
		}
		const text = dom.append(this._pageBar, $('.pbd-pb-text'));
		dom.append(text, $('span.pbd-pb-title')).textContent = this.pageModel.title || this.pageModel.url;
		dom.append(text, $('span.pbd-pb-url')).textContent = this.pageModel.url;

		const isShared = this.bindingModel.getBindingsForPage(this.pageModel.id).length > 0;
		const pill = dom.append(this._pageBar, $(`.pbd-page-pill.${isShared ? 'shared' : 'unshared'}`));
		if (isShared) {
			dom.append(pill, $('.pbd-dot.green'));
			dom.append(pill, $('span')).textContent = STR_PAGE_PILL_SHARED;
		} else {
			dom.append(pill, $('.pbd-dot.gray'));
			dom.append(pill, $('span')).textContent = STR_PAGE_PILL_UNSHARED;
		}
	}

	// --- panes tab ---

	private _visiblePanes(): IParadisPaneDescriptor[] {
		// スコープ外（別スペース）のペインは一覧に出さない。ただし現在このページに共有中の行は
		// 解除できるよう常に残す。
		return this._panes().filter(pane =>
			pane.bindEligibility?.eligible === true || pane.binding?.pageId === this.pageModel.id);
	}

	private _renderPanesTab(): void {
		const search = dom.append(this._body, $('.pbd-list-search'));
		search.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		const input = dom.append(search, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = STR_SEARCH_PLACEHOLDER;
		input.value = this._filterText;

		const list = dom.append(this._body, $('.pbd-pane-list'));
		this._renderPaneList(list);
		this._renderDisposables.add(dom.addDisposableListener(input, 'input', () => {
			this._filterText = input.value;
			this._renderPaneList(list);
		}));

		dom.append(this._body, $('.pbd-scope-note')).textContent = STR_SCOPE_NOTE;
	}

	private _renderPaneList(container: HTMLElement): void {
		dom.clearNode(container);
		const filter = this._filterText.trim().toLowerCase();
		const visible = this._visiblePanes().filter(pane =>
			filter.length === 0 || this._paneDisplayName(pane).toLowerCase().includes(filter));
		if (visible.length === 0) {
			dom.append(container, $('.pbd-empty')).textContent = STR_NO_PANES;
			return;
		}
		for (const pane of visible) {
			container.appendChild(this._renderPaneRow(pane));
		}
	}

	private _renderPaneRow(pane: IParadisPaneDescriptor): HTMLElement {
		const row = $('.pbd-pane-row');
		const boundHere = pane.binding?.pageId === this.pageModel.id;
		const boundElse = !!pane.binding && !boundHere;

		const dotClass = (pane.binding || pane.mcpConnected) ? 'green' : 'amber';
		dom.append(row, $(`.pbd-dot.${dotClass}`));

		const main = dom.append(row, $('.pbd-row-main'));
		dom.append(main, $('.pbd-row-title')).textContent = this._paneDisplayName(pane);
		dom.append(main, $('.pbd-row-sub')).textContent = this._paneSubText(pane, boundHere, boundElse);

		const action = paradisGetPaneBindingAction(pane.binding?.pageId, this.pageModel.id, pane.bindEligibility);
		const button = dom.append(row, $('button.pbd-row-btn')) as HTMLButtonElement;
		if (action === 'unbind') {
			button.classList.add('unshare');
			button.textContent = STR_BTN_ROW_UNSHARE;
			this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => {
				if (boundHere) {
					void this.bindingModel.unbindPane(this.pageModel, pane.token);
				} else {
					void this.bindingModel.unbindToken(pane.token);
				}
			}));
		} else {
			button.classList.add('share');
			button.textContent = STR_BTN_ROW_SHARE;
			button.disabled = action === 'disabled';
			this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => {
				if (action === 'bind') {
					void this._bindPane(pane.token);
				}
			}));
		}
		return row;
	}

	private _paneSubText(pane: IParadisPaneDescriptor, boundHere: boolean, boundElse: boolean): string {
		if (boundHere) {
			return strSubBoundHere(pane.binding ? formatRelativeTime(pane.binding.boundAt) : STR_JUST_NOW);
		}
		if (boundElse && pane.binding) {
			return strSubBoundElse(pane.binding.pageInfo.title || pane.binding.pageInfo.url);
		}
		if (pane.mcpConnected) {
			return STR_SUB_READY;
		}
		return STR_SUB_NEEDS_MCP;
	}

	// --- MCP接続設定 tab ---

	private _renderMcpTab(): void {
		const wrap = dom.append(this._body, $('.pbd-mcp'));
		this._renderMcpCard(wrap, 'claude');
		this._renderMcpCard(wrap, 'codex');
		this._renderMcpManual(wrap);
	}

	private _renderMcpCard(container: HTMLElement, cli: ParadisMcpCli): void {
		const status = this._mcpStatus?.[cli];
		const state = status?.failed ? 'failed' : status?.state;
		const cardKind = state === 'configured' ? 'ok' : state === 'needsFix' ? 'warn' : 'off';
		const card = dom.append(container, $(`.pbd-mcp-card.${cardKind}`));

		const head = dom.append(card, $('.pbd-mc-head'));
		const logo = dom.append(head, $(`.pbd-mcp-logo.${cli}`));
		appendParadisAgentLogoSvg(logo, cli);
		dom.append(head, $('.pbd-mc-name')).textContent = CLI_DISPLAY_NAME[cli];
		this._appendMcpPill(head, state);

		dom.append(card, $('.pbd-mc-detail')).textContent = this._mcpDetailText(cli, status, state);

		const setupState = this._setupStates.get(cli);
		// manualOnly のとき（Codexで既存MCP設定があり自動追記が失敗する場合）は自動ボタンを出さず、
		// 下部の「手動でセットアップする」だけに誘導する。
		const actionable = (state === 'unconfigured' && status?.manualOnly !== true)
			|| state === 'needsFix'
			|| state === 'failed';
		if (actionable) {
			this._renderMcpAction(card, cli, state, setupState?.busy === true);
		}
		if (setupState && !setupState.busy) {
			this._renderSetupResult(card, setupState);
		}
	}

	private _appendMcpPill(head: HTMLElement, state: string | undefined): void {
		let pillClass: string;
		let dotClass: string;
		let label: string;
		switch (state) {
			case 'configured': pillClass = 'green'; dotClass = 'green'; label = STR_MCP_PILL_CONFIGURED; break;
			case 'needsFix': pillClass = 'amber'; dotClass = 'amber'; label = STR_MCP_PILL_NEEDS_FIX; break;
			case 'unconfigured': pillClass = 'gray'; dotClass = 'gray'; label = STR_MCP_PILL_UNCONFIGURED; break;
			case 'failed': pillClass = 'red'; dotClass = 'red'; label = STR_MCP_PILL_FAILED; break;
			default: pillClass = 'gray'; dotClass = 'gray'; label = STR_MCP_PILL_LOADING; break;
		}
		const pill = dom.append(head, $(`.pbd-pill.${pillClass}`));
		dom.append(pill, $(`.pbd-dot.${dotClass}`));
		dom.append(pill, $('span')).textContent = label;
	}

	private _mcpDetailText(cli: ParadisMcpCli, status: IParadisMcpCliConfigStatus | undefined, state: string | undefined): string {
		switch (state) {
			case 'configured': return strMcpDetailConfigured(status?.configPath ?? CLI_CONFIG_PATH[cli]);
			case 'needsFix': return strMcpDetailNeedsFix(status?.detectedPort ?? 0);
			case 'unconfigured': return status?.manualOnly
				? strMcpDetailManualOnly(CLI_CONFIG_PATH[cli])
				: strMcpDetailUnconfigured(CLI_CONFIG_PATH[cli]);
			case 'failed': return STR_MCP_DETAIL_FAILED;
			default: return STR_MCP_DETAIL_LOADING;
		}
	}

	private _renderMcpAction(card: HTMLElement, cli: ParadisMcpCli, state: string, busy: boolean): void {
		const actions = dom.append(card, $('.pbd-mc-actions'));
		const button = dom.append(actions, $('button.pbd-mc-btn')) as HTMLButtonElement;
		const icon = button.appendChild($(`span${ThemeIcon.asCSSSelector(busy ? Codicon.loading : (state === 'needsFix' ? Codicon.wrench : Codicon.zap))}`));
		if (busy) {
			icon.classList.add('codicon-modifier-spin');
		}
		dom.append(button, $('span')).textContent = busy
			? STR_SETUP_RUNNING
			: state === 'needsFix' ? STR_BTN_FIX : STR_BTN_AUTO_SETUP;
		button.disabled = busy;
		const kind = state === 'needsFix' ? 'fix' : 'setup';
		this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => void this._runCliAction(cli, kind)));
	}

	private _renderMcpManual(container: HTMLElement): void {
		const details = dom.append(container, $('details.pbd-mcp-manual')) as HTMLDetailsElement;
		dom.append(details, $('summary')).textContent = STR_MANUAL_SUMMARY;
		this._appendManualSnippet(details, STR_SETUP_CLAUDE_LABEL, getParadisClaudeSetupSnippet());
		this._appendManualSnippet(details, STR_SETUP_CODEX_LABEL, getParadisCodexSetupSnippet());
	}

	private _appendManualSnippet(container: HTMLElement, label: string, snippet: string): void {
		dom.append(container, $('.pbd-field-label')).textContent = label;
		const codeBlock = dom.append(container, $('.pbd-code-block'));
		dom.append(codeBlock, $('pre')).textContent = snippet.trimEnd();
		this._appendCopyButton(codeBlock, snippet, 'pbd-copy-btn');
	}

	private _renderSetupResult(card: HTMLElement, state: IParadisSetupState): void {
		const container = dom.append(card, $('.pbd-setup-result'));
		if (state.error !== undefined) {
			this._appendSetupResultRow(container, 'error', strSetupChannelError(state.error));
			return;
		}
		const result = state.result;
		if (!result) {
			return;
		}
		if (result.cli === 'claude' && !result.cliAvailable) {
			this._appendSetupResultRow(container, 'error', STR_SETUP_CLAUDE_UNAVAILABLE);
			return;
		}
		if (result.target) {
			dom.append(container, $('.pbd-setup-result-target')).textContent = strSetupCodexTarget(result.target);
		}
		for (const server of result.servers) {
			if (server.outcome === 'success') {
				this._appendSetupResultRow(container, 'success', strSetupServerSuccess(server.server));
			} else if (server.outcome === 'already') {
				this._appendSetupResultRow(container, 'already', strSetupServerAlready(server.server));
			} else {
				this._appendSetupResultRow(container, 'error', strSetupServerError(server.server, server.detail ?? ''));
			}
		}
	}

	private _appendSetupResultRow(container: HTMLElement, kind: 'success' | 'already' | 'error', text: string): void {
		const row = dom.append(container, $(`.pbd-setup-result-row.${kind}`));
		const icon = kind === 'success' ? Codicon.check : kind === 'already' ? Codicon.info : Codicon.error;
		row.appendChild($(`span${ThemeIcon.asCSSSelector(icon)}`));
		dom.append(row, $('span')).textContent = text;
	}

	private async _runCliAction(cli: ParadisMcpCli, kind: 'setup' | 'fix'): Promise<void> {
		if (this._setupStates.get(cli)?.busy) {
			return;
		}
		this._setupStates.set(cli, { busy: true });
		this._render();
		try {
			const result = kind === 'fix'
				? await this.bindingModel.fixMcp(cli)
				: await this.bindingModel.setupMcp(cli);
			if (this._store.isDisposed) {
				return;
			}
			this._setupStates.set(cli, { busy: false, result });
		} catch (error) {
			if (this._store.isDisposed) {
				return;
			}
			this._setupStates.set(cli, { busy: false, error: error instanceof Error ? error.message : String(error) });
		}
		this._render();
		// 実行結果を反映するためステータスを取り直す（ピル・タブの黄色ドットを更新）。
		void this._loadMcpStatus();
	}

	private async _loadMcpStatus(): Promise<void> {
		try {
			const status = await this.bindingModel.getMcpConfigStatus();
			if (this._store.isDisposed) {
				return;
			}
			this._mcpStatus = status;
		} catch {
			if (this._store.isDisposed) {
				return;
			}
			// 取得失敗時は両CLIを「判定できません」で表示する。
			this._mcpStatus = {
				claude: { cli: 'claude', state: 'unconfigured', failed: true },
				codex: { cli: 'codex', state: 'unconfigured', failed: true },
			};
		}
		this._render();
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
		hint.appendChild($(`span${ThemeIcon.asCSSSelector(this._bindError ? Codicon.error : Codicon.shield)}`));
		dom.append(hint, $('span')).textContent = this._bindError ?? STR_FOOTER_HINT;

		const closeButton = dom.append(this._footer, $('button.pbd-btn')) as HTMLButtonElement;
		closeButton.textContent = STR_BTN_CLOSE;
		this._renderDisposables.add(dom.addDisposableListener(closeButton, 'click', () => this.close()));
	}

	private async _bindPane(token: string): Promise<void> {
		const bound = await paradisRunDialogBind(
			() => this.bindingModel.bindPageToPane(this.pageModel, token),
			error => this._bindError = paradisGetBindingErrorMessage(error, {
				pending: STR_META_SCOPE_PENDING,
				differentScope: STR_META_SCOPE_MISMATCH,
				generic: strBindFailed,
			}),
		);
		if (this._store.isDisposed) {
			return;
		}
		if (bound) {
			this._bindError = undefined;
		}
		this._render();
	}
}

// --- helpers -------------------------------------------------------------

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
