/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// バインディングダイアログ「MCP接続設定」タブのステータス判定と、Codex要修正エントリの
// HTTP方式への書き換えを行うpureなパーサ群。node層に依存しないので、shared processの
// ParadisMcpSetupController（node/paradisMcpSetup.ts、node/paradisMcpConfigStatus.js経由の
// 再exportで引き続き参照できる）だけでなく、SSH接続先向けの electron-browser 側
// （paradisRemoteMcpSetup.ts）からも layer違反なく直接importできる。
// TOMLは全実装せず、既存の注入耐性スキャナ（paradisMcpSetupEncoding）を再利用して安全側に倒す。

import { PARADIS_PANE_TOKEN_ENV_VAR, ParadisMcpConfigState } from './paradisAgentBrowser.js';
import { IParadisAntigravityMcpServerEntry, MultilineDelimiter, PARADIS_CODEX_MCP_MANAGED_LINES, PARADIS_MCP_SERVER_NAME, findTomlAssignment, parseTomlKeyPath, scanTomlLine } from './paradisMcpSetupEncoding.js';
import { scanTomlLines } from './paradisTomlScan.js';
import { isRecord } from '../../../common/paradisGuards.js';

/** stdioシムのファイル名断片。設定値がこれを含めば para-browser（旧shim方式）とみなす。 */
export const PARADIS_MCP_SHIM_MARKER = 'paradisBrowserMcpShim';

/**
 * 設定に書かれた para-browser の宛先ポート。HTTP方式のURLからだけ読む。
 *
 * shim方式にはURLが無い（シムがポートファイルを毎回読み直す）ので undefined になる。
 * それで正しい: shim方式はポートが変わっても壊れないため、古いポート判定の対象外。
 */
function detectParadisMcpUrlPort(value: string): number | undefined {
	const match = /^https?:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(value.trim());
	if (match === null) {
		return undefined;
	}
	const port = Number(match[1]);
	return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/** Codex config.toml のMCP設定判定結果。 */
export interface IParadisCodexMcpConfigInspection {
	readonly state: ParadisMcpConfigState;
	/** needsFix時に検出した、決め打ちされた古いポート。 */
	readonly detectedPort?: number;
	/** needsFix時に修正対象となる `[mcp_servers.<name>]` のサーバー名。 */
	readonly staleServerName?: string;
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

/** MCPサーバー1エントリのHTTP方式URLに書かれたポート（HTTP方式でなければ undefined）。 */
function claudeEntryUrlPort(entry: unknown): number | undefined {
	if (!isRecord(entry) || typeof entry.url !== 'string') {
		return undefined;
	}
	return detectParadisMcpUrlPort(entry.url);
}

/**
 * `~/.claude.json` のトップレベル `mcpServers` に para-browser エントリがあるか判定する。
 * HTTP方式（現行）とshim方式（旧・現在も動作する）の両方を設定済みとみなす。
 * HTTP方式のURLが今のポートと食い違っていれば needsFix（ワンクリック修正の対象）。
 * JSONが壊れている・形が想定外なら unconfigured を返す（失敗ではなく未設定として扱う）。
 */
export function inspectParadisClaudeMcpJson(text: string, gatewayPort: number | undefined): ParadisMcpConfigState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return 'unconfigured';
	}
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		return 'unconfigured';
	}
	// 見るのは私たちのエントリだけ。名前を見ずに走査すると、ユーザーが持っている無関係な
	// 127.0.0.1 の HTTP MCP を「古いポートの para-browser」と読んでしまい、修正しても
	// 私たちのエントリを足すだけなので needsFix が永久に消えなくなる。
	const entry = parsed.mcpServers[PARADIS_MCP_SERVER_NAME];
	const port = claudeEntryUrlPort(entry);
	if (port !== undefined) {
		return gatewayPort !== undefined && port !== gatewayPort ? 'needsFix' : 'configured';
	}
	return claudeEntryReferencesShim(entry) ? 'configured' : 'unconfigured';
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
 * この節の中身が私たちのものか。名前は当てにならない（chrome-devtools の節を書き換える経路が
 * あり、そこでは相手の名前のまま中身だけ私たちのものになる）ので、ペイントークンを載せる
 * 指定があるかで見る。
 */
function isParadisMcpTableBody(code: string): boolean {
	return code.includes(PARADIS_PANE_TOKEN_ENV_VAR) || code.includes(PARADIS_MCP_SHIM_MARKER);
}

