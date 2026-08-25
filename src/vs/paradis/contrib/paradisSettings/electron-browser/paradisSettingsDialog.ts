/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「設定 (Para Code)」ダイアログ。fork が足した設定 (paradis.*) だけを、機能ごとの
// セクションへまとめて出す。標準の設定エディタで `@id:paradis.*` を検索しても同じ項目には
// 辿り着けるが、そちらは「どの機能の設定か」「どのダイアログから細かく設定するのか」が
// 並び順からは読み取れない。ここでは機能単位のセクション + 専用ダイアログへの導線を持たせる。
//
// 値の読み書きは IConfigurationService へ直接行い、変更は即保存する (フッターの保存ボタンなし)。
// 通知設定ダイアログ (paradisNotificationSettingsDialog.ts) と同じシェル構造・CSS 命名に揃えてある。

import './media/paradisSettingsDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.settings.title', "設定 (Para Code)");
// allow-any-unicode-next-line
const STR_SEARCH_PLACEHOLDER = localize('paradis.settings.searchPlaceholder', "設定を検索");
// allow-any-unicode-next-line
const STR_AUTOSAVE = localize('paradis.settings.autosave', "変更は即保存されます");
// allow-any-unicode-next-line
const STR_CLOSE_ARIA = localize('paradis.settings.closeAria', "閉じる");
// allow-any-unicode-next-line
const STR_SEARCH_EMPTY = localize('paradis.settings.searchEmpty', "一致する設定はありません");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_FEATURES = localize('paradis.settings.navCaptionFeatures', "機能");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_WINDOW = localize('paradis.settings.navCaptionWindow', "ウィンドウ");
// allow-any-unicode-next-line
const STR_OPEN_SETTINGS_EDITOR = localize('paradis.settings.openSettingsEditor', "設定エディタで開く");

/** セクション見出しと、ナビ項目のラベル。 */
interface IParadisSettingsSectionSpec {
	readonly id: string;
	readonly navLabel: string;
	readonly heading: string;
	readonly description?: string;
	readonly caption?: string;
}

const SECTIONS: readonly IParadisSettingsSectionSpec[] = [
	{
		id: 'psd-sec-space',
		caption: STR_NAV_CAPTION_FEATURES,
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navSpace', "スペース切替"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headSpace', "スペース切替"),
	},
	{
		id: 'psd-sec-preset',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navPreset', "コマンドプリセット"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headPreset', "コマンドプリセット"),
	},
	{
		id: 'psd-sec-layout',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navLayout', "レイアウトプリセット"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headLayout', "レイアウトプリセット"),
	},
	{
		id: 'psd-sec-usage',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navUsage', "使用量"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headUsage', "使用量"),
	},
	{
		id: 'psd-sec-notif',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navNotif', "通知"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headNotif', "通知"),
	},
	{
		id: 'psd-sec-browser',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navBrowser', "ブラウザ共有"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headBrowser', "ブラウザ共有"),
	},
	{
		id: 'psd-sec-terminal',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navTerminal', "ターミナル"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headTerminal', "ターミナル"),
	},
	{
		id: 'psd-sec-mobile',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navMobile', "モバイル連携"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headMobile', "モバイル連携"),
	},
	{
		id: 'psd-sec-remote',
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navRemote', "リモート (SSH)"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headRemote', "リモート (SSH)"),
	},
	{
		id: 'psd-sec-window',
		caption: STR_NAV_CAPTION_WINDOW,
		// allow-any-unicode-next-line
		navLabel: localize('paradis.settings.navWindow', "透明化・その他"),
		// allow-any-unicode-next-line
		heading: localize('paradis.settings.headWindow', "ウィンドウ"),
	},
];

/**
 * Para Code 独自設定の一覧。ここに並べたキーだけがダイアログに出る
 * (paradis.* すべてを機械的に出すと、内部向けの細かい調整値まで並んでしまうため、
 * 「ユーザーが触って意味がある」ものを明示的に選んでいる)。
 */
