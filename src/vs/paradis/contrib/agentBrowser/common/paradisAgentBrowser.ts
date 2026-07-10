/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナル上のエージェントCLI（Claude Code / Codex）紐付け機能の共有定義。
// workbench（browser / electron-browser）と shared process（node）の両方から参照される。

import { Event } from '../../../../base/common/event.js';

/**
 * ターミナルのPTY環境へ注入する、ペインを一意に識別するトークンの環境変数名。
 * ターミナル内で起動されたエージェントCLI（およびそのstdio MCP子プロセス）に継承され、
 * MCPサーバーへの Bearer トークンとして使われる。
 */
export const PARADIS_PANE_TOKEN_ENV_VAR = 'PARA_CODE_TERMINAL_PANE_ID';

/**
 * MCPサーバーのポートファイル（絶対パス）を指す環境変数名。
 * stdioシムは毎起動時にこのファイルを読み直して現在のサーバーポートを解決する
 * （shared process再起動によるポート変化への追従）。
 */
export const PARADIS_MCP_PORT_FILE_ENV_VAR = 'PARA_CODE_MCP_PORT_FILE';

/**
 * userDataDir 直下に書き出されるポートファイルのファイル名。
 * 内容: `{ "port": number, "pid": number }`
 */
export const PARADIS_MCP_PORT_FILE_NAME = 'paradis-browser-mcp.json';

/**
 * CDPゲートウェイのベースURL（`http://127.0.0.1:<port>/cdp`）を指す環境変数名。
 * chrome-devtools-mcp の `--browserUrl` や browser-use の CDP URL にそのまま渡せる。
 * ポート部分は {@link PARADIS_MCP_DEFAULT_PORT}（PTY起動時点の既定値）で固定注入されるため、
 * サーバーが動的ポートへフォールバックした場合は `get_cdp_endpoint` MCPツールで実URLを取得する。
 */
export const PARADIS_CDP_URL_ENV_VAR = 'PARA_CODE_CDP_URL';

/**
 * shared process上のMCP+CDPゲートウェイHTTPサーバーが最初に試す固定listenポート。
 * 使用中の場合は動的ポート（0）へフォールバックし、実ポートはポートファイルに書かれる。
 * 将来的にはParadis設定に載せる想定（現状はconst固定）。
 */
export const PARADIS_MCP_DEFAULT_PORT = 47286;

/**
 * workbench ⇔ shared process 間のバインディング操作用IPCチャネル名。
 */
export const PARADIS_AGENT_BROWSER_CHANNEL = 'paradisAgentBrowser';

/**
 * electron-main ⇔ shared process 間の「browserView viewId → Chromium DevTools targetId」
 * 解決用IPCチャネル名（CDPゲートウェイのターゲットフィルタが使う）。
 */
export const PARADIS_CDP_TARGET_CHANNEL = 'paradisCdpTarget';

/**
 * workbenchウィンドウが shared process の IPCServer へ登録する、ファイルプレビュー
 * オープン用IPCチャネル名。shared process 側（MCPの `preview_file` ツール）が
 * `ipcServer.getChannel(名前, ctxフィルタ)` で「呼び出し元ペインのウィンドウ」だけに
 * ルーティングして呼び出す（逆方向は使わない）。
 */
export const PARADIS_AGENT_PREVIEW_CHANNEL = 'paradisAgentPreview';

/**
 * {@link PARADIS_AGENT_PREVIEW_CHANNEL} の `previewFile` 呼び出し結果。
 * error は LLM がそのまま読む英語メッセージ。
 */
export interface IParadisPreviewFileResult {
	readonly ok: boolean;
	readonly error?: string;
}

/**
 * electron-main のフレーム購読(beginFrameSubscription)が発火する1フレーム
 * （{@link PARADIS_CDP_TARGET_CHANNEL} の `onDidFrame` イベントのペイロード）。
 */
export interface IParadisCdpFrameEvent {
	readonly targetId: string;
	/** base64エンコード済みJPEG。 */
	readonly data: string;
	/** フレームのピクセル寸法（アスペクト比・タップ座標の正規化用）。 */
	readonly w: number;
	readonly h: number;
}