/** テーブル本体の `url = "http://127.0.0.1:<port>/"` に書かれたポート。 */
function detectCodexTableUrlPort(code: string): number | undefined {
	const match = /(^|\n)\s*url\s*=\s*"([^"\n]*)"/.exec(code);
	return match === null ? undefined : detectParadisMcpUrlPort(match[2]);
}

/**
 * Codex config.toml のMCP設定状態を判定する。
 * (a) HTTP方式（現行）またはshim方式（旧・現在も動作する）の para-browser があれば configured
 * (b) 古いポートを固定参照していれば（現行ゲートウェイポートと不一致）needsFix。
 *     対象は chrome-devtools系の `--browser-url` と、私たちのHTTP方式の `url` の両方
 * (c) どれも無ければ unconfigured
 */
export function inspectParadisCodexMcpToml(text: string, gatewayPort: number | undefined): IParadisCodexMcpConfigInspection {
	const tables = collectCodexServerTables(text.split(/\r?\n/));
	// stale（要修正）検出を configured 検出より先に回す。複数 chrome-devtools エントリのうち1つを
	// 書き換えた後でも、残った stale が正しいエントリの陰に隠れて見逃されないようにする
	// （stale が1つでも残っていれば configured にせず needsFix を返す）。
	for (const table of tables) {
		// URL によるポート判定は私たちの節にだけ掛ける。テーブル名を見ずに掛けると、ユーザーが
		// 持っている無関係な HTTP の MCP サーバー（127.0.0.1 の別ポート）が「古いポートを指した
		// para-browser」と読まれ、ワンクリック修正がその節を丸ごと私たちの中身へ置き換えてしまう。
		// chrome-devtools の `--browser-url` 判定は従来どおり名前に依らず掛ける（あちらは
		// このゲートウェイを指すことが分かっている引数を見ているため）。
		const port = detectChromeDevtoolsBrowserUrlPort(table.code)
			?? (table.name === PARADIS_MCP_SERVER_NAME || isParadisMcpTableBody(table.code) ? detectCodexTableUrlPort(table.code) : undefined);
		if (port !== undefined && gatewayPort !== undefined && port !== gatewayPort) {
			return { state: 'needsFix', detectedPort: port, staleServerName: table.name };
		}
	}
	for (const table of tables) {
		// 設定済み判定は読むだけなので、名前だけでなく中身でも見る。chrome-devtools の節を
		// 私たちの中身へ書き換える経路があり、そこを通ると「名前は相手のまま中身は私たち」
		// という節ができる。名前だけで絞ると、それを未設定と読んで再セットアップを促してしまう。
		const isOurs = table.name === PARADIS_MCP_SERVER_NAME || isParadisMcpTableBody(table.code);
		if (isOurs && (detectCodexTableUrlPort(table.code) !== undefined || table.code.includes(PARADIS_MCP_SHIM_MARKER))) {
			return { state: 'configured' };
		}
	}
	return { state: 'unconfigured' };
}

/**
 * 指定した `[mcp_servers.<staleServerName>]` テーブルの中身を差し替えた全文を返す。
 * 対象テーブルが一意に特定できない場合は undefined（呼び出し側は fail closed する）。
 * テーブル外の内容（他のサーバー・コメント・書式）は保持する。
 */
export function computeParadisCodexTableRewrite(
	text: string,
	staleServerName: string,
	body: string,
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
	const replacement = [headerLine, ...body.split('\n')];
	const next = [
		...lines.slice(0, table.headerLine),
		...replacement,
		...lines.slice(table.endLine + 1),
	];
	return next.join(eol);
}

/**
 * `~/.claude.json` の para-browser のエントリ。数十 MiB になりうるので、先に文字列で名前を確かめてから
 * parse する（含まれなければ parse しない）。
 */
export function paradisReadClaudeMcpEntry(text: string): Record<string, unknown> | undefined {
	if (!text.includes(`"${PARADIS_MCP_SERVER_NAME}"`)) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		return undefined;
	}
	const entry = parsed.mcpServers[PARADIS_MCP_SERVER_NAME];
	return isRecord(entry) ? entry : undefined;
}

/**
 * `~/.claude.json` の para-browser が今のポートを指した HTTP 方式なのに、ツール呼び出しの上限（`timeout`）が
 * 無いか。そうなら登録を入れ直す（無いと Claude Code が 60 秒で打ち切る）。利用者が自分で書いた `timeout` は
 * 短くても触らない。古いポートや shim 方式は対象外（前者はワンクリック修正、後者はそのまま動く）。
 */
