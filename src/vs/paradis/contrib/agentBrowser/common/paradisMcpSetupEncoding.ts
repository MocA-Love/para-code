/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH comments)

// PARA-CODE: MCPセットアップの自動設定と手動スニペットで共有する、注入耐性のあるpure encoder。

import { PARADIS_PANE_TOKEN_ENV_VAR } from './paradisAgentBrowser.js';
import { findTomlAssignment, MultilineDelimiter, parseTomlKeyPath, scanTomlLine, scanTomlLines } from './paradisTomlScan.js';

// 以前からここから読んでいる所のために、切り出した道具をそのまま出し直す
export { findTomlAssignment, parseTomlKeyPath, scanTomlLine } from './paradisTomlScan.js';
export type { ICommentScanResult, MultilineDelimiter } from './paradisTomlScan.js';

export type ParadisMcpTomlSectionInspection = 'present' | 'absent' | 'ambiguous';

/** TOML basic string。制御文字をrawで残さず、非scalarなlone surrogateは拒否する。 */
export function encodeParadisTomlBasicString(value: string): string {
	let result = '"';
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xD800 && code <= 0xDBFF) {
			const low = value.charCodeAt(index + 1);
			if (!Number.isFinite(low) || low < 0xDC00 || low > 0xDFFF) {
				throw new Error('TOML string contains an unpaired surrogate');
			}
			result += value[index] + value[index + 1];
			index++;
			continue;
		}
		if (code >= 0xDC00 && code <= 0xDFFF) {
			throw new Error('TOML string contains an unpaired surrogate');
		}
		switch (code) {
			case 0x08: result += '\\b'; break;
			case 0x09: result += '\\t'; break;
			case 0x0A: result += '\\n'; break;
			case 0x0C: result += '\\f'; break;
			case 0x0D: result += '\\r'; break;
			case 0x22: result += '\\"'; break;
			case 0x5C: result += '\\\\'; break;
			default:
				if (code <= 0x1F || code === 0x7F) {
					result += `\\u${code.toString(16).padStart(4, '0')}`;
				} else {
					result += value[index];
				}
		}
	}
	return `${result}"`;
}

/** POSIX shellへ貼る手動スニペット用。値全体を1つのliteral argvに固定する。 */
export function encodeParadisPosixShellArgument(value: string): string {
	if (value.includes('\0')) {
		throw new Error('Shell argument contains NUL');
	}
	const quote = String.fromCharCode(0x27);
	return `${quote}${value.replaceAll(quote, `${quote}\\${quote}${quote}`)}${quote}`;
}

/** PowerShell single-quoted string。cmd.exe用ではない。 */
export function encodeParadisPowerShellArgument(value: string): string {
	if (value.includes('\0')) {
		throw new Error('PowerShell argument contains NUL');
	}
	const quote = String.fromCharCode(0x27);
	return `${quote}${value.replaceAll(quote, `${quote}${quote}`)}${quote}`;
}

function couldDefineMcpServers(code: string): boolean {
	return /(^|[\[\s])mcp_servers(?:\s|\.|=|\]|$)/.test(code);
}

/**
 * para-browser tableが既にあるかを安全側に分類する。TOML全体を再実装せず、
 * mcp_serversに触れる曖昧な構文では自動追記を停止する。
 */
