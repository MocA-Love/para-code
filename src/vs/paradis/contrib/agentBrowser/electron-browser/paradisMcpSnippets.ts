/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLI（Claude Code / Codex）向けMCPセットアップスニペットの生成ロジック。
// 「Para Code: Copy MCP Setup Command」コマンドとバインディングダイアログの両方から使われる
// （挙動の二重実装を避けるための共通化モジュール）。

import { isWindows } from '../../../../base/common/platform.js';
import { PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';
import { encodeParadisPosixShellArgument, encodeParadisPowerShellArgument, paradisCodexMcpTableBody, paradisMcpServerUrl } from '../common/paradisMcpSetupEncoding.js';

/** サーバーが立ち上がる前は番号が決まらない。貼れるものが無いことをそのまま伝える。 */
const PORT_UNAVAILABLE_SNIPPET = '# Para Code is still starting its browser server. Reopen this dialog in a moment.\n';

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
export function getParadisClaudeSetupSnippet(port: number | undefined): string {
	if (port === undefined) {
		return PORT_UNAVAILABLE_SNIPPET;
	}
	// ヘッダーは `${…}` のまま貼らせる（展開するのは Claude Code 自身）。シェルが先に展開して
	// しまわないよう、POSIX ではシングルクォート相当・PowerShell では `$` を含む素の文字列を使う。
	const header = `Authorization: Bearer \${${PARADIS_PANE_TOKEN_ENV_VAR}}`;
	const quotedHeader = isWindows
		? encodeParadisPowerShellArgument(header)
		: encodeParadisPosixShellArgument(header);
	return [
		...(isWindows ? ['# PowerShell'] : []),
		`claude mcp add -s user --transport http para-browser ${paradisMcpServerUrl(port)} --header ${quotedHeader}`,
		'',
	].join('\n');
}

/**
 * Codex向けセットアップスニペット: config.toml に貼るスニペット
 * （TOMLは#コメント可、シェルには貼らない前提）。
 */
export function getParadisCodexSetupSnippet(port: number | undefined): string {
	if (port === undefined) {
		return PORT_UNAVAILABLE_SNIPPET;
	}
	return [
		'# Add to ~/.codex/config.toml',
		'# Note: chrome-devtools tools are built into the para-browser server (no separate chrome-devtools entry needed).',
		'[mcp_servers.para-browser]',
		paradisCodexMcpTableBody(port),
		'',
	].join('\n');
}
