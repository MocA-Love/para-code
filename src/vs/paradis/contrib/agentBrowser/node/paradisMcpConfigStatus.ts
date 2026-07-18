/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// バインディングダイアログ「MCP接続設定」タブのステータス判定と、Codex要修正エントリの
// shim方式への書き換えを行うpureなパーサ群（shared processのParadisMcpSetupControllerから使われる）。
// TOMLは全実装せず、既存の注入耐性スキャナ（paradisMcpSetupEncoding）を再利用して安全側に倒す。

import { ParadisMcpConfigState } from '../common/paradisAgentBrowser.js';
import { encodeParadisTomlBasicString, MultilineDelimiter, parseTomlKeyPath, scanTomlLine } from '../common/paradisMcpSetupEncoding.js';

/** stdioシムのファイル名断片。設定値がこれを含めば para-browser（shim方式）とみなす。 */
export const PARADIS_MCP_SHIM_MARKER = 'paradisBrowserMcpShim';

/** Codex config.toml のMCP設定判定結果。 */
export interface IParadisCodexMcpConfigInspection {
	readonly state: ParadisMcpConfigState;
	/** needsFix時に検出した、決め打ちされた古いポート。 */
	readonly detectedPort?: number;
	/** needsFix時に修正対象となる `[mcp_servers.<name>]` のサーバー名。 */
	readonly staleServerName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** MCPサーバー1エントリ（command/args）がshimを参照しているか。 */
function claudeEntryReferencesShim(entry: unknown): boolean {
	if (!isRecord(entry)) {
		return false;
	}
	const strings: string[] = [];
	if (typeof entry.command === 'string') {
		strings.push(entry.command);
	}
	if (Array.isArray(entry.args)) {
		for (const arg of entry.args) {
			if (typeof arg === 'string') {
				strings.push(arg);
			}
		}
	}
	return strings.some(value => value.includes(PARADIS_MCP_SHIM_MARKER));
}

/**
 * `~/.claude.json` のトップレベル `mcpServers` に shim方式の para-browser エントリがあるか判定する。
 * JSONが壊れている・形が想定外なら unconfigured を返す（失敗ではなく未設定として扱う）。
 */
export function inspectParadisClaudeMcpJson(text: string): 'configured' | 'unconfigured' {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return 'unconfigured';
	}
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		return 'unconfigured';
	}
	for (const entry of Object.values(parsed.mcpServers)) {
		if (claudeEntryReferencesShim(entry)) {
			return 'configured';
		}
	}
	return 'unconfigured';
}

/**
 * chrome-devtools系エントリが `--browser-url` / `--browserUrl` で `http://127.0.0.1:<port>` を
 * 固定参照している場合の、そのポートを返す（見つからなければ undefined）。
 */
