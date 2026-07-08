/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLI（Claude Code / Codex）向けMCPセットアップスニペットの生成ロジック。
// 「Para Code: Copy MCP Setup Command」コマンドとバインディングダイアログの両方から使われる
// （挙動の二重実装を避けるための共通化モジュール）。

import { FileAccess } from '../../../../base/common/network.js';
import { PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

/** stdioシム（毎起動時にポートファイルから実ポートを解決する）の絶対パス。 */
export function getParadisShimPath(): string {
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
 *
 * chrome-devtools系ツール（take_snapshot / click / navigate_page 等）は para-browser サーバーに
 * 内蔵済み（vendored chrome-devtools-mcp をペイン毎の子プロセスとしてプロキシ）のため、
 * 登録するのは para-browser 1エントリのみ。
 *
 * 注記（CDPゲートウェイの制約）: ゲートウェイが見せるのは「このペインに共有された1ページ」
 * のみで、chrome-devtools系の new_page / close_page / resize_page は非対応
 * （ページの開閉はPara Code UI側で行い、ビューポート変更は emulate ツールを使う。
 * 内蔵プロキシはこれらを一覧から除外して提示する）。
 */
export function getParadisClaudeSetupSnippet(): string {
	return [
		`claude mcp add -s user para-browser -- node "${getParadisShimPath()}"`,
		'',
	].join('\n');
}

/**
 * Codex向けセットアップスニペット: config.toml に貼るスニペット
 * （TOMLは#コメント可、シェルには貼らない前提）。
 */
export function getParadisCodexSetupSnippet(): string {
	// TOML basic string ではバックスラッシュがエスケープ扱いになるため、Windowsパスを考慮して二重化する
	const shimPathToml = getParadisShimPath().replace(/\\/g, '\\\\');
	return [
		'# Add to ~/.codex/config.toml',
		'# Note: chrome-devtools tools are built into the para-browser server (no separate chrome-devtools entry needed).',
		'[mcp_servers.para-browser]',
		'command = "node"',
		`args = ["${shimPathToml}"]`,
		`env_vars = ["${PARADIS_PANE_TOKEN_ENV_VAR}", "${PARADIS_MCP_PORT_FILE_ENV_VAR}"]`,
		'',
	].join('\n');
}