export function inspectParadisMcpTomlSection(source: string): ParadisMcpTomlSectionInspection {
	let multiline: MultilineDelimiter | undefined;
	const lines = source.split(/\r?\n/);
	// 複数行の配列の中の行（`[` で始まる要素）を見出しと取り違えない
	const infos = scanTomlLines(lines);
	for (let index = 0; index < lines.length; index++) {
		const scanned = scanTomlLine(lines[index], multiline);
		multiline = scanned.multiline;
		const code = scanned.code.trim();
		if (code.length === 0 || infos[index].continued) {
			continue;
		}
		if (code.startsWith('[[')) {
			if (!code.endsWith(']]')) {
				return 'ambiguous';
			}
			const path = parseTomlKeyPath(code.slice(2, -2));
			if (path === undefined || path[0] === 'mcp_servers') {
				return 'ambiguous';
			}
			continue;
		}
		if (code.startsWith('[')) {
			const close = code.lastIndexOf(']');
			if (close <= 0 || code.slice(close + 1).trim().length > 0) {
				return 'ambiguous';
			}
			const path = parseTomlKeyPath(code.slice(1, close));
			if (path?.[0] !== 'mcp_servers') {
				if (path === undefined) {
					return 'ambiguous';
				}
				continue;
			}
			if (path.length === 2 && path[1] === 'para-browser') {
				return 'present';
			}
			return 'ambiguous';
		}
		const assignment = findTomlAssignment(code);
		const assignmentPath = assignment >= 0 ? parseTomlKeyPath(code.slice(0, assignment)) : undefined;
		if (assignmentPath?.[0] === 'mcp_servers'
			|| (assignmentPath === undefined && (couldDefineMcpServers(code) || /["']mcp_servers["']/.test(code)))) {
			return 'ambiguous';
		}
	}
	return multiline === undefined ? 'absent' : 'ambiguous';
}

/** 私たちが所有する MCP サーバー名。判定・書き換えの対象をこの名前に限る。 */
export const PARADIS_MCP_SERVER_NAME = 'para-browser';

/** para-browser MCP サーバーのURL。手元でも接続先でも 127.0.0.1 の同じ番号を叩く。 */
export function paradisMcpServerUrl(port: number): string {
	return `http://127.0.0.1:${port}/`;
}

/**
 * para-browser のツール呼び出しを待つ上限（ミリ秒）。Claude Code の HTTP MCP は既定で 60 秒で打ち切る
 * （performance trace・lighthouse・長い wait_for が途中で切れていた）。Para Code 側の上限
 * （paradisDevtoolsMcpProxy.ts の CALL_TIMEOUT_MS）と揃える。
 */
export const PARADIS_MCP_TOOL_TIMEOUT_MS = 300_000;

/** Codex の `tool_timeout_sec`（既定 60 秒）に書く値。 */
export const PARADIS_CODEX_MCP_TOOL_TIMEOUT_SEC = PARADIS_MCP_TOOL_TIMEOUT_MS / 1000;

/**
 * Codex の `supports_parallel_tool_calls` に書く値。無い（既定 false）と、Codex は MCP サーバーの呼び出しを
 * 1 本ずつ流す（codex-rs/core/src/tools/parallel.rs、0.162.0）。para-browser は同じタブへの呼び出しを
 * サーバー側で 1 本ずつに並べる（paradisToolCallLanes.ts）ので、別のタブへの呼び出しだけが並行に走る。
 */
export const PARADIS_CODEX_MCP_SUPPORTS_PARALLEL_TOOL_CALLS = true;

/**
 * Codex の `[mcp_servers.para-browser]` に Para Code が書く、url と認証以外の行（キーと値の TOML 表記）。
 * 書いた後の版で足した行は、セットアップ済みの人の節へ起動時に 1 行ずつ足す（paradisAddCodexMissingTableLines）。
 */
export const PARADIS_CODEX_MCP_MANAGED_LINES: readonly { readonly key: string; readonly value: string }[] = [
	{ key: 'tool_timeout_sec', value: String(PARADIS_CODEX_MCP_TOOL_TIMEOUT_SEC) },
	{ key: 'supports_parallel_tool_calls', value: String(PARADIS_CODEX_MCP_SUPPORTS_PARALLEL_TOOL_CALLS) },
];

/**
 * Codex の `[mcp_servers.para-browser]` の中身（ヘッダー行を除く）。
 *
 * トークンはペインごとに違うので値は焼き込まず、環境変数の名前だけを渡す
 * （`bearer_token_env_var`。Codex が起動時にその変数を読んで Bearer に載せる）。
 */
export function paradisCodexMcpTableBody(port: number): string {
	return [
		`url = ${encodeParadisTomlBasicString(paradisMcpServerUrl(port))}`,
		`bearer_token_env_var = ${encodeParadisTomlBasicString(PARADIS_PANE_TOKEN_ENV_VAR)}`,
		...PARADIS_CODEX_MCP_MANAGED_LINES.map(line => `${line.key} = ${line.value}`),
	].join('\n');
}

/**
 * Claude Code の `mcpServers['para-browser']` の中身。`timeout` はツール呼び出し 1 回の上限
 * （無いと Claude Code が 60 秒で打ち切る）。
 */
export function paradisClaudeMcpServerEntry(port: number): { readonly type: 'http'; readonly url: string; readonly headers: { readonly Authorization: string }; readonly timeout: number } {
	return {
		type: 'http',
		url: paradisMcpServerUrl(port),
		headers: { Authorization: `Bearer \${${PARADIS_PANE_TOKEN_ENV_VAR}}` },
		timeout: PARADIS_MCP_TOOL_TIMEOUT_MS,
	};
}

/**
 * Claude Code の `mcpServers['para-browser']` を、既存の設定を保ったまま HTTP 方式へ差し替える。
 *
 * `${…}` のまま書くのは Claude Code が起動時に自分の環境変数で展開するため。ペインごとに違う
 * トークンを、設定ファイルへ焼き込まずに渡せる唯一の手段になっている。
 *
 * @returns 書き戻すべきJSON。読めない・オブジェクトでない場合は undefined（呼び出し側は諦める）。
 */
export function paradisUpsertClaudeMcpJson(existingRaw: string | undefined, port: number): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(existingRaw === undefined || existingRaw.length === 0 ? '{}' : existingRaw);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const config = parsed as Record<string, unknown>;
	const existingServers = config.mcpServers;
	const servers: Record<string, unknown> = existingServers !== null && typeof existingServers === 'object' && !Array.isArray(existingServers)
		? { ...existingServers as Record<string, unknown> }
		: {};
	servers[PARADIS_MCP_SERVER_NAME] = paradisClaudeMcpServerEntry(port);
	return JSON.stringify({ ...config, mcpServers: servers }, undefined, 2) + '\n';
}

/**
 * 接続先の Codex へ para-browser を HTTP の MCP サーバーとして登録した config.toml を返す。
 *
 * 既に `[mcp_servers.para-browser]` があれば節ごと差し替える。設定を別のマシンから移すと、
 * 手元のシムの絶対パスを指した節がそのまま残り、接続先には無いファイルを起動しようとして
 * 静かに失敗する。中身を見て直すより、私たちの節は毎回書き直す方が確実。
 *
 * トークンはペインごとに違うので値は焼き込まず、環境変数の名前だけを渡す
 * （`bearer_token_env_var`。Codex が起動時にその変数を読んで Bearer に載せる）。
 *
 * @returns 書き戻すべき中身。変更が要らなければ元のまま返す。
 */
export function paradisUpsertCodexMcpToml(source: string, port: number): string {
	const section = [
		`[mcp_servers.${PARADIS_MCP_SERVER_NAME}]`,
		paradisCodexMcpTableBody(port),
	].join('\n');

	const lines = source.split('\n');
	// 見出しは文字列・配列の外の行だけで探す（複数行の文字列の中の `[mcp_servers.para-browser]` を節と取り違えない）。
	// 空白やコメントを挟んだ書き方は差し替えず、下の inspect で「既にある」と扱う
	const infos = scanTomlLines(lines);
	const header = /^\s*\[mcp_servers\.(?:para-browser|"para-browser"|'para-browser')\]\s*$/;
	const start = lines.findIndex((line, index) => !infos[index].continued && header.test(line));
	if (start < 0) {
		// 見出しが見つからないのに節は在る、という書き方がある（`[ mcp_servers . "para-browser" ]`
		// のように空白やコメントを挟んだもの）。ここで足すと同じテーブルを二重に定義してしまい、
		// Codex は設定ごと読めなくなる。触らずに返し、呼び出し側に「既にある」と扱わせる。
		if (inspectParadisMcpTomlSection(source) !== 'absent') {
			return source;
		}
		const prefix = source.length === 0 ? '' : source.endsWith('\n\n') ? source : source.endsWith('\n') ? `${source}\n` : `${source}\n\n`;
		return `${prefix}${section}\n`;
	}
	// 次のテーブルが始まる手前までが、この節の中身
	let end = start + 1;
	while (end < lines.length && infos[end].header === undefined) {
		end++;
	}
	// 次のテーブルとの間に置かれていた空行は本文ではなく区切りなので残す。
	// 巻き込むと、当てるたびに空行が1つずつ減って結果が変わってしまう
	while (end - 1 > start && lines[end - 1].trim().length === 0) {
		end--;
	}
	// 節の直前にあった空行は残す（区切りが潰れると読みにくい）
	const replaced = [...lines.slice(0, start), ...section.split('\n'), ...lines.slice(end)];
	return replaced.join('\n');
}