export function paradisClaudeMcpEntryNeedsToolTimeout(text: string, gatewayPort: number): boolean {
	// parse の前に、名前と今のポートが文字列として含まれるかを見る（含まれなければ入れ直す対象ではない）。
	if (!text.includes(`127.0.0.1:${gatewayPort}`)) {
		return false;
	}
	const entry = paradisReadClaudeMcpEntry(text);
	return entry !== undefined && claudeEntryUrlPort(entry) === gatewayPort && entry.timeout === undefined;
}

/**
 * Codex の `[mcp_servers.para-browser]` が今のポートを指しているのに、Para Code が書く行
 * （{@link PARADIS_CODEX_MCP_MANAGED_LINES}）のどれかが無いか。他の名前の節（chrome-devtools を書き換えたもの）は触らない。
 */
export function paradisCodexMcpTableNeedsManagedLines(text: string, gatewayPort: number): boolean {
	return codexMissingLinesTarget(text, gatewayPort) !== undefined;
}

function codexMissingLinesTarget(text: string, gatewayPort: number): { readonly table: IServerTable; readonly missing: readonly { readonly key: string; readonly value: string }[] } | undefined {
	const tables = collectCodexServerTables(text.split(/\r?\n/)).filter(table => table.name === PARADIS_MCP_SERVER_NAME);
	if (tables.length !== 1 || detectCodexTableUrlPort(tables[0].code) !== gatewayPort) {
		return undefined;
	}
	const states = PARADIS_CODEX_MCP_MANAGED_LINES.map(line => ({ line, state: codexTableKeyState(text, line.key) }));
	// どれかのキーが「あるか分からない」なら何も足さない（足すとキーが重複して TOML が壊れうる）。
	if (states.some(entry => entry.state === 'ambiguous')) {
		return undefined;
	}
	const missing = states.filter(entry => entry.state === 'absent').map(entry => entry.line);
	if (missing.length === 0) {
		return undefined;
	}
	// 節の中に複数行文字列があると、節の終わり（行を足す場所）を行単位で正しく決められない。触らない。
	const lines = text.split(/\r?\n/).slice(tables[0].headerLine, tables[0].endLine + 1);
	if (lines.some(line => line.includes('"""') || line.includes('\x27\x27\x27'))) {
		return undefined;
	}
	return { table: tables[0], missing };
}

/** キー（の候補）に `\u` / `\U` のエスケープがあるか。 */
function hasUnicodeEscape(keyText: string): boolean {
	return /\\[uU]/.test(keyText);
}

/**
 * `mcp_servers.para-browser.<key>` が既に定義されているか。キーは各行の左辺を `parseTomlKeyPath`
 * で解釈し、属する節のパスとつないで見る（節の中の `"<key>"`、`[mcp_servers]` の中の
 * `para-browser.<key>`、節の外の `mcp_servers.para-browser.<key>` のどれでも見つける）。
 * `<key>` を含むのに解釈できない行があれば 'ambiguous'（足すとキーが重複して TOML が壊れうるので
 * 足さない側に倒す）。
 */
function codexTableKeyState(text: string, key: string): 'present' | 'absent' | 'ambiguous' {
	const expected: readonly string[] = ['mcp_servers', PARADIS_MCP_SERVER_NAME, key];
	let tablePath: readonly string[] | undefined = [];
	let multiline: MultilineDelimiter | undefined;
	let state: 'present' | 'absent' | 'ambiguous' = 'absent';
	for (const line of text.split(/\r?\n/)) {
		const insideMultiline = multiline !== undefined;
		const scanned = scanTomlLine(line, multiline);
		multiline = scanned.multiline;
		const trimmed = scanned.code.trim();
		if (insideMultiline || trimmed.length === 0) {
			continue;
		}
		if (trimmed.startsWith('[')) {
			// `[[…]]`（テーブル配列）の中のキーは para-browser の節のものではない。
			if (trimmed.startsWith('[[')) {
				tablePath = undefined;
				continue;
			}
			const close = trimmed.lastIndexOf(']');
			tablePath = close > 0 ? parseTomlKeyPath(trimmed.slice(1, close)) : undefined;
			if ((tablePath === undefined && trimmed.includes(key)) || hasUnicodeEscape(trimmed)) {
				state = 'ambiguous';
			}
			continue;
		}
		const assignment = findTomlAssignment(trimmed);
		const keyText = assignment > 0 ? trimmed.slice(0, assignment) : undefined;
		// 引用符付きのキーの `\u` / `\U` は、文字列として探しても見つからない形で同じキーを書ける
		// （"tool\u005Ftimeout_sec"）。どのキーか確かめないまま足すと重複しうるので足さない。
		if (keyText !== undefined && hasUnicodeEscape(keyText)) {
			state = 'ambiguous';
			continue;
		}
		if (!trimmed.includes(key)) {
			continue;
		}
		const keyPath = keyText !== undefined ? parseTomlKeyPath(keyText) : undefined;
		if (keyPath === undefined || tablePath === undefined) {
			// インラインテーブル・配列の続きの行・解釈できない左辺。どこに効くか分からない。
			if (state === 'absent') {
				state = 'ambiguous';
			}
			continue;
		}
		const fullPath = [...tablePath, ...keyPath];
		if (fullPath.length === expected.length && fullPath.every((part, index) => part === expected[index])) {
			state = 'present';
		}
	}
	return state;
}