interface IParadisSettingRowSpec {
	readonly sectionId: string;
	/** 設定キー。専用ダイアログを開くだけの行では undefined。 */
	readonly key?: string;
	readonly label: string;
	readonly description?: string;
	/** 検索用の追加キーワード (キー・ラベル・説明は自動で対象になる)。 */
	readonly keywords?: string;
	/** 文字列設定の入力欄プレースホルダ。 */
	readonly placeholder?: string;
	/** 数値 select の選択肢 (値 → 表示ラベル)。 */
	readonly choices?: readonly { readonly value: string | number; readonly label: string }[];
	// allow-any-unicode-next-line
	/**
	 * enum 選択肢の表示名だけを差し替える (値 → 表示名)。
	 * choices と違い一覧そのものはスキーマ側が持ち続けるので、後から enum に値が増えても
	 * ここに書き忘れた値が画面から消えることがない (その値はスキーマの説明で出る)。
	 */
	readonly choiceLabels?: Readonly<Record<string, string>>;
	/** 行の右端に置くボタン。押すとコマンドを実行してこのダイアログは閉じる。 */
	readonly action?: { readonly label: string; readonly commandId: string; readonly primary?: boolean };
}

const ROWS: readonly IParadisSettingRowSpec[] = [
	// --- スペース切替 ---
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.worktreeRoot',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.worktreeRoot', "スペースの作成先"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.worktreeRootDesc', "空欄なら、リポジトリの隣に「{リポジトリ名}-worktrees」を作ってその中に置きます。"),
		// allow-any-unicode-next-line
		placeholder: localize('paradis.settings.unset', "(未設定)"),
		keywords: 'worktree root space path',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.autoImportWorktrees',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.autoImport', "既にある worktree を一覧に取り込む"),
		keywords: 'auto import worktree detect',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.autoRemoveMissingWorktrees',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.autoRemove', "無くなったスペースを一覧から外す"),
		keywords: 'auto remove missing worktree prune',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.scopeScmRepositories',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.scopeScm', "ソース管理を今のスペースだけに絞る"),
		keywords: 'scm git scope repository filter',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.defaultAgent',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.defaultAgent', "既定のエージェント"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.defaultAgentDesc', "空欄なら、前回選んだものを覚えて使います。"),
		// allow-any-unicode-next-line
		placeholder: localize('paradis.settings.defaultAgentPlaceholder', "(前回選択を記憶)"),
		keywords: 'default agent last selected claude codex',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.agents',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.agents', "エージェントの一覧"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.agentsDesc', "新しいスペースで選べるエージェントと、モデル・エフォート・権限の候補を編集します。"),
		keywords: 'agents claude codex gemini model effort permission',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.cloneParentDirectory',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.cloneParentDir', "リポジトリのクローン先"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.cloneParentDirDesc', "空欄なら、クローンのたびに保存先を尋ねます。"),
		placeholder: '~/github',
		keywords: 'clone parent directory repository add url',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.workspaceSwitch.rowMeta',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.rowMeta', "スペース一覧に表示する情報"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.rowMetaDesc', "行を右クリックした「表示する情報」からも変えられます。"),
		keywords: 'workspaces view row meta pull request issue diff notes order',
	},
	{
		sectionId: 'psd-sec-space',
		key: 'paradis.agentLiveWindow.titleBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.agentLiveTitleBar', "タイトルバーに「エージェント一覧」ボタンを表示"),
		keywords: 'agent live window titlebar list',
	},

	// --- レイアウトプリセット ---
	{
		sectionId: 'psd-sec-layout',
		key: 'paradis.editor.layoutPresets',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.layoutPresets', "レイアウトプリセット"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.layoutPresetsDesc', "エディタ内のターミナル・ブラウザ・ファイルの並べ方を保存して呼び出せます。"),
		keywords: 'layout presets editor area terminal browser file split',
		action: {
			// allow-any-unicode-next-line
			label: localize('paradis.settings.layoutPresetsAction', "レイアウトプリセットを管理…"),
			commandId: 'paradis.editor.showLayoutPresets',
			primary: true,
		},
	},

	// --- コマンドプリセット ---
	{
		sectionId: 'psd-sec-preset',
		key: 'paradis.terminal.presets',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.presets', "コマンドプリセット"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.presetsDesc', "よく使うコマンドを登録して、ターミナルからすぐ実行できます。"),
		keywords: 'terminal presets command manage',
		action: {
			// allow-any-unicode-next-line
			label: localize('paradis.settings.presetsAction', "コマンドプリセットを管理…"),
			commandId: 'paradis.terminal.configurePresets',
			primary: true,
		},
	},

	// --- 使用量ダッシュボード ---
	{
		sectionId: 'psd-sec-usage',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.usageDashboard', "使用量ダッシュボード"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.usageDashboardDesc', "AI コスト・GitHub API の残量・rtk の節約量をまとめて見ます。"),
		keywords: 'usage dashboard ccusage github rtk unified',
		action: {
			// allow-any-unicode-next-line
			label: localize('paradis.settings.usageDashboardAction', "開く…"),
			commandId: 'paradis.usage.showDashboard',
			primary: true,
		},
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.ccusage.executablePath',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.ccusagePath', "ccusage のパス"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.ccusagePathDesc', "空欄なら自動で探します。見つからないときだけ指定してください。"),
		placeholder: '/usr/local/bin/ccusage',
		keywords: 'ccusage executable path cost',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.ccusage.statusBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.ccusageStatusBar', "今日の AI コストをステータスバーに表示"),
		keywords: 'ccusage status bar today cost',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.ccusage.execTimeoutSeconds',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.ccusageExecTimeout', "ccusage の実行タイムアウト"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.ccusageExecTimeoutDesc', "ログの量が多いと集計に時間がかかります。取得できない場合は延ばしてください。"),
		keywords: 'ccusage timeout seconds exec collecting slow',
		choiceLabels: {
			// allow-any-unicode-next-line
			'60': localize('paradis.settings.ccusageExecTimeout60', "60秒"),
			// allow-any-unicode-next-line
			'120': localize('paradis.settings.ccusageExecTimeout120', "2分"),
			// allow-any-unicode-next-line
			'180': localize('paradis.settings.ccusageExecTimeout180', "3分（既定）"),
			// allow-any-unicode-next-line
			'300': localize('paradis.settings.ccusageExecTimeout300', "5分"),
			// allow-any-unicode-next-line
			'600': localize('paradis.settings.ccusageExecTimeout600', "10分"),
		},
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.githubMetrics.statusBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.ghStatusBar', "GitHub API の残量をステータスバーに表示"),
		keywords: 'github metrics rate limit status bar remaining',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.githubMetrics.refreshIntervalSeconds',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.ghRefreshInterval', "GitHub API の自動更新の間隔"),
		keywords: 'github metrics refresh interval dashboard',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.rtk.executablePath',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.rtkPath', "rtk のパス"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.rtkPathDesc', "空欄なら自動で探します。SSH 中は接続先の rtk を使うので、リモート側の設定に書いてください。"),
		// allow-any-unicode-next-line
		placeholder: localize('paradis.settings.rtkPathPlaceholder', "(自動で探す)"),
		keywords: 'rtk executable path token killer',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.rtk.statusBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.rtkStatusBar', "今日 rtk が減らしたトークン数をステータスバーに表示"),
		keywords: 'rtk status bar saved tokens today',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.limitsMonitor.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.limitsMonitor', "利用上限の残りをタイトルバーに表示"),
		keywords: 'limits monitor claude codex usage titlebar',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.limitsMonitor.cswapPath',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.cswapPath', "claude-swap のパス"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.cswapPathDesc', "空欄なら自動で探します。見つからないときだけ指定してください。"),
		// allow-any-unicode-next-line
		placeholder: localize('paradis.settings.unset', "(未設定)"),
		keywords: 'cswap claude-swap executable path limits monitor',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.limitsMonitor.codexHomes',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.codexHomes', "追加で見る Codex のフォルダ"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.codexHomesDesc', "既定では ~/.codex とその派生を自動で探します。別の場所にもあるときだけ指定します。"),
		keywords: 'codex home directory limits monitor scan',
	},
	{
		sectionId: 'psd-sec-usage',
		key: 'paradis.resourceMonitor.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.resourceMonitor', "CPU・メモリをタイトルバーに表示"),
		keywords: 'resource monitor cpu memory titlebar',
	},

	// --- 通知 ---
	{
		sectionId: 'psd-sec-notif',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.notifications', "通知と音声報告"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.notificationsDesc', "着信音、デスクトップ通知、おやすみモード、音声報告をまとめて設定します。"),
		keywords: 'notification sound desktop aivis voice do not disturb',
		action: {
			// allow-any-unicode-next-line
			label: localize('paradis.settings.notificationsAction', "通知設定を開く…"),
			commandId: 'paradis.notifications.openSettings',
			primary: true,
		},
	},

	// --- ブラウザ共有 ---
	{
		sectionId: 'psd-sec-browser',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.binding', "エージェントとの接続状態"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.bindingDesc', "内蔵ブラウザのページをエージェントへ渡すための設定を確認します。"),
		keywords: 'browser share mcp para-browser binding',
		action: {
			// allow-any-unicode-next-line
			label: localize('paradis.settings.bindingAction', "接続状態を確認…"),
			commandId: 'paradis.agentBrowser.openBindingDialog',
			primary: true,
		},
	},
	{
		sectionId: 'psd-sec-browser',
		key: 'paradis.agentBrowser.showCursorOverlay',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.cursorOverlay', "エージェントの操作をカーソルで見せる"),
		keywords: 'agent browser cursor overlay',
	},
	{
		sectionId: 'psd-sec-browser',
		key: 'paradis.browser.bookmarkBar.visible',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.bookmarkBar', "ブックマークバーを表示"),
		keywords: 'browser bookmark bar visible',
	},
	{
		sectionId: 'psd-sec-browser',
		key: 'paradis.browserLiveWindow.titleBar.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.browserLiveTitleBar', "タイトルバーに「ブラウザ一覧」ボタンを表示"),
		keywords: 'browser live window titlebar list',
	},
	{
		sectionId: 'psd-sec-browser',
		key: 'paradis.browser.downloads.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.downloads', "ダウンロードを確認なしで受け取る"),
		keywords: 'browser downloads auto save',
	},
	{
		sectionId: 'psd-sec-browser',
		key: 'paradis.browser.downloads.path',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.downloadsPath', "ダウンロードの保存先"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.downloadsPathDesc', "空欄なら、OS のダウンロードフォルダの中の Paracode に保存します。絶対パスで指定してください。"),
		// allow-any-unicode-next-line
		placeholder: localize('paradis.settings.unset', "(未設定)"),
		keywords: 'browser downloads path folder save',
	},

	// --- ターミナル ---
	{
		sectionId: 'psd-sec-terminal',
		key: 'paradis.terminal.daemon.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.daemon', "ターミナルをアプリの終了後も残す"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.daemonDesc', "Para Code を閉じても、走っているコマンドが止まりません。"),
		keywords: 'terminal daemon pty keep alive persistent',
	},
	{
		sectionId: 'psd-sec-terminal',
		key: 'paradis.terminal.daemon.keepAliveOnClose',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.daemonKeepAlive', "ウィンドウを閉じるときの動き"),
		keywords: 'terminal daemon keep alive close',
		// allow-any-unicode-next-line
		// スキーマの説明をそのまま出すと長いので、この 3 値だけ短い表示名にする
		choiceLabels: {
			// allow-any-unicode-next-line
			ask: localize('paradis.settings.keepAliveAsk', "毎回尋ねる"),
			// allow-any-unicode-next-line
			always: localize('paradis.settings.keepAliveAlways', "尋ねずに残す"),
			// allow-any-unicode-next-line
			never: localize('paradis.settings.keepAliveNever', "尋ねずに終了する"),
		},
	},
	{
		sectionId: 'psd-sec-terminal',
		key: 'paradis.terminal.daemon.reattachAcrossUpdates',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.daemonReattach', "更新をまたいで繋ぎ直す (実験的)"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.daemonReattachDesc', "更新したあとも、それまでのターミナルにそのまま繋がります。SSH 接続先でも同じように動きます。"),
		keywords: 'terminal daemon reattach update experimental pty host',
	},
	{
		sectionId: 'psd-sec-terminal',
		key: 'paradis.terminal.shiftEnterNewline',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.shiftEnter', "Shift+Enter で改行を入力する"),
		keywords: 'terminal shift enter newline',
	},
	{
		sectionId: 'psd-sec-terminal',
		key: 'paradis.editor.openTerminalOnSplit',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.openTerminalOnSplit', "エディタを分割したらターミナルを開く"),
		keywords: 'editor split terminal',
	},
	{
		sectionId: 'psd-sec-terminal',
		key: 'paradis.power.keepAwake',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.keepAwake', "エージェント実行中のスリープ"),
		keywords: 'power keep awake sleep prevent',
		choiceLabels: {
			// allow-any-unicode-next-line
			off: localize('paradis.settings.keepAwakeOff', "防がない"),
			// allow-any-unicode-next-line
			system: localize('paradis.settings.keepAwakeSystem', "システムのスリープを防ぐ"),
			// allow-any-unicode-next-line
			display: localize('paradis.settings.keepAwakeDisplay', "画面のスリープも防ぐ"),
		},
	},
	{
		sectionId: 'psd-sec-terminal',
		key: 'paradis.codex.terminalTitle.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.codexTerminalTitle', "Codex の会話からタブ名を付ける"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.codexTerminalTitleDesc', "手動で変更したタブ名や Codex の /rename は常に優先されます。"),
		keywords: 'codex terminal title tab name rename',
	},

	// --- モバイル連携 ---
	{
		sectionId: 'psd-sec-mobile',
		key: 'paradis.mobile.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.mobileEnabled', "モバイルアプリからの接続を許可する"),
		keywords: 'mobile relay iphone ipad remote',
	},
	{
		sectionId: 'psd-sec-mobile',
		key: 'paradis.mobile.pcName',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.mobilePcName', "モバイルに表示する PC 名"),
		// allow-any-unicode-next-line
		placeholder: localize('paradis.settings.mobilePcNamePlaceholder', "(ホスト名)"),
		keywords: 'mobile pc name display',
	},
	{
		sectionId: 'psd-sec-mobile',
		key: 'paradis.mobile.relayUrl',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.mobileRelayUrl', "リレーサーバー URL"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.mobileRelayUrlDesc', "自分でリレーを運用する場合だけ指定します。"),
		// allow-any-unicode-next-line
		placeholder: localize('paradis.settings.mobileRelayUrlPlaceholder', "(既定のリレー)"),
		keywords: 'mobile relay url server',
	},
	{
		sectionId: 'psd-sec-mobile',
		key: 'paradis.mobile.agent.codexDaemonStreaming',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.codexDaemonStreaming', "Codex のライブ連携をモバイルへ送る"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.codexDaemonStreamingDesc', "生成中の文字やツールの出力をその場で送ります。Codex を開いたターミナルごとに裏方のプロセスが増えるので、メモリと起動時間は増えます。"),
		keywords: 'codex daemon streaming mobile live',
	},

	// --- リモート (SSH) ---
	{
		sectionId: 'psd-sec-remote',
		key: 'paradis.remote.openDefaultWorkspace',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.remoteOpenDefaultWorkspace', "接続先のリポジトリ一覧を自動で開く"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.remoteOpenDefaultWorkspaceDesc', "一覧は接続先ごとに独立します。"),
		keywords: 'remote ssh default workspace open multi repo',
	},
	{
		sectionId: 'psd-sec-remote',
		key: 'paradis.remote.agentReturnTunnel',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.remoteAgentReturnTunnel', "SSH 接続先からの通知経路を開く"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.remoteAgentReturnTunnelDesc', "オフにすると、実行状態のドットやモバイルへの会話の転送が接続先からは届きません。"),
		keywords: 'remote ssh agent return tunnel notification mobile mirror hook mcp',
	},
	{
		sectionId: 'psd-sec-remote',
		key: 'paradis.remote.keepTerminalsAliveOnClose',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.remoteKeepTerminals', "接続先でウィンドウを閉じるときの動き"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.remoteKeepTerminalsDesc', "残したターミナルは、次に同じ接続先へつなぎ直したときにタブや分割ごと戻ります。"),
		keywords: 'remote ssh terminal keep alive close ask always never',
		// allow-any-unicode-next-line
		// スキーマの説明は長いので、ローカル側 (daemon.keepAliveOnClose) と同じ短い表示名にする
		choiceLabels: {
			// allow-any-unicode-next-line
			ask: localize('paradis.settings.remoteKeepAsk', "毎回尋ねる"),
			// allow-any-unicode-next-line
			always: localize('paradis.settings.remoteKeepAlways', "尋ねずに残す"),
			// allow-any-unicode-next-line
			never: localize('paradis.settings.remoteKeepNever', "尋ねずに終了する"),
		},
	},

	// --- ウィンドウ ---
	{
		sectionId: 'psd-sec-window',
		key: 'paradis.window.transparency.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.transparency', "ウィンドウを透過させる"),
		// allow-any-unicode-next-line
		description: localize('paradis.settings.transparencyDesc', "切り替えたあと、ウィンドウの再読み込みが必要です。"),
		keywords: 'window transparency transparent',
	},
	{
		sectionId: 'psd-sec-window',
		key: 'paradis.window.transparency.opacity',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.opacity', "不透明度"),
		keywords: 'window opacity level transparency',
		choices: [
			{ value: 1, label: '100%' },
			{ value: 0.96, label: '96%' },
			{ value: 0.9, label: '90%' },
			{ value: 0.85, label: '85%' },
			{ value: 0.8, label: '80%' },
			{ value: 0.7, label: '70%' },
		],
	},
	{
		sectionId: 'psd-sec-window',
		key: 'paradis.releaseNotes.showOnUpdate',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.releaseNotes', "更新のあとに更新履歴を表示する"),
		keywords: 'release notes changelog update',
	},
	{
		sectionId: 'psd-sec-window',
		key: 'paradis.serviceStatus.enabled',
		// allow-any-unicode-next-line
		label: localize('paradis.settings.serviceStatus', "サービスの稼働状況を表示する"),
		keywords: 'service status incident chip',
	},
];

