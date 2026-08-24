/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナルペイン紐付けのバインディングダイアログ（モーダル）。
// upstreamの Dialog ウィジェットには依存せず、workbenchコンテナへ自前のbackdrop+モーダルDOMを
// 重ねる方式。レイアウトは Settings Editor 型（幅880px・左ナビ + コンテンツ）で、
// 色はハードコードせず --vscode-* テーマトークンを使う。
// また、ペイン行の hover/focus を paradisPaneIndicator.ts のレジストリへ通知することで、
// 背面の対応ターミナルグリッドセルを3パターン（枠グロー/エージェント色/他を暗く）で強調する。

import './media/paradisBindingDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { BugIndicatingError } from '../../../../base/common/errors.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { appendParadisAgentLogoSvg } from '../../limitsMonitor/electron-browser/paradisLimitsLogos.js';
import { IParadisMobileAttachment } from '../../mobileCanvas/common/paradisMobileCanvas.js';
import { IParadisMobileCanvasModel } from '../../mobileCanvas/electron-browser/paradisMobileCanvasModel.js';
import { IParadisTerminalScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { setParadisHoveredPaneInstanceId } from '../browser/paradisPaneIndicator.js';
import { IParadisMcpCliConfigStatus, IParadisMcpConfigStatus, IParadisMcpSetupResult, ParadisMcpCli } from '../common/paradisAgentBrowser.js';
import { IParadisAgentBrowserBindingModel, IParadisPaneDescriptor } from './paradisAgentBrowserBindingModel.js';
import { ParadisBindingDialogPaneListResources, ParadisBindingDialogTab, ParadisBindingDialogTabController } from './paradisBindingDialogResources.js';
import { paradisGetBindingErrorMessage, paradisGetPaneBindingAction, paradisRunDialogBind } from './paradisDialogPageResolver.js';
import { getParadisClaudeSetupSnippet, getParadisCodexSetupSnippet } from './paradisMcpSnippets.js';

const $ = dom.$;

// --- UI文字列（日本語。hygieneのunicodeチェック対策として1行ずつマーカーを付ける） ---
// allow-any-unicode-next-line
const STR_DIALOG_TITLE = localize('paradis.bindingDialog.title', "ブラウザページをエージェントと共有");
// allow-any-unicode-next-line
const STR_DIALOG_TITLE_DEVICES = localize('paradis.bindingDialog.titleDevices', "モバイル端末をエージェントと共有");
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
const STR_SWITCH_SHARE_ARIA = localize('paradis.bindingDialog.switchShareAria', "このページを共有する");
// allow-any-unicode-next-line
const STR_SWITCH_UNSHARE_ARIA = localize('paradis.bindingDialog.switchUnshareAria', "共有を解除する");
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
const STR_BTN_REAPPLY = localize('paradis.bindingDialog.btnReapply', "設定を入れ直す");
// allow-any-unicode-next-line
const STR_SETUP_RUNNING = localize('paradis.bindingDialog.setupRunning', "実行中…");
// allow-any-unicode-next-line
const strMcpDetailConfigured = (path: string) => localize('paradis.bindingDialog.mcpDetailConfigured', "{0} に para-browser を検出しました。ターミナルごとに中継役のプロセスを立てる旧方式のままなら、下のボタンで Para Code へ直接つなぐ方式へ入れ直せます。", path);
// allow-any-unicode-next-line
const strMcpDetailUnconfigured = (path: string) => localize('paradis.bindingDialog.mcpDetailUnconfigured', "para-browser（MCPサーバー）が未登録です。自動セットアップで {0} に追加します。", path);
// allow-any-unicode-next-line
const strMcpDetailNeedsFix = (port: number) => localize('paradis.bindingDialog.mcpDetailNeedsFix', "古いポート（127.0.0.1:{0}）を固定参照している設定があります。今のエンドポイントには繋がりません。ワンクリックで今の番号へ書き換えます。", port);
// allow-any-unicode-next-line
const strMcpDetailManualOnly = (path: string) => localize('paradis.bindingDialog.mcpDetailManualOnly', "para-browser（MCPサーバー）が未登録です。{0} に既存のMCP設定があるため自動セットアップは行えません。下の「手動でセットアップする」からコマンドをコピーして追加してください。", path);
// allow-any-unicode-next-line
const STR_MCP_DETAIL_FAILED = localize('paradis.bindingDialog.mcpDetailFailed', "設定ファイルを読み取れませんでした。下の「手動でセットアップする」を参照してください。");
// allow-any-unicode-next-line
const STR_MCP_DETAIL_LOADING = localize('paradis.bindingDialog.mcpDetailLoading', "設定を確認しています…");
// allow-any-unicode-next-line
const STR_MANUAL_SUMMARY = localize('paradis.bindingDialog.manualSummary', "手動でセットアップする（コマンドを表示）");
// allow-any-unicode-next-line
const STR_SETUP_CLAUDE_LABEL = localize('paradis.bindingDialog.setupClaudeLabel', "Claude Code（初回のみ）");
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

// allow-any-unicode-next-line
const STR_TAB_DEVICES = localize('paradis.bindingDialog.tabDevices', "モバイル端末");
// allow-any-unicode-next-line
const STR_DEVICES_EMPTY = localize('paradis.bindingDialog.devicesEmpty', "使えるiOSシミュレータ／Androidエミュレータが見つかりませんでした。iOSにはXcode、Androidには Android SDK（emulator・adb にPATHが通っていること）が必要です。");
// allow-any-unicode-next-line
const STR_DEVICES_LOADING = localize('paradis.bindingDialog.devicesLoading', "端末を探しています…");
// allow-any-unicode-next-line
const STR_DEVICE_RUNNING = localize('paradis.bindingDialog.deviceRunning', "起動中");
// allow-any-unicode-next-line
const STR_DEVICE_STOPPED = localize('paradis.bindingDialog.deviceStopped', "停止中");
// allow-any-unicode-next-line
const STR_BTN_ATTACH = localize('paradis.bindingDialog.btnAttach', "アタッチ");
// allow-any-unicode-next-line
const STR_BTN_DETACH = localize('paradis.bindingDialog.btnDetach', "解除");
// allow-any-unicode-next-line
const STR_DEVICE_UNATTACHED = localize('paradis.bindingDialog.deviceUnattached', "未アタッチ");
// allow-any-unicode-next-line
const strDeviceAttachedTo = (panes: string) => localize('paradis.bindingDialog.deviceAttachedTo', "アタッチ中 · {0}", panes);
// allow-any-unicode-next-line
const strPaneHoldsOtherDevice = (device: string) => localize('paradis.bindingDialog.paneHoldsOtherDevice', "{0} をアタッチ中 — 渡すと入れ替わります", device);
// allow-any-unicode-next-line
const STR_BTN_CHOOSE_PANES = localize('paradis.bindingDialog.btnChoosePanes', "ペインを選ぶ");
// allow-any-unicode-next-line
const STR_BTN_CLOSE_PANES = localize('paradis.bindingDialog.btnClosePanes', "閉じる");
// allow-any-unicode-next-line
const STR_DEVICES_PICK_PANE = localize('paradis.bindingDialog.devicesPickPane', "この端末を渡すターミナルペインを選んでください（同じ端末を複数のペインへ同時に渡せます）");
// allow-any-unicode-next-line
const STR_DEVICES_NO_PANE = localize('paradis.bindingDialog.devicesNoPane', "アタッチできるターミナルペインがありません。新しいターミナルでエージェントCLIを起動してください。");
// allow-any-unicode-next-line
const STR_DEVICES_FOOTER_HINT = localize('paradis.bindingDialog.devicesFooterHint', "エージェントはアタッチしたこの端末だけを操作できます");
// allow-any-unicode-next-line
const strAttachFailed = (detail: string) => localize('paradis.bindingDialog.attachFailed', "アタッチに失敗しました: {0}", detail);

// --- 左ナビ / ステータスヘッダー（Settings Editor 型レイアウト） ---
// allow-any-unicode-next-line
const STR_NAV_CAP_PAGES = localize('paradis.bindingDialog.navCapPages', "ページ");
// allow-any-unicode-next-line
const STR_NAV_CAP_LINKS = localize('paradis.bindingDialog.navCapLinks', "連携設定");
// allow-any-unicode-next-line
const strSummaryShared = (n: number) => localize('paradis.bindingDialog.summaryShared', "共有中 {0} ペイン", n);
// allow-any-unicode-next-line
const STR_SUMMARY_UNSHARED = localize('paradis.bindingDialog.summaryUnshared', "未共有");
// allow-any-unicode-next-line
const strSummaryMcpFix = (n: number) => localize('paradis.bindingDialog.summaryMcpFix', "MCP 要修正 {0} 件", n);
// allow-any-unicode-next-line
const STR_SUMMARY_MCP_OK = localize('paradis.bindingDialog.summaryMcpOk', "MCP 設定済み");
// allow-any-unicode-next-line
const STR_SUMMARY_MCP_LOADING = localize('paradis.bindingDialog.summaryMcpLoading', "MCP 確認中");
// allow-any-unicode-next-line
const strNavBadgeShared = (n: number) => localize('paradis.bindingDialog.navBadgeShared', "共有中 {0}", n);
// allow-any-unicode-next-line
const strNavBadgeFix = (n: number) => localize('paradis.bindingDialog.navBadgeFix', "要修正 {0}", n);

// --- 背面ターミナルハイライト ---
// allow-any-unicode-next-line
const STR_HL_LABEL = localize('paradis.bindingDialog.highlightLabel', "背面ハイライト");
// allow-any-unicode-next-line
const STR_HL_GLOW = localize('paradis.bindingDialog.highlightGlow', "枠グロー");
// allow-any-unicode-next-line
const STR_HL_TINT = localize('paradis.bindingDialog.highlightTint', "エージェント色");
// allow-any-unicode-next-line
const STR_HL_DIM = localize('paradis.bindingDialog.highlightDim', "他を暗く");

/** 背面ターミナルセルの強調表示パターン。 */
type ParadisPaneHighlightStyle = 'glow' | 'tint' | 'dim';

const PARADIS_HIGHLIGHT_STYLES: readonly ParadisPaneHighlightStyle[] = ['glow', 'tint', 'dim'];

/** 選択を永続化するキー（StorageScope.PROFILE）。 */
const PARADIS_HIGHLIGHT_STYLE_STORAGE_KEY = 'paradis.browserShare.highlightStyle';

const HIGHLIGHT_STYLE_LABELS: Readonly<Record<ParadisPaneHighlightStyle, string>> = {
	glow: STR_HL_GLOW,
	tint: STR_HL_TINT,
	dim: STR_HL_DIM,
};

/** CLIごとの「自動セットアップ / 修正」実行状態。 */
interface IParadisSetupState {
	readonly busy: boolean;
	readonly result?: IParadisMcpSetupResult;
	/** IPC呼び出し自体が失敗したときのメッセージ（shared process未起動等）。 */
	readonly error?: string;
}

export interface IParadisBindingDialogOptions {
	/**
	 * 呼び出し元ペインの識別に使われていたが、行内アクションUIでは選択の概念がないため
	 * 現在は未使用。API互換のためフィールドは維持する。
	 */
	readonly selectInstanceId?: number;
}

/**
 * バインディングダイアログ本体。1回のopenごとに生成し、閉じるとdisposeされる。
 */
export class ParadisBindingDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _pageBar: HTMLElement;
	private readonly _nav: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _footer: HTMLElement;
	private readonly _headerPills: HTMLElement;
	/** ダイアログ上部 toolbar の強調スタイル切替（seg）ボタン。 */
	private readonly _hlButtons = new Map<ParadisPaneHighlightStyle, HTMLButtonElement>();
	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _paneListResources = this._register(new ParadisBindingDialogPaneListResources());
	private readonly _tabController: ParadisBindingDialogTabController;

	private _filterText = '';
	private _bindError: string | undefined;
	private _mcpStatus: IParadisMcpConfigStatus | undefined;
	private readonly _setupStates = new Map<ParadisMcpCli, IParadisSetupState>();
	/** 「アタッチ」を押して渡し先ペインの一覧を開いている端末（開いていなければ undefined）。 */
	private _attachTargetDeviceId: string | undefined;
	/** 背面ハイライトの強調パターン（StorageScope.PROFILE に永続化）。 */
	private _highlightStyle: ParadisPaneHighlightStyle;
	/** hover/focus 中のペイン行に対応するターミナルインスタンスID。 */
	private _hoveredInstanceId: number | undefined;

	constructor(
		// モバイル端末のアタッチだけを目的に開く場合はページが無い（ブラウザページを1枚も
		// 開いていなくても端末タブへ入れるようにするため）。ページ起点のタブからは _page を使う。
		private readonly pageModel: IBrowserViewModel | undefined,
		// 呼び出し元ペインの識別に使われていたが、行内アクションUIでは選択の概念がないため未使用。
		// API互換のため引数は維持する。
		_options: IParadisBindingDialogOptions | undefined,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@ILayoutService layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IParadisMobileCanvasModel private readonly mobileCanvasModel: IParadisMobileCanvasModel,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._tabController = this._register(new ParadisBindingDialogTabController(
			() => this.mobileCanvasModel.beginPolling(),
			() => this._render(),
		));
		this._highlightStyle = this._loadHighlightStyle();

		this._backdrop = $('.paradis-binding-dialog-backdrop');
		const modal = $('.paradis-binding-dialog');
		this._backdrop.appendChild(modal);

		// --- header（タイトル + サマリpill + 閉じる） ---
		const header = dom.append(modal, $('.pbd-header'));
		const titles = dom.append(header, $('.pbd-titles'));
		dom.append(titles, $('h2')).textContent = this.pageModel ? STR_DIALOG_TITLE : STR_DIALOG_TITLE_DEVICES;
		this._headerPills = dom.append(header, $('.pbd-header-pills'));
		const closeBtn = dom.append(header, $('.pbd-close'));
		closeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', STR_CLOSE_ARIA);
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.close()));

		// --- toolbar（ページバー + 背面ハイライト切替） ---
		const toolbar = dom.append(modal, $('.pbd-toolbar'));
		this._pageBar = dom.append(toolbar, $('.pbd-pagebar'));
		this._renderHighlightSeg(toolbar);

		// --- nav + body ---
		const navwrap = dom.append(modal, $('.pbd-navwrap'));
		this._nav = dom.append(navwrap, $('.pbd-nav'));
		this._body = dom.append(navwrap, $('.pbd-body'));

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
		this._register(this.mobileCanvasModel.onDidChange(() => this._render()));
		if (this.pageModel) {
			this._register(this.pageModel.onDidChangeTitle(() => this._render()));
			this._register(this.pageModel.onDidChangeSharingState(() => this._render()));
		}

		layoutService.activeContainer.appendChild(this._backdrop);
		// ページ無しで開いた場合（モバイル端末アタッチ目的）は端末ビュー、
		// ページ起点のダイアログはターミナルペインビューを初期表示にする。
		this._tabController.initialize(this.pageModel !== undefined);
		modal.focus();
		void this.bindingModel.refresh();
		void this._loadMcpStatus();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		// 背面ハイライトの後始末。_setHoveredPane は disposed ガードを持つため直接外す。
		setParadisHoveredPaneInstanceId(undefined);
		const doc = this._backdrop.ownerDocument;
		for (const style of PARADIS_HIGHLIGHT_STYLES) {
			doc.body.classList.remove(`paradis-pvh-${style}`);
		}
		this._backdrop.remove();
		super.dispose();
	}

	// --- rendering ------------------------------------------------------

	/**
	 * 背面ハイライトの強調パターンを切り替える seg。ダイアログ上部の toolbar に置く。
	 * 選択は StorageScope.PROFILE へ保存し、次回以降も引き継ぐ。
	 */
	private _renderHighlightSeg(toolbar: HTMLElement): void {
		const wrap = dom.append(toolbar, $('.pbd-hlseg'));
		dom.append(wrap, $('span.pbd-hl-label')).textContent = STR_HL_LABEL;
		const seg = dom.append(wrap, $('.pbd-seg'));
		for (const style of PARADIS_HIGHLIGHT_STYLES) {
			const button = dom.append(seg, $('button.pbd-seg-btn')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = HIGHLIGHT_STYLE_LABELS[style];
			if (style === this._highlightStyle) {
				button.classList.add('active');
			}
			this._register(dom.addDisposableListener(button, 'click', () => this._setHighlightStyle(style)));
			this._hlButtons.set(style, button);
		}
	}

	private _loadHighlightStyle(): ParadisPaneHighlightStyle {
		const stored = this.storageService.get(PARADIS_HIGHLIGHT_STYLE_STORAGE_KEY, StorageScope.PROFILE);
		return stored === 'tint' || stored === 'dim' ? stored : 'glow';
	}

	private _setHighlightStyle(style: ParadisPaneHighlightStyle): void {
		this._highlightStyle = style;
		for (const [candidate, button] of this._hlButtons) {
			button.classList.toggle('active', candidate === style);
		}
		this.storageService.store(PARADIS_HIGHLIGHT_STYLE_STORAGE_KEY, style, StorageScope.PROFILE, StorageTarget.USER);
		// ホバー中に切り替えた場合も即座に効くよう、現在のホバー状態で再適用する。
		this._setHoveredPane(this._hoveredInstanceId);
	}

	/**
	 * 「いま指しているペイン」を背面セル側へ通知する。強調スタイル（body クラス）は
	 * ホバー中の間だけ載せる —— パターンC「他を暗く」は対象がいる間だけ全セルを暗く
	 * する必要があるため、スタイル適用とセットで管理する。
	 */
	private _setHoveredPane(instanceId: number | undefined): void {
		if (this._store.isDisposed) {
			return;
		}
		this._hoveredInstanceId = instanceId;
		setParadisHoveredPaneInstanceId(instanceId);
		const body = dom.getWindow(this._backdrop).document.body;
		for (const style of PARADIS_HIGHLIGHT_STYLES) {
			body.classList.toggle(`paradis-pvh-${style}`, instanceId !== undefined && this._highlightStyle === style);
		}
	}

	private get _activeTab(): ParadisBindingDialogTab { return this._tabController.activeTab; }

	/** ペイン行に hover/focus での背面ハイライト通知を張る（a11y: キーボードフォーカスでも効く）。 */
	private _wireRowHighlight(row: HTMLElement, instanceId: number): void {
		row.tabIndex = 0;
		row.dataset['instanceId'] = String(instanceId);
		this._paneListResources.add(dom.addDisposableListener(row, dom.EventType.MOUSE_ENTER, () => this._setHoveredPane(instanceId)));
		this._paneListResources.add(dom.addDisposableListener(row, dom.EventType.MOUSE_LEAVE, () => this._setHoveredPane(undefined)));
		this._paneListResources.add(dom.addDisposableListener(row, 'focusin', () => this._setHoveredPane(instanceId)));
		this._paneListResources.add(dom.addDisposableListener(row, 'focusout', () => this._setHoveredPane(undefined)));
	}

	/**
	 * ペイン一覧の再描画後に、ポインタが乗っている行を検出してホバー状態を復元する。
	 * 行はポーリング更新などで頻繁に作り直されるため、mouseenter を待たず同期する。
	 */
	private _reconcileHoverAfterRender(): void {
		// querySelector is required here to read live :hover pseudo-state; dom.ts h() only builds
		// elements, it has no equivalent for querying which one the pointer is currently over.
		// eslint-disable-next-line no-restricted-syntax
		const hoveredRow = this._body.querySelector<HTMLElement>('.pbd-pane-row[data-instance-id]:hover');
		const raw = hoveredRow?.dataset['instanceId'];
		const instanceId = raw !== undefined ? Number(raw) : Number.NaN;
		this._setHoveredPane(Number.isFinite(instanceId) ? instanceId : undefined);
	}

	/** 現在ページ（無い場合は全バインディング）の共有ペイン数。 */
	private _sharedPaneCount(): number {
		return this.pageModel
			? this.bindingModel.getBindingsForPage(this.pageModel.id).length
			: this.bindingModel.bindings.length;
	}

	/** MCP設定のうち「設定済み」でないCLI数。未取得（確認中）は undefined。 */
	private _mcpAttentionCount(): number | undefined {
		const status = this._mcpStatus;
		if (!status) {
			return undefined;
		}
		let count = 0;
		for (const cli of ['claude', 'codex'] as const) {
			if (status[cli].failed || status[cli].state !== 'configured') {
				count++;
			}
		}
		return count;
	}

	/**
	 * 左ナビ「ページ」に出す共有ページの一覧。現在ページが未共有でも先頭に出す（状態: 未共有）。
	 * ダイアログは1つのページを主語にするため、他ページの項目は状態表示のみ（クリック不可）。
	 */
	private _sharedPages(): { readonly pageId: string; readonly title: string; readonly url: string; readonly paneCount: number }[] {
		const byPage = new Map<string, { title: string; url: string; paneCount: number }>();
		for (const binding of this.bindingModel.bindings) {
			const entry = byPage.get(binding.pageId);
			if (entry) {
				entry.paneCount++;
				continue;
			}
			byPage.set(binding.pageId, { title: binding.pageInfo.title, url: binding.pageInfo.url, paneCount: 1 });
		}
		const result = [...byPage.entries()].map(([pageId, value]) => ({ pageId, ...value }));
		if (this.pageModel && !byPage.has(this.pageModel.id)) {
			result.unshift({ pageId: this.pageModel.id, title: this.pageModel.title, url: this.pageModel.url, paneCount: 0 });
		}
		return result;
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._paneListResources.beginRender();
		this._renderDisposables.clear();

		this._renderHeaderPills();
		this._renderNav();
		// 共有先のページを表す帯は「ターミナルペイン」ビューの文脈でしか意味を持たない。
		// モバイル端末/MCPビューは端末や設定が主語なので、出したままだと無関係な情報になる。
		this._pageBar.style.display = this._activeTab === 'panes' ? '' : 'none';
		if (this._activeTab === 'panes') {
			this._renderPageBar();
		}
		dom.clearNode(this._body);
		if (this._activeTab === 'panes') {
			this._renderPanesTab();
		} else if (this._activeTab === 'devices') {
			this._renderDevicesTab();
		} else {
			this._renderMcpTab();
		}
		this._reconcileHoverAfterRender();
		this._renderFooter();
	}

	private _renderHeaderPills(): void {
		dom.clearNode(this._headerPills);
		const sharedCount = this._sharedPaneCount();
		const pagesPill = dom.append(this._headerPills, $(`.pbd-pill.${sharedCount > 0 ? 'green' : 'gray'}`));
		dom.append(pagesPill, $(`.pbd-dot.${sharedCount > 0 ? 'green' : 'gray'}`));
		dom.append(pagesPill, $('span')).textContent = sharedCount > 0 ? strSummaryShared(sharedCount) : STR_SUMMARY_UNSHARED;

		const fixCount = this._mcpAttentionCount();
		const mcpPillClass = fixCount === undefined ? 'gray' : fixCount > 0 ? 'amber' : 'green';
		const mcpPill = dom.append(this._headerPills, $(`.pbd-pill.${mcpPillClass}`));
		dom.append(mcpPill, $(`.pbd-dot.${mcpPillClass}`));
		dom.append(mcpPill, $('span')).textContent =
			fixCount === undefined ? STR_SUMMARY_MCP_LOADING
				: fixCount > 0 ? strSummaryMcpFix(fixCount)
					: STR_SUMMARY_MCP_OK;
	}

	private _renderNav(): void {
		dom.clearNode(this._nav);

		// --- ページ ---
		const pages = this._sharedPages();
		if (pages.length > 0) {
			dom.append(this._nav, $('.pbd-nav-cap')).textContent = STR_NAV_CAP_PAGES;
			for (const page of pages) {
				const isCurrent = this.pageModel !== undefined && page.pageId === this.pageModel.id;
				const item = dom.append(this._nav, $('.pbd-nav-item'));
				if (!isCurrent) {
					item.classList.add('static');
				} else if (this._activeTab === 'panes') {
					item.classList.add('active');
				}
				dom.append(item, $(`.pbd-dot.${page.paneCount > 0 ? 'green' : 'gray'}`));
				const label = dom.append(item, $('span.pbd-nav-label'));
				label.textContent = page.title || page.url;
				label.title = page.title ? page.url : '';
				if (page.paneCount > 0) {
					const count = dom.append(item, $('span.pbd-nav-count.green'));
					count.textContent = String(page.paneCount);
					count.title = strNavBadgeShared(page.paneCount);
				}
				if (isCurrent) {
					this._renderDisposables.add(dom.addDisposableListener(item, 'click', () => {
						this._tabController.setActiveTab('panes');
					}));
				}
			}
		}

		// --- 連携設定 ---
		dom.append(this._nav, $('.pbd-nav-cap')).textContent = STR_NAV_CAP_LINKS;
		// ページ無しで開いた場合、「ターミナルペイン」ビューは意味を持たないので出さない。
		if (this.pageModel) {
			this._createNavItem(STR_TAB_PANES, 'panes', this._sharedPaneCount() > 0
				? { text: String(this._sharedPaneCount()), className: 'green', title: strNavBadgeShared(this._sharedPaneCount()) }
				: undefined);
		}
		const fixCount = this._mcpAttentionCount();
		if (fixCount !== undefined && fixCount > 0) {
			this._createNavItem(STR_TAB_MCP, 'mcp', undefined, { text: strNavBadgeFix(fixCount), className: 'amber', title: STR_TAB_MCP_WARN_ARIA });
		} else {
			this._createNavItem(STR_TAB_MCP, 'mcp');
		}
		const snapshot = this.mobileCanvasModel.snapshot;
		const attachedCount = snapshot.attachments.length;
		this._createNavItem(STR_TAB_DEVICES, 'devices', {
			text: this.mobileCanvasModel.loading ? '…' : String(attachedCount),
			className: 'gray',
			title: undefined,
		});
	}

	private _createNavItem(
		label: string,
		tab: ParadisBindingDialogTab,
		badge?: { readonly text: string; readonly className: string; readonly title?: string },
		warnBadge?: { readonly text: string; readonly className: string; readonly title?: string },
	): void {
		const item = dom.append(this._nav, $('.pbd-nav-item'));
		item.classList.toggle('active', tab === this._activeTab);
		dom.append(item, $('span.pbd-nav-label')).textContent = label;
		const badgeInfo = warnBadge ?? badge;
		if (badgeInfo && badgeInfo.text.length > 0) {
			const element = dom.append(item, $(`span.pbd-nav-count.${badgeInfo.className}`));
			element.textContent = badgeInfo.text;
			if (badgeInfo.title) {
				element.title = badgeInfo.title;
			}
		}
		this._renderDisposables.add(dom.addDisposableListener(item, 'click', () => {
			this._tabController.setActiveTab(tab);
		}));
	}

	/**
	 * ページ起点のタブ（ターミナルペイン）専用のアクセサ。端末タブしか開けない状態では
	 * それらのコードパスに入らないため、ここに来たら呼び出し側の不具合。
	 */
	private get _page(): IBrowserViewModel {
		if (!this.pageModel) {
			throw new BugIndicatingError('The panes tab of the binding dialog requires a browser page.');
		}
		return this.pageModel;
	}

	private _panes(): IParadisPaneDescriptor[] {
		return this.pageModel ? this.bindingModel.getPanesForPage(this.pageModel) : this.bindingModel.getPanes();
	}

	private _paneDisplayName(pane: IParadisPaneDescriptor): string {
		return `${pane.title} — pane #${pane.instanceId}`;
	}

	private _paneMcpConnected(pane: IParadisPaneDescriptor): boolean {
		return !!pane.binding || !!pane.mcpConnected;
	}

	private _renderPageBar(): void {
		dom.clearNode(this._pageBar);
		const favicon = dom.append(this._pageBar, $('.pbd-favicon'));
		if (this._page.favicon) {
			const img = dom.append(favicon, $('img')) as HTMLImageElement;
			img.src = this._page.favicon;
			img.alt = '';
		} else {
			favicon.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.globe)}`));
		}
		const text = dom.append(this._pageBar, $('.pbd-pb-text'));
		dom.append(text, $('span.pbd-pb-title')).textContent = this._page.title || this._page.url;
		dom.append(text, $('span.pbd-pb-url')).textContent = this._page.url;

		const isShared = this.bindingModel.getBindingsForPage(this._page.id).length > 0;
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
			pane.bindEligibility?.eligible === true || pane.binding?.pageId === this._page.id);
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
		this._paneListResources.beginRender();
		dom.clearNode(container);
		const filter = this._filterText.trim().toLowerCase();
		const visible = this._visiblePanes()
			.filter(pane => filter.length === 0 || this._paneDisplayName(pane).toLowerCase().includes(filter))
			.sort((a, b) => Number(this._paneMcpConnected(b)) - Number(this._paneMcpConnected(a)));
		if (visible.length === 0) {
			dom.append(container, $('.pbd-empty')).textContent = STR_NO_PANES;
			// 検索で絞り込まれて行が消えた場合、ホバー状態は無効なので背面ハイライトも外す。
			this._reconcileHoverAfterRender();
			return;
		}
		for (const pane of visible) {
			container.appendChild(this._renderPaneRow(pane));
		}
		this._reconcileHoverAfterRender();
	}

	private _renderPaneRow(pane: IParadisPaneDescriptor): HTMLElement {
		const row = $('.pbd-pane-row');
		const boundHere = pane.binding?.pageId === this._page.id;
		const boundElse = !!pane.binding && !boundHere;

		const dotClass = (pane.binding || pane.mcpConnected) ? 'green' : 'amber';
		dom.append(row, $(`.pbd-dot.${dotClass}`));

		const main = dom.append(row, $('.pbd-row-main'));
		dom.append(main, $('.pbd-row-title')).textContent = this._paneDisplayName(pane);
		dom.append(main, $('.pbd-row-sub')).textContent = this._paneSubText(pane, boundHere, boundElse);

		// 行内アクションは共有/解除を表す switch。eligibility 対象外の行は disabled のまま維持する。
		// 「解除」の動詞になる行（このページに共有中 / 別ページ共有中でスコープ外）は ON 表示にし、
		// OFF への切替で解除が走る。
		const action = paradisGetPaneBindingAction(pane.binding?.pageId, this._page.id, pane.bindEligibility);
		const isUnshareVerb = action === 'unbind';
		const switchEl = dom.append(row, $('input.pbd-switch')) as HTMLInputElement;
		switchEl.type = 'checkbox';
		switchEl.setAttribute('role', 'switch');
		switchEl.checked = isUnshareVerb;
		switchEl.disabled = action === 'disabled';
		switchEl.setAttribute('aria-label', isUnshareVerb ? STR_SWITCH_UNSHARE_ARIA : STR_SWITCH_SHARE_ARIA);
		if (action !== 'disabled') {
			this._paneListResources.add(dom.addDisposableListener(switchEl, 'change', () => {
				void this._runRowToggle(pane, switchEl.checked);
			}));
		}
		this._wireRowHighlight(row, pane.instanceId);
		return row;
	}

	/** 行の switch 操作を受ける。成功/失敗どちらでも描画し直して switch の見た目を実状態へ戻す。 */
	private async _runRowToggle(pane: IParadisPaneDescriptor, wantShared: boolean): Promise<void> {
		if (wantShared) {
			await this._bindPane(pane.token);
			return;
		}
		try {
			if (pane.binding?.pageId === this._page.id) {
				await this.bindingModel.unbindPane(this._page, pane.token);
			} else {
				await this.bindingModel.unbindToken(pane.token);
			}
			this._bindError = undefined;
		} catch (error) {
			this._bindError = strBindFailed(error instanceof Error ? error.message : String(error));
		}
		this._render();
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
		// 設定済みでも押せるようにしておく。旧方式（ターミナルごとに中継役のプロセスを立てる）の
		// 登録はそのまま動くので設定済みと判定されるが、押し直さないと新方式へ移れない。
		// 確認中（state が未確定）は押させない。
		const actionable = state !== undefined && (state !== 'unconfigured' || status?.manualOnly !== true);
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
			: state === 'needsFix' ? STR_BTN_FIX
				: state === 'configured' ? STR_BTN_REAPPLY : STR_BTN_AUTO_SETUP;
		button.disabled = busy;
		const kind = state === 'needsFix' ? 'fix' : 'setup';
		this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => void this._runCliAction(cli, kind)));
	}

	private _renderMcpManual(container: HTMLElement): void {
		const details = dom.append(container, $('details.pbd-mcp-manual')) as HTMLDetailsElement;
		dom.append(details, $('summary')).textContent = STR_MANUAL_SUMMARY;
		const port = this._mcpStatus?.gatewayPort;
		this._appendManualSnippet(details, STR_SETUP_CLAUDE_LABEL, getParadisClaudeSetupSnippet(port));
		this._appendManualSnippet(details, STR_SETUP_CODEX_LABEL, getParadisCodexSetupSnippet(port));
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

	// --- モバイル端末タブ ---

	/**
	 * 端末を主語にした一覧。行のボタンでアタッチ／解除する。
	 * 「アタッチ」を押すと、その行の下に渡し先ペインの一覧をその場で開く（別ウィンドウの
	 * QuickPickを重ねるとこのモーダルのフォーカスとEscape処理を奪い合うため、中で完結させる）。
	 */
	private _renderDevicesTab(): void {
		const snapshot = this.mobileCanvasModel.snapshot;
		const list = dom.append(this._body, $('.pbd-pane-list'));

		if (snapshot.devices.length === 0) {
			const empty = dom.append(list, $('.pbd-empty'));
			if (this.mobileCanvasModel.loading) {
				empty.textContent = STR_DEVICES_LOADING;
			} else {
				empty.textContent = snapshot.unavailableReason
					? `${STR_DEVICES_EMPTY}\n\n${snapshot.unavailableReason}`
					: STR_DEVICES_EMPTY;
			}
			return;
		}

		const panes = this.bindingModel.getPanes();
		for (const device of snapshot.devices) {
			// 1台の端末を複数のペインへ同時にアタッチできる（1ペイン1台だけを守る）ので、
			// ここは配列で受ける。
			const attached = snapshot.attachments.filter(entry => entry.deviceId === device.id);

			const row = dom.append(list, $('.pbd-pane-row'));
			const main = dom.append(row, $('.pbd-row-main'));
			const title = dom.append(main, $('.pbd-row-title'));
			dom.append(title, $('span')).textContent = device.name;
			const statePill = dom.append(title, $(`span.pbd-pill.${device.isRunning ? 'green' : 'gray'}`));
			dom.append(statePill, $(`.pbd-dot.${device.isRunning ? 'green' : 'gray'}`));
			dom.append(statePill, $('span')).textContent = device.isRunning ? STR_DEVICE_RUNNING : STR_DEVICE_STOPPED;

			const status = attached.length === 0
				? STR_DEVICE_UNATTACHED
				: strDeviceAttachedTo(attached.map(entry => this._attachmentPaneLabel(entry, panes)).join('、'));
			dom.append(main, $('.pbd-row-sub')).textContent = device.runtime ? `${device.runtime} · ${status}` : status;

			// アタッチも解除も渡し先ペインごとの操作なので、行のボタンはペイン一覧の開閉に徹する。
			const button = dom.append(row, $('button.pbd-row-btn.share')) as HTMLButtonElement;
			button.textContent = this._attachTargetDeviceId === device.id ? STR_BTN_CLOSE_PANES : STR_BTN_CHOOSE_PANES;
			this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => {
				this._attachTargetDeviceId = this._attachTargetDeviceId === device.id ? undefined : device.id;
				this._render();
			}));

			if (this._attachTargetDeviceId === device.id) {
				this._renderAttachTargets(list, device.id, panes, snapshot.attachments);
			}
		}
	}

	/** 台帳のエントリを、実在するペイン名（無ければ生のトークン）で表す。 */
	private _attachmentPaneLabel(attachment: IParadisMobileAttachment, panes: readonly IParadisPaneDescriptor[]): string {
		const pane = panes.find(candidate => candidate.token === attachment.paneToken);
		return pane ? this._paneDisplayName(pane) : attachment.paneToken;
	}

	/**
	 * 端末の直下に出す、渡し先ペインの一覧。この端末を既に持っているペインは「解除」になり、
	 * 持っていないペインは「アタッチ」になる。アタッチと解除の両方がここで完結する。
	 */
	private _renderAttachTargets(
		list: HTMLElement,
		deviceId: string,
		panes: readonly IParadisPaneDescriptor[],
		attachments: readonly IParadisMobileAttachment[],
	): void {
		if (panes.length === 0) {
			dom.append(list, $('.pbd-empty')).textContent = STR_DEVICES_NO_PANE;
			return;
		}
		dom.append(list, $('.pbd-scope-note')).textContent = STR_DEVICES_PICK_PANE;
		for (const pane of panes) {
			const current = attachments.find(entry => entry.paneToken === pane.token);
			const holdsThisDevice = current?.deviceId === deviceId;

			const row = dom.append(list, $('.pbd-pane-row'));
			const main = dom.append(row, $('.pbd-row-main'));
			dom.append(main, $('.pbd-row-title')).textContent = this._paneDisplayName(pane);
			// 1ペイン1台なので、別の端末を持っているペインへ渡すと入れ替わる。何が外れるかを先に見せる。
			const sub = current && !holdsThisDevice
				? strPaneHoldsOtherDevice(current.deviceName)
				: (this._paneMcpConnected(pane) ? STR_SUB_READY : STR_SUB_NEEDS_MCP);
			dom.append(main, $('.pbd-row-sub')).textContent = sub;

			const button = dom.append(row, $('button.pbd-row-btn')) as HTMLButtonElement;
			if (holdsThisDevice) {
				button.classList.add('unshare');
				button.textContent = STR_BTN_DETACH;
				this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => {
					void this._runDeviceAction(() => this.mobileCanvasModel.detach(pane.token));
				}));
			} else {
				button.classList.add('share');
				button.textContent = STR_BTN_ATTACH;
				this._renderDisposables.add(dom.addDisposableListener(button, 'click', () => {
					// どのスペースのペインへ渡したかを残しておく（表示と将来の後始末のため）。
					const stateKey = this.terminalScopeService.getStateKeyForInstance(pane.instanceId);
					void this._runDeviceAction(() => this.mobileCanvasModel.attach(pane.token, deviceId, stateKey));
				}));
			}
			// 渡し先の行でも背面ハイライトを効かせる（ペイン行と同じ経路）。
			this._wireRowHighlight(row, pane.instanceId);
		}
	}

	private async _runDeviceAction(action: () => Promise<void>): Promise<void> {
		try {
			await action();
			this._bindError = undefined;
			this._attachTargetDeviceId = undefined;
		} catch (error) {
			this._bindError = strAttachFailed(error instanceof Error ? error.message : String(error));
		}
		this._render();
	}

	private _renderFooter(): void {
		dom.clearNode(this._footer);
		const hint = dom.append(this._footer, $('.pbd-hint'));
		hint.appendChild($(`span${ThemeIcon.asCSSSelector(this._bindError ? Codicon.error : Codicon.shield)}`));
		const defaultHint = this._activeTab === 'devices' ? STR_DEVICES_FOOTER_HINT : STR_FOOTER_HINT;
		dom.append(hint, $('span')).textContent = this._bindError ?? defaultHint;

		const closeButton = dom.append(this._footer, $('button.pbd-btn')) as HTMLButtonElement;
		closeButton.textContent = STR_BTN_CLOSE;
		this._renderDisposables.add(dom.addDisposableListener(closeButton, 'click', () => this.close()));
	}

	private async _bindPane(token: string): Promise<void> {
		const bound = await paradisRunDialogBind(
			() => this.bindingModel.bindPageToPane(this._page, token),
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