function detectChromeDevtoolsBrowserUrlPort(code: string): number | undefined {
	if (!/chrome-devtools/i.test(code)) {
		return undefined;
	}
	// --browser-url / --browserUrl（ハイフン有無・大文字小文字を許容）。
	if (!/--browser-?url/i.test(code)) {
		return undefined;
	}
	const match = /127\.0\.0\.1:(\d{1,5})/.exec(code);
	if (match === null) {
		return undefined;
	}
	const port = Number(match[1]);
	return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

interface IServerTable {
	readonly name: string;
	/** テーブル本体のコメント除去済みコード（判定用）。 */
	code: string;
	/** 生テキスト内でのヘッダー行インデックス（書き換え用）。 */
	readonly headerLine: number;
	/** テーブル本体の最終行インデックス（inclusive、書き換え用）。 */
	endLine: number;
}

/**
 * config.toml を走査して `[mcp_servers.<name>]` テーブルの一覧（本体コード + 行範囲）を返す。
 * 曖昧なテーブル配列 `[[mcp_servers...]]` やdotted-key代入は「mcp_serversテーブルではない」として扱い、
 * 判定は保守的に unconfigured 側へ倒れる（既存の inspectParadisMcpTomlSection と同じ思想）。
 */
function collectCodexServerTables(lines: readonly string[]): IServerTable[] {
	const tables: IServerTable[] = [];
	let current: IServerTable | undefined;
	let multiline: MultilineDelimiter | undefined;
	for (let index = 0; index < lines.length; index++) {
		const scanned = scanTomlLine(lines[index], multiline);
		const insideMultiline = multiline !== undefined;
		multiline = scanned.multiline;
		const code = scanned.code;
		const trimmed = code.trim();
		if (trimmed.length === 0) {
			continue;
		}
		// マルチライン文字列の継続行はテーブルヘッダーになり得ない（本体の一部）。
		if (!insideMultiline && (trimmed.startsWith('[[') || trimmed.startsWith('['))) {
			current = undefined;
			if (trimmed.startsWith('[[')) {
				continue;
			}
			const close = trimmed.lastIndexOf(']');
			if (close <= 0 || trimmed.slice(close + 1).trim().length > 0) {
				continue;
			}
			const path = parseTomlKeyPath(trimmed.slice(1, close));
			if (path !== undefined && path.length === 2 && path[0] === 'mcp_servers') {
				current = { name: path[1], code: '', headerLine: index, endLine: index };
				tables.push(current);
			}
			continue;
		}
		if (current !== undefined) {
			current.code += code + '\n';
			current.endLine = index;
		}
	}
	return tables;
}

/**
 * Codex config.toml のMCP設定状態を判定する。
 * (a) shim方式の para-browser があれば configured
 * (b) chrome-devtools系が古いポートを固定参照していれば（現行ゲートウェイポートと不一致）needsFix
 * (c) どちらも無ければ unconfigured
 */
export function inspectParadisCodexMcpToml(text: string, gatewayPort: number | undefined): IParadisCodexMcpConfigInspection {
	const tables = collectCodexServerTables(text.split(/\r?\n/));
	// stale（要修正）検出を shim 検出より先に回す。複数 chrome-devtools エントリのうち1つを
	// shim へ書き換えた後でも、残った stale が shim エントリの陰に隠れて見逃されないようにする
	// （stale が1つでも残っていれば configured にせず needsFix を返す）。
	for (const table of tables) {
		const port = detectChromeDevtoolsBrowserUrlPort(table.code);
		if (port !== undefined && gatewayPort !== undefined && port !== gatewayPort) {
			return { state: 'needsFix', detectedPort: port, staleServerName: table.name };
		}
	}
	for (const table of tables) {
		if (table.code.includes(PARADIS_MCP_SHIM_MARKER)) {
			return { state: 'configured' };
		}
	}
	return { state: 'unconfigured' };
}

/** shim方式テーブル本体（ヘッダー除く）を生成する。 */
function paradisCodexShimTableBody(shimPath: string, tokenEnvVar: string, portFileEnvVar: string): string {
	return [
		'command = "node"',
		`args = [${encodeParadisTomlBasicString(shimPath)}]`,
		`env_vars = [${encodeParadisTomlBasicString(tokenEnvVar)}, ${encodeParadisTomlBasicString(portFileEnvVar)}]`,
	].join('\n');
}

/**
 * 指定した `[mcp_servers.<staleServerName>]` テーブルを shim方式へ書き換えた全文を返す。
 * 対象テーブルが一意に特定できない場合は undefined（呼び出し側は fail closed する）。
 * テーブル外の内容（他のサーバー・コメント・書式）は保持する。
 */
export function computeParadisCodexShimRewrite(
	text: string,
	staleServerName: string,
	shimPath: string,
	tokenEnvVar: string,
	portFileEnvVar: string,
): string | undefined {
	const usesCrlf = /\r\n/.test(text);
	const eol = usesCrlf ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const tables = collectCodexServerTables(lines);
	const matches = tables.filter(table => table.name === staleServerName);
	if (matches.length !== 1) {
		return undefined;
	}
	const table = matches[0];
	const headerLine = lines[table.headerLine];
	const body = paradisCodexShimTableBody(shimPath, tokenEnvVar, portFileEnvVar);
	const replacement = [headerLine, ...body.split('\n')];
	const next = [
		...lines.slice(0, table.headerLine),
		...replacement,
		...lines.slice(table.endLine + 1),
	];
	return next.join(eol);
}