/**
 * shared process から見た electron-main のフレーム購読プロキシ
 * （`ProxyChannel.toService` で {@link PARADIS_CDP_TARGET_CHANNEL} に接続する）。
 */
export interface IParadisCdpFrameSubscription {
	readonly onDidFrame: Event<IParadisCdpFrameEvent>;
	/** 購読開始。対象が見つからない場合は false（呼び出し側はポーリングに留まる）。 */
	startFrameSubscription(targetId: string): Promise<boolean>;
	stopFrameSubscription(targetId: string): Promise<void>;
	/**
	 * WebRTCミラー用: 次の1回の getDisplayMedia が指定targetIdのWebContentsView単体を
	 * キャプチャするよう electron-main を arm する（one-shot、TTL付き）。
	 * モバイルの webrtc-offer 受信時に shared process から呼ぶ。
	 */
	armMirrorCapture(targetId: string): Promise<void>;
}

/**
 * CDPゲートウェイ経由のスクリーンショット委譲リクエスト
 * （shared process → electron-main、{@link PARADIS_CDP_TARGET_CHANNEL} の
 * `captureScreenshot` メソッド引数）。
 * upstream の `IBrowserViewCaptureScreenshotOptions`（vs/platform/browserView/common/browserView.ts）
 * のサブセット。CDP `Page.captureScreenshot` のパラメータから
 * paradisCdpFilterProxy.ts がマッピングして生成する。
 */
export interface IParadisCdpScreenshotOptions {
	readonly format?: 'jpeg' | 'png';
	/** JPEG品質（0-100、formatが'jpeg'のときのみ）。 */
	readonly quality?: number;
	/** CDP `clip` 由来のページ内矩形（CSSピクセル）。 */
	readonly pageRect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	/** CDP `captureBeyondViewport`（clipなし）由来のフルページ指定。 */
	readonly fullPage?: boolean;
}

/**
 * バインド時に記録される共有ページの情報。
 */
export interface IParadisSharedPageInfo {
	readonly url: string;
	readonly title: string;
}

/**
 * ペイントークンと共有ブラウザページのバインディング（shared process側レジストリの1エントリ）。
 */
export interface IParadisPaneBinding {
	readonly token: string;
	/** ブラウザビューのID（PlaywrightService の pageId / viewId に相当）。 */
	readonly pageId: string;
	readonly pageInfo: IParadisSharedPageInfo;
	/** バインドされた時刻（epoch ms）。バインディングダイアログの「共有開始 N分前」表示に使う。 */
	readonly boundAt: number;
}

// --- エージェント実行状態 (workspaceSwitch のスピナー表示用、Superset 移植) ---------------------

/**
 * ペインで動くエージェントCLIの実行状態。Superset (apps/desktop の shared/tabs-types.ts
 * PaneStatus) の4状態モデル + 質問状態。idle は「エントリなし」で表現する。
 * - working: エージェントがターン実行中 (スピナー表示)
 * - permission: 人間の対応が必要 (ツール実行の許可待ち。赤の脈動表示)
 * - question: エージェントからの選択式質問 (AskUserQuestion) に回答待ち (赤の脈動表示)。
 *   permission と分ける理由: モバイル通知は質問本文入りの専用経路 (transcriptミラー) が
 *   担当するため、状態遷移ベースの汎用通知と二重にならないよう発火元で区別が要る
 * - review: ターン完了、確認待ち (緑の静止ドット。スコープを開いたら idle へ確認遷移)
 */
export type ParadisAgentStatus = 'working' | 'permission' | 'question' | 'review';

export interface IParadisAgentPaneStatus {
	readonly token: string;
	readonly status: ParadisAgentStatus;
	/** 最終更新 (epoch ms) */
	readonly changedAt: number;
	/**
	 * hookが最後に報告した作業ディレクトリ。renderer側でトークン→ターミナルの解決が
	 * できない場合 (ウィンドウリロード後にpark中のエディタターミナルがまだ復元されていない等) の
	 * スコープ解決フォールバック (cwd→リポジトリ/worktreeルートの最長一致) に使う。
	 */
	readonly cwd?: string;
}

/**
 * 各エージェントCLIのhookイベント名を状態へ正規化する。Superset の
 * main/lib/notifications/map-event-type.ts の正規化テーブル移植 + Claude Code の
 * Notification イベント対応。undefined = 未知イベント (無視)、'idle' = エントリ削除。
 */
