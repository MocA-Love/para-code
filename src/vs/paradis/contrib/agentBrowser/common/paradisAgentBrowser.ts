/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナル上のエージェントCLI（Claude Code / Codex）紐付け機能の共有定義。
// workbench（browser / electron-browser）と shared process（node）の両方から参照される。

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