export class ParadisSettingsDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _searchInput: HTMLInputElement;
	private readonly _contentEl: HTMLElement;
	private readonly _navItems = new Map<string, { item: HTMLElement; chip: HTMLElement }>();
	private readonly _sections = new Map<string, HTMLElement>();
	private readonly _rows: { spec: IParadisSettingRowSpec; el: HTMLElement; searchText: string }[] = [];
	private readonly _searchEmptyEl: HTMLElement;
	/** 設定キーごとのコントロール更新関数 (外部変更を画面へ反映するため)。 */
	private readonly _refreshers: (() => void)[] = [];

	constructor(
		@ILayoutService layoutService: ILayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._backdrop = $('.paradis-settings-dialog-backdrop');
		const modal = $('.paradis-settings-dialog');
		this._backdrop.appendChild(modal);

		// ---------- header ----------
		const header = dom.append(modal, $('.psd-header'));
		dom.append(header, $('h2')).textContent = STR_TITLE;

		const searchBox = dom.append(header, $('.psd-search'));
		searchBox.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this._searchInput = dom.append(searchBox, $('input')) as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = STR_SEARCH_PLACEHOLDER;
		this._register(dom.addDisposableListener(this._searchInput, 'input', () => this._applySearchFilter()));
		// 検索欄内の Escape は「検索語クリア」として扱い、ダイアログは閉じない
		// (空のときはそのまま背景側の Escape ハンドラへ渡して閉じる)。
		this._register(dom.addDisposableListener(this._searchInput, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape && this._searchInput.value.length > 0) {
				event.preventDefault();
				event.stopPropagation();
				this._searchInput.value = '';
				this._applySearchFilter();
			}
		}));

		dom.append(header, $('.psd-autosave')).textContent = STR_AUTOSAVE;

		const closeBtn = dom.append(header, $('.psd-close'));
		closeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', STR_CLOSE_ARIA);
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.dispose()));

		// ---------- body（左ナビ + 右コンテンツ） ----------
		const body = dom.append(modal, $('.psd-body'));
		const nav = dom.append(body, $('nav.psd-nav'));
		this._contentEl = dom.append(body, $('.psd-content'));
		this._buildSections(nav);
		this._searchEmptyEl = dom.append(this._contentEl, $('.psd-search-empty'));
		this._searchEmptyEl.textContent = STR_SEARCH_EMPTY;
		this._searchEmptyEl.classList.add('hidden');

		modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this.dispose();
			}
		}));

		// 別ウィンドウ・設定エディタ側からの変更にも追従させる
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('paradis')) {
				for (const refresh of this._refreshers) {
					refresh();
				}
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._activateNavItem(SECTIONS[0].id);
		modal.focus();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	// ==========================================================================================

	private _buildSections(nav: HTMLElement): void {
		for (const spec of SECTIONS) {
			if (spec.caption) {
				dom.append(nav, $('.psd-nav-caption')).textContent = spec.caption;
			}
			const item = dom.append(nav, $('.psd-nav-item'));
			item.setAttribute('role', 'button');
			dom.append(item, $('span.psd-nav-label')).textContent = spec.navLabel;
			const chip = dom.append(item, $('span.psd-nav-chip'));
			this._navItems.set(spec.id, { item, chip });
			this._register(dom.addDisposableListener(item, 'click', () => this._navigateTo(spec.id)));

			const section = dom.append(this._contentEl, $('section.psd-section'));
			section.id = spec.id;
			dom.append(section, $('.psd-section-head')).textContent = spec.heading;
			if (spec.description) {
				dom.append(section, $('.psd-section-desc')).textContent = spec.description;
			}
			this._sections.set(spec.id, section);

			for (const row of ROWS.filter(candidate => candidate.sectionId === spec.id)) {
				this._buildRow(section, row);
			}
		}
	}

	private _buildRow(section: HTMLElement, spec: IParadisSettingRowSpec): void {
		const row = dom.append(section, $('.psd-row'));
		const main = dom.append(row, $('.psd-row-main'));
		const label = dom.append(main, $('.psd-row-label'));
		dom.append(label, $('span')).textContent = spec.label;
		// allow-any-unicode-next-line
		// 設定キー (paradis.*) は画面に出さない。行が名前だけになって読みやすくなるため。
		// 下の searchText には key を残してあるので、キーを知っている人はそれで引ける。
		// settings.json を直接編集したいときのために、ホバーでは読めるようにしておく。
		if (spec.key) {
			row.title = spec.key;
		}
		if (spec.description) {
			dom.append(main, $('.psd-row-desc')).textContent = spec.description;
		}

		if (spec.action) {
			const button = dom.append(row, $(`button.psd-btn${spec.action.primary ? '.psd-btn-primary' : ''}`)) as HTMLButtonElement;
			button.textContent = spec.action.label;
			const commandId = spec.action.commandId;
			this._register(dom.addDisposableListener(button, 'click', () => {
				// 遷移先も同じ層のダイアログなので、重ならないようこちらを閉じてから開く
				this.dispose();
				void this.commandService.executeCommand(commandId);
			}));
		} else if (spec.key) {
			this._buildControl(row, spec.key, spec);
		}

		this._rows.push({
			spec,
			el: row,
			searchText: [spec.label, spec.description ?? '', spec.key ?? '', spec.keywords ?? ''].join(' ').toLowerCase(),
		});
	}

	/**
	 * 設定スキーマに enum が宣言されていれば、その選択肢を拾う。
	 * ここを見ずに型だけで判断すると、enum の文字列設定 (スリープ防止のモード等) が
	 * 自由入力のテキスト欄になり、綴りを間違えた値をそのまま書けてしまう。
	 */
	private _enumChoices(key: string): readonly { value: string; label: string }[] | undefined {
		const schema = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties()[key];
		const values = schema?.enum;
		if (!Array.isArray(values) || values.length === 0) {
			return undefined;
		}
		const descriptions = schema?.enumDescriptions;
		return values.map((value, index) => {
			const raw = String(value);
			const description = descriptions?.[index];
			// 説明があれば短く添える (設定エディタと違い1行なので、先頭の一文だけ)
			const summary = description?.split(/[。\n]/)[0]?.trim();
			// allow-any-unicode-next-line
			// 生の設定値 (ask / off など) は利用者に意味がないので出さない。
			// 説明が無いスキーマのときだけ、やむを得ず値そのものを出す。
			return { value: raw, label: summary || raw };
		});
	}

	/** 設定値の型 (と choices 指定・スキーマの enum) を見てコントロールを選ぶ。 */
	private _buildControl(row: HTMLElement, key: string, spec: IParadisSettingRowSpec): void {
		const value = this.configurationService.getValue(key);
		const enumChoices = spec.choices ? undefined : this._enumChoices(key);
		if (enumChoices) {
			const overrides = spec.choiceLabels;
			spec = {
				...spec,
				choices: overrides
					? enumChoices.map(choice => ({ value: choice.value, label: overrides[choice.value] ?? choice.label }))
					: enumChoices,
			};
		}

		if (spec.choices) {
			const select = dom.append(row, $('select.psd-select')) as HTMLSelectElement;
			for (const choice of spec.choices) {
				const option = dom.append(select, $('option')) as HTMLOptionElement;
				option.value = String(choice.value);
				option.textContent = choice.label;
			}
			// 用意した刻み (不透明度の 96% など) に載らない値が既に入っていることがある。
			// そのまま黙って別の値を選んだ状態にすると、開いただけで設定が変わったように
			// 見えるので、実際の値を選択肢へ足して選んでおく。差し替え式にして増殖させない。
			let extraOption: HTMLOptionElement | undefined;
			const sync = () => {
				const current = String(this.configurationService.getValue(key) ?? '');
				const known = spec.choices?.some(choice => String(choice.value) === current) ?? false;
				extraOption?.remove();
				extraOption = undefined;
				if (!known) {
					extraOption = dom.append(select, $('option')) as HTMLOptionElement;
					extraOption.value = current;
					extraOption.textContent = current;
				}
				select.value = current;
			};
			sync();
			this._refreshers.push(sync);
			this._register(dom.addDisposableListener(select, 'change', () => {
				const raw = select.value;
				const numeric = Number(raw);
				void this._write(key, Number.isFinite(numeric) && raw.trim() !== '' ? numeric : raw);
			}));
			return;
		}

		if (typeof value === 'boolean') {
			const toggle = dom.append(row, $('input.psd-toggle')) as HTMLInputElement;
			toggle.type = 'checkbox';
			const sync = () => { toggle.checked = this.configurationService.getValue<boolean>(key) === true; };
			sync();
			this._refreshers.push(sync);
			this._register(dom.addDisposableListener(toggle, 'change', () => void this._write(key, toggle.checked)));
			return;
		}

		if (typeof value === 'string' || value === undefined) {
			const input = dom.append(row, $('input.psd-input')) as HTMLInputElement;
			input.type = 'text';
			input.spellcheck = false;
			if (spec.placeholder) {
				input.placeholder = spec.placeholder;
			}
			const sync = () => { input.value = this.configurationService.getValue<string>(key) ?? ''; };
			sync();
			this._refreshers.push(sync);
			// 入力途中で毎回書かない (設定ファイルが1文字ごとに書き変わるのを避ける)
			this._register(dom.addDisposableListener(input, 'change', () => void this._write(key, input.value)));
			return;
		}

		// 配列・オブジェクト設定 (エージェント定義・プリセット等) はここでは編集させず、
		// 標準の設定エディタへ送る
		const button = dom.append(row, $('button.psd-btn')) as HTMLButtonElement;
		button.textContent = STR_OPEN_SETTINGS_EDITOR;
		this._register(dom.addDisposableListener(button, 'click', () => {
			this.dispose();
			void this.commandService.executeCommand('workbench.action.openSettings', `@id:${key}`);
		}));
	}

	private async _write(key: string, value: unknown): Promise<void> {
		// スコープは設定スキーマ側の宣言 (APPLICATION/MACHINE/WINDOW) に任せる。
		// USER を明示すると WINDOW スコープの設定が意図しない側へ書かれる
		await this.configurationService.updateValue(key, value, ConfigurationTarget.USER);
	}

	private _navigateTo(sectionId: string): void {
		this._activateNavItem(sectionId);
		this._sections.get(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	private _activateNavItem(sectionId: string): void {
		for (const entry of this._navItems.values()) {
			entry.item.classList.remove('active');
		}
		this._navItems.get(sectionId)?.item.classList.add('active');
	}

	/** 検索語で行を絞り、ヒットが 0 のセクションは丸ごと隠す。 */
	private _applySearchFilter(): void {
		const query = this._searchInput.value.trim().toLowerCase();
		const hitsPerSection = new Map<string, number>();

		for (const row of this._rows) {
			const hit = query.length === 0 || row.searchText.includes(query);
			row.el.classList.toggle('hidden', !hit);
			if (hit) {
				hitsPerSection.set(row.spec.sectionId, (hitsPerSection.get(row.spec.sectionId) ?? 0) + 1);
			}
		}

		let totalHits = 0;
		for (const spec of SECTIONS) {
			const hits = hitsPerSection.get(spec.id) ?? 0;
			totalHits += hits;
			this._sections.get(spec.id)?.classList.toggle('hidden', hits === 0);
			const nav = this._navItems.get(spec.id);
			if (nav) {
				nav.item.classList.toggle('hidden', query.length > 0 && hits === 0);
				nav.chip.textContent = query.length > 0 && hits > 0 ? String(hits) : '';
			}
		}

		this._searchEmptyEl.classList.toggle('hidden', totalHits > 0);
	}
}