/**
 * `[mcp_servers.para-browser]` の最後の行の後ろへ、Para Code が書く行のうち無いもの（`tool_timeout_sec = <秒>`、
 * `supports_parallel_tool_calls = true`）だけを足す。節の他の行（利用者が足した `enabled = false` や、
 * 利用者が自分で書いた `supports_parallel_tool_calls = false`）はそのまま残す。足す対象でなければ undefined。
 * `keys` は足した行のキー（起動時の入れ直しを 1 回だけにする印に使う）。
 */
export function paradisAddCodexMissingTableLines(text: string, gatewayPort: number): { readonly text: string; readonly keys: readonly string[] } | undefined {
	const target = codexMissingLinesTarget(text, gatewayPort);
	if (target === undefined) {
		return undefined;
	}
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	lines.splice(target.table.endLine + 1, 0, ...target.missing.map(line => `${line.key} = ${line.value}`));
	return { text: lines.join(eol), keys: target.missing.map(line => line.key) };
}

/** パスが `prefix` で始まるか。 */
function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
	return path.length >= prefix.length && prefix.every((part, index) => path[index] === part);
}

/**
 * Para Code の道具 1 つ（`ask_human` など）を、Codex で許可なしに使えるようにする（Codex のメニューの
 * Always allow と同じ形の表を末尾へ足す）。
 *
 *   [mcp_servers.para-browser.tools.<tool>]
 *   approval_mode = "approve"
 *
 * 足すのは、`[mcp_servers.para-browser]` が 1 つだけあり、それが今の Para Code（`gatewayPort`）を指すときだけ。
 * 次のときは何も書かない（undefined）:
 * - その道具の表が既にある（中身が何でも。利用者が `approval_mode = "prompt"` にしていればそれに従う）
 * - para-browser の `tools` をドット付きのキー・インラインテーブル・`[mcp_servers.para-browser.tools]` で書いている
 *   （同じ表を二重に定義すると Codex は設定ごと読めなくなる）
 * - 読めない見出し・行が para-browser か tools に触れている、ファイルが複数行の文字列・配列の中で終わる
 * ほかの道具の表と、ほかの行は 1 文字も変えない。
 */
export function paradisAddCodexToolApproval(text: string, gatewayPort: number, tool: string): string | undefined {
	const tables = collectCodexServerTables(text.split(/\r?\n/)).filter(table => table.name === PARADIS_MCP_SERVER_NAME);
	if (tables.length !== 1 || detectCodexTableUrlPort(tables[0].code) !== gatewayPort || !/^[A-Za-z0-9_-]+$/.test(tool)) {
		return undefined;
	}
	const toolsPath = ['mcp_servers', PARADIS_MCP_SERVER_NAME, 'tools'];
	const lines = text.split(/\r?\n/);
	const infos = scanTomlLines(lines);
	let table: readonly string[] | undefined = [];
	for (let index = 0; index < lines.length; index++) {
		const info = infos[index];
		if (info.continued) {
			continue;
		}
		if (info.header !== undefined) {
			const path = info.header.path;
			if (path === undefined) {
				if (/mcp_servers|para-browser|tools/.test(lines[index])) {
					return undefined;
				}
				table = undefined;
				continue;
			}
			if (startsWithPath(path, toolsPath) && (path.length === toolsPath.length || path[toolsPath.length] === tool || info.header.array)) {
				return undefined;
			}
			table = info.header.array ? undefined : path;
			continue;
		}
		if (info.key !== undefined) {
			// ドット付きのキー・インラインテーブルで tools か tools.<道具> を書いている（ほかの道具の表の中の行は除く）。
			// 配列の表（`[[...]]`）の中のキーは para-browser を定義できない
			if (table !== undefined && startsWithPath([...table, ...info.key], toolsPath) && !(table.length > toolsPath.length && startsWithPath(table, toolsPath))) {
				return undefined;
			}
			continue;
		}
		const code = lines[index].trim();
		if (code.length > 0 && !code.startsWith('#') && /mcp_servers|para-browser|tools/.test(code)) {
			return undefined;
		}
	}
	if (infos.length > 0 && infos[infos.length - 1].continued) {
		return undefined;
	}
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const kept = [...lines];
	while (kept.length > 0 && kept[kept.length - 1].trim().length === 0) {
		kept.pop();
	}
	return [...kept, '', `[mcp_servers.${PARADIS_MCP_SERVER_NAME}.tools.${tool}]`, 'approval_mode = "approve"', ''].join(eol);
}

