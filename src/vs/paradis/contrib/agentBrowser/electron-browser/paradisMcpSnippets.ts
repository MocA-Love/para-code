/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLI（Claude Code / Codex）向けMCPセットアップスニペットの生成ロジック。
// 「Paradis: Copy MCP Setup Command」コマンドとバインディングダイアログの両方から使われる
// （挙動の二重実装を避けるための共通化モジュール）。

import { FileAccess } from '../../../../base/common/network.js';
import { PARADIS_CDP_URL_ENV_VAR, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

/** stdioシム（毎起動時にポートファイルから実ポートを解決する）の絶対パス。 */
function getShimPath(): string {
	return FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.js').fsPath;
}

/** CDPゲートウェイの既定URL（PTYへ注入される `PARA_CODE_CDP_URL` と同じ値）。 */
export function getParadisCdpUrl(): string {
	return `http://127.0.0.1:${PARADIS_MCP_DEFAULT_PORT}/cdp`;
}

/** 指定ペイントークン用のMCPエンドポイントURL（参考表示用）。 */
export function getParadisMcpEndpointForToken(token: string): string {
	return `http://127.0.0.1:${PARADIS_MCP_DEFAULT_PORT}/mcp?pane=${encodeURIComponent(token)}`;
}

/**
 * Claude Code向けセットアップスニペット: シェルにそのまま貼れる純粋なコマンドのみ
 * （コメント行はzshの既定で interactivecomments が無効だとエラーになるため一切含めない）。
 * `${VAR:-default}` はClaude Codeが接続時に展開する（Para Codeペイン外では固定ポートに
 * フォールバックするので設定パースが壊れない）。シェルの事前展開を防ぐシングルクォート必須。
 */
export function getParadisClaudeSetupSnippet(): string {
	const cdpUrl = getParadisCdpUrl();
	return [
		`claude mcp add para-browser -- node "${getShimPath()}"`,
		`claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browserUrl='\${${PARADIS_CDP_URL_ENV_VAR}:-${cdpUrl}}'`,
		'',
	].join('\n');
}

/**
 * Codex向けセットアップスニペット: config.toml に貼るスニペット
 * （TOMLは#コメント可、シェルには貼らない前提）。
 */
export function getParadisCodexSetupSnippet(): string {
	// TOML basic string ではバックスラッシュがエスケープ扱いになるため、Windowsパスを考慮して二重化する
	const shimPathToml = getShimPath().replace(/\\/g, '\\\\');
	const cdpUrl = getParadisCdpUrl();
	return [
		'# Add to ~/.codex/config.toml',
		'[mcp_servers.para-browser]',
		'command = "node"',
		`args = ["${shimPathToml}"]`,
		`env_vars = ["${PARADIS_PANE_TOKEN_ENV_VAR}", "${PARADIS_MCP_PORT_FILE_ENV_VAR}"]`,
		'',
		'[mcp_servers.chrome-devtools]',
		'command = "npx"',
		`args = ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "${cdpUrl}"]`,
		`env_vars = ["${PARADIS_PANE_TOKEN_ENV_VAR}", "${PARADIS_MCP_PORT_FILE_ENV_VAR}", "${PARADIS_CDP_URL_ENV_VAR}"]`,
		'',
	].join('\n');
}