// --- ワンボタンMCPセットアップ（バインディングダイアログの「自動セットアップ」用） -----------------

/** セットアップ対象のエージェントCLI種別。 */
export type ParadisMcpCli = 'claude' | 'codex';

/** 1つのMCPサーバー登録の結果。 */
export type ParadisMcpSetupOutcome = 'success' | 'already' | 'error';

/**
 * ワンボタンMCPセットアップの要求。実行はshared process（node層）で行うが、
 * shimの絶対パスとCDP URLはelectron-browser側でFileAccessから解決して渡す
 * （表示スニペットと同一のパスを使い、二重解決による齟齬を防ぐ）。
 */
export interface IParadisMcpSetupRequest {
	readonly cli: ParadisMcpCli;
	/** paradisBrowserMcpShim.js の絶対パス。 */
	readonly shimPath: string;
	/** CDPゲートウェイの既定URL（`http://127.0.0.1:<port>/cdp`）。 */
	readonly cdpUrl: string;
}

/** 各MCPサーバー（para-browser / chrome-devtools）ごとのセットアップ結果。 */
export interface IParadisMcpSetupServerResult {
	readonly server: string;
	readonly outcome: ParadisMcpSetupOutcome;
	/** outcome==='error' のときの詳細（stderr/例外メッセージ、表示用）。 */
	readonly detail?: string;
}

/** ワンボタンMCPセットアップの結果全体。 */
export interface IParadisMcpSetupResult {
	readonly cli: ParadisMcpCli;
	/** claude CLIがPATH上に見つかったか（codexでは常にtrue）。falseなら手動セットアップへ誘導する。 */
	readonly cliAvailable: boolean;
	/** 設定を書き込んだ先の説明（例: config.tomlの絶対パス。表示用、任意）。 */
	readonly target?: string;
	readonly servers: readonly IParadisMcpSetupServerResult[];
}

export function paradisNormalizeAgentHookEvent(eventType: string, message?: string): ParadisAgentStatus | 'idle' | undefined {
	switch (eventType) {
		// 完了系: Claude Code / Codex / OpenCode
		// StopFailure は「APIエラーでターンが終わった」(Claude Code)。実行中表示が
		// 残り続けるより「終わったので確認して」の方が実態に合うため review に畳む。
		case 'Stop':
		case 'SubagentStop':
		case 'StopFailure':
		case 'agent-turn-complete':
		case 'task_complete':
		case 'SessionEnd':
			return 'review';
		// Claude Code の Notification は許可要求以外でも発火する（プロンプトが60秒以上
		// 入力待ちのままのアイドル通知 "Claude is waiting for your input" 等）。message が
		// 許可要求を示すときだけ permission として扱い、それ以外は状態を変えない（undefined）。
		// 本物の許可要求の検出は PermissionRequest hook が本線で、これはその
		// フォールバック（PermissionRequest 未対応の旧 Claude Code 向け）。
		case 'Notification':
			return message !== undefined && /permission/i.test(message) ? 'permission' : undefined;
		// 要対応系: 許可要求・ユーザー入力要求
		case 'PermissionRequest':
		case 'exec_approval_request':
		case 'apply_patch_approval_request':
		case 'request_user_input':
		case 'permission.ask':
			return 'permission';
		// セッション開始はエージェント起動直後（プロンプト表示のみでターン未実行）にも発火する。
		// working にするとCLIを起動しただけで「実行中」表示になるため、状態は変えない
		// （実行中への遷移は UserPromptSubmit / PreToolUse 等の実際の活動イベントで行う）。
		case 'SessionStart':
			return undefined;
		// 実行中系
		// PostToolUseFailure / PermissionDenied はどちらも「ツールは失敗/拒否されたが
		// ターンは継続中」(Claude Code) なので実行中扱い (permission の解除にも効く)。
		case 'UserPromptSubmit':
		case 'PreToolUse':
		case 'PostToolUse':
		case 'PostToolUseFailure':
		case 'PermissionDenied':
		case 'task_started':
		case 'Start':
			return 'working';
		// 終了 (プロセス消滅)
		case 'TerminalExit':
			return 'idle';
		default:
			return undefined;
	}
}