/** Antigravity CLI の mcp_config.json の判定結果。 */
export interface IParadisAntigravityMcpConfigInspection {
	readonly state: ParadisMcpConfigState;
	/** 読めない・形が想定外で、自動セットアップでは書けない（手で直してもらう）。 */
	readonly manualOnly?: true;
}

/** 2 つの JSON の値が同じか（キーの順は見ない）。 */
function sameJsonValue(left: unknown, right: unknown): boolean {
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left);
		return leftKeys.length === Object.keys(right).length && leftKeys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
	}
	return left === right;
}

/**
 * エントリのうち橋渡しの起動に関わるキー（`command`・`args`・`env`）だけを取り出したもの（中身の比較に使う）。
 * 利用者や agy が足すほかのキー（`disabled`・`disabledTools`・`timeout` など）は比べない。
 */
function antigravityBridgeKeys(entry: Record<string, unknown>): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of ['command', 'args', 'env']) {
		if (entry[key] !== undefined) {
			picked[key] = entry[key];
		}
	}
	return picked;
}

/**
 * Antigravity CLI の `~/.gemini/config/mcp_config.json` の para-browser を判定する。
 *
 * - configured: Para Code の stdio の橋渡しが、今の Para Code の場所を指している（`disabled: true` のものは除く）
 * - needsFix: para-browser はあるが動かない形。手で書いた HTTP の形（agy は `headers` の `${VAR}` を展開しないので
 *   トークンが届かない）、前の場所の Para Code を指す橋渡し（アプリを移した・入れ直した）、そのほかの中身
 * - unconfigured: para-browser が無い、または agy の `/mcp` で止めてある
 *
 * @param expected 今の Para Code での中身（{@link paradisAntigravityMcpServerEntry}）。
 */
export function inspectParadisAntigravityMcpJson(text: string, expected: IParadisAntigravityMcpServerEntry): IParadisAntigravityMcpConfigInspection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim().length === 0 ? '{}' : text);
	} catch {
		return { state: 'unconfigured', manualOnly: true };
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		return { state: 'unconfigured', manualOnly: true };
	}
	const entry = isRecord(parsed.mcpServers) ? parsed.mcpServers[PARADIS_MCP_SERVER_NAME] : undefined;
	if (entry === undefined) {
		return { state: 'unconfigured' };
	}
	if (!isRecord(entry)) {
		return { state: 'needsFix' };
	}
	if (!sameJsonValue(antigravityBridgeKeys(entry), expected)) {
		return { state: 'needsFix' };
	}
	return { state: entry.disabled === true ? 'unconfigured' : 'configured' };
}

/**
 * 起動時に場所だけ直す候補の para-browser（Para Code が前に書いた橋渡しで、今の場所と違う）が指しているパス
 * （実行ファイルとシム）。候補でなければ undefined。利用者が手で書いた HTTP の形などは候補にしない（ボタンを
 * 押したときだけ置き換える）。直すかどうかは、呼び出し側がこのパスが残っているかで決める。
 */
export function paradisAntigravityMcpEntryToRelocate(text: string, expected: IParadisAntigravityMcpServerEntry): readonly string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const entry = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers[PARADIS_MCP_SERVER_NAME] : undefined;
	if (!isRecord(entry) || !claudeEntryReferencesShim(entry) || sameJsonValue(antigravityBridgeKeys(entry), expected)) {
		return undefined;
	}
	const values = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
	// `/usr/bin/env` と `ELECTRON_RUN_AS_NODE=1` は場所ではないので見ない
	return values.filter((value): value is string => typeof value === 'string' && value !== '/usr/bin/env' && !/^[A-Z_]+=/.test(value) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)));
}
