/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 許可のカードに出す、操作の中身（`agent.approval.detail.v1`）。
 *
 * PC は hook（PermissionRequest）か mod（Claude Mods）から受けた `tool_name` / `tool_input` を、ツールごとに
 * 項目を分けた形にして承認の interaction の `request` に載せる。アプリはこれで「Bash の説明とコマンドの全文」
 * 「Edit のパスと差分の先頭」などを出し分ける。古いアプリは `request` を知らず、今までの `detail`（1 行）を出す。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import し、PC が組み立てた形を
 * アプリが同じ関数で読み直す（両側で上限と形が食い違わないように）。
 */

/** capability の名前。PC がこれを広告していれば、承認に `request` などを載せ、拒否に添えた指示（`message`）を受ける。 */
export const PARADIS_AGENT_APPROVAL_DETAIL_CAPABILITY = 'agent.approval.detail.v1';

/** ツールの種類（アプリが本文の形を決めるのに使う）。 */
export type ParadisAgentApprovalToolKind = 'bash' | 'edit' | 'write' | 'fetch' | 'mcp' | 'other';

/** 許可を求めたサブエージェント（本会話からの許可には付けない）。 */
export interface IParadisAgentApprovalAgent {
	/** hook の `agent_id`（mod の `agentId`）。 */
	readonly id?: string;
	/** 呼び名（hook の `agent_type`。無ければ活動の一覧の名前）。TUI の「from the … agent」と同じもの。 */
	readonly name?: string;
	readonly role?: 'subagent' | 'teammate';
}

/** 入力の 1 項目（MCP の引数と、形を知らないツールの入力）。 */
export interface IParadisAgentApprovalArg {
	readonly key: string;
	readonly value: string;
}

/** 許可を求めた操作の中身。項目はツールの種類ごとに使うものだけを持つ。 */
export interface IParadisAgentApprovalRequest {
	/** ツール名（`Bash`・`Edit`・`mcp__acme-db__run_query` など）。 */
	readonly tool: string;
	readonly kind: ParadisAgentApprovalToolKind;
	/** Bash の説明（`description`）。 */
	readonly description?: string;
	/** Bash のコマンドの全文。 */
	readonly command?: string;
	/** Edit / Write のパス。 */
	readonly path?: string;
	/** Edit の置き換え前と置き換え後（先頭だけ）。 */
	readonly oldText?: string;
	readonly newText?: string;
	readonly replaceAll?: boolean;
	/** Write の中身の先頭と、全体の行数。 */
	readonly content?: string;
	readonly contentLines?: number;
	/** WebFetch の URL と、取ってきて何をするか。 */
	readonly url?: string;
	readonly prompt?: string;
	/** MCP のサーバー名とツール名（`mcp__<server>__<tool>` を分けたもの）。 */
	readonly mcpServer?: string;
	readonly mcpTool?: string;
	/** MCP の引数・形を知らないツールの入力（先頭の {@link MAX_ARGS} 個）。 */
	readonly args?: readonly IParadisAgentApprovalArg[];
	/** どこかを上限で切った（Edit の差分・Write の中身・引数の数など）。 */
	readonly truncated?: boolean;
	readonly agent?: IParadisAgentApprovalAgent;
}

/**
 * 「以後は確認しない」で足されるものの残り方（permission_suggestions から決める）。
 * - `session`: このセッションの間だけ
 * - `settings`: 設定ファイル（`localSettings` など）に書かれ、セッションを越えて残る
 * - `mode`: 許可のモードを切り替える
 */
export type ParadisAgentApprovalSuggestionScope = 'session' | 'settings' | 'mode';

const TOOL_LIMIT = 200;
/** コマンドの上限（hook の入力の文字列の上限 HOOK_PAYLOAD_MAX_STRING と同じ。paradisAgentHookBus.ts）。 */
const COMMAND_LIMIT = 10_000;
const DESCRIPTION_LIMIT = 1_000;
const PATH_LIMIT = 1_000;
/** Edit の差分・Write の中身は先頭だけ送る（カードとシートで読む量。全文はファイルで見る）。 */
const TEXT_HEAD_LIMIT = 2_000;
const URL_LIMIT = 2_000;
const PROMPT_LIMIT = 1_000;
const MAX_ARGS = 20;
const ARG_KEY_LIMIT = 100;
const ARG_VALUE_LIMIT = 500;
const AGENT_FIELD_LIMIT = 200;
/** 拒否に添える指示の上限（アプリの入力欄と PC の検査で同じ値を使う）。 */
export const PARADIS_AGENT_APPROVAL_DENY_MESSAGE_LIMIT = 4_000;

function text(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, limit) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 入力の値を 1 行の文字にする（文字列はそのまま、それ以外は JSON）。 */
function argValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function argsOf(input: Record<string, unknown>, skip: readonly string[]): { readonly args: IParadisAgentApprovalArg[]; readonly truncated: boolean } {
	const keys = Object.keys(input).filter(key => !skip.includes(key));
	let truncated = keys.length > MAX_ARGS;
	const args: IParadisAgentApprovalArg[] = [];
	for (const key of keys.slice(0, MAX_ARGS)) {
		const value = argValue(input[key]);
		truncated ||= value.length > ARG_VALUE_LIMIT || key.length > ARG_KEY_LIMIT;
		args.push({ key: key.slice(0, ARG_KEY_LIMIT), value: value.slice(0, ARG_VALUE_LIMIT) });
	}
	return { args, truncated };
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split('\n').length - (value.endsWith('\n') ? 1 : 0);
}

/**
 * hook / mod の `tool_name` と `tool_input` から、カードに出す操作の中身を作る。ツール名が無ければ undefined。
 * 入力はすでに hook と同じ上限・伏せ字を通したもの（paradisSanitizeAgentHookPayload）を渡す。
 */
export function paradisBuildAgentApprovalRequest(toolName: string | undefined, toolInput: unknown, agent?: IParadisAgentApprovalAgent): IParadisAgentApprovalRequest | undefined {
	const tool = text(toolName, TOOL_LIMIT);
	if (tool === undefined) {
		return undefined;
	}
	const input = record(toolInput) ?? {};
	const agentField = agent !== undefined && (agent.id !== undefined || agent.name !== undefined) ? { agent } : {};
	// Bash・PowerShell・Codex のシェルなど、`command` を持つツール（MCP の引数の `command` はツールの引数として出す）
	const command = tool.startsWith('mcp__') ? undefined : text(input.command, COMMAND_LIMIT);
	if (command !== undefined) {
		const description = text(input.description, DESCRIPTION_LIMIT);
		return {
			tool, kind: 'bash', command, ...(description !== undefined ? { description } : {}),
			// 入力は hook の上限（10,000 字）で切ってから届くので、上限ちょうどの長さは「切られた」とみなす
			...(typeof input.command === 'string' && input.command.length >= COMMAND_LIMIT ? { truncated: true } : {}), ...agentField,
		};
	}
	const path = text(input.file_path, PATH_LIMIT) ?? text(input.notebook_path, PATH_LIMIT);
	if (path !== undefined && (tool === 'Edit' || tool === 'MultiEdit')) {
		const edits = Array.isArray(input.edits) ? input.edits.map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
		const first = tool === 'MultiEdit' ? edits[0] ?? {} : input;
		const oldString = typeof first.old_string === 'string' ? first.old_string : '';
		const newString = typeof first.new_string === 'string' ? first.new_string : '';
		const truncated = oldString.length > TEXT_HEAD_LIMIT || newString.length > TEXT_HEAD_LIMIT || edits.length > 1;
		return {
			tool, kind: 'edit', path, oldText: oldString.slice(0, TEXT_HEAD_LIMIT), newText: newString.slice(0, TEXT_HEAD_LIMIT),
			...(first.replace_all === true ? { replaceAll: true } : {}), ...(truncated ? { truncated: true } : {}), ...agentField,
		};
	}
	if (path !== undefined && tool === 'Write' && typeof input.content === 'string') {
		const content = input.content;
		return {
			tool, kind: 'write', path, content: content.slice(0, TEXT_HEAD_LIMIT), contentLines: lineCount(content),
			...(content.length > TEXT_HEAD_LIMIT ? { truncated: true } : {}), ...agentField,
		};
	}
	const url = text(input.url, URL_LIMIT);
	if (url !== undefined && tool === 'WebFetch') {
		const prompt = text(input.prompt, PROMPT_LIMIT);
		return { tool, kind: 'fetch', url, ...(prompt !== undefined ? { prompt } : {}), ...agentField };
	}
	const mcp = /^mcp__(?<server>.+?)__(?<name>.+)$/.exec(tool)?.groups;
	const { args, truncated } = argsOf(input, []);
	if (mcp !== undefined) {
		return {
			tool, kind: 'mcp', mcpServer: (mcp.server ?? '').slice(0, TOOL_LIMIT), mcpTool: (mcp.name ?? '').slice(0, TOOL_LIMIT),
			...(args.length > 0 ? { args } : {}), ...(truncated ? { truncated: true } : {}), ...agentField,
		};
	}
	return {
		tool, kind: 'other', ...(path !== undefined ? { path } : {}),
		...(args.length > 0 ? { args } : {}), ...(truncated ? { truncated: true } : {}), ...agentField,
	};
}

function readAgent(value: unknown): IParadisAgentApprovalAgent | undefined {
	const raw = record(value);
	if (raw === undefined) {
		return undefined;
	}
	const id = text(raw.id, AGENT_FIELD_LIMIT);
	const name = text(raw.name, AGENT_FIELD_LIMIT);
	const role = raw.role === 'subagent' || raw.role === 'teammate' ? raw.role : undefined;
	return id !== undefined || name !== undefined ? { ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}), ...(role !== undefined ? { role } : {}) } : undefined;
}

/**
 * 届いた `request` を読み直す（アプリが使う。相手は信用しない前提で、上限を超えるもの・形の違うものは捨てる）。
 * ツール名か種類が読めなければ undefined（アプリは今までの `detail` を出す）。
 */
export function paradisParseAgentApprovalRequest(value: unknown): IParadisAgentApprovalRequest | undefined {
	const raw = record(value);
	const tool = raw !== undefined && typeof raw.tool === 'string' && raw.tool.length > 0 && raw.tool.length <= TOOL_LIMIT ? raw.tool : undefined;
	const kind = raw?.kind;
	if (raw === undefined || tool === undefined || (kind !== 'bash' && kind !== 'edit' && kind !== 'write' && kind !== 'fetch' && kind !== 'mcp' && kind !== 'other')) {
		return undefined;
	}
	const field = (key: string, limit: number): string | undefined => {
		const candidate = raw[key];
		return typeof candidate === 'string' && candidate.length <= limit ? candidate : undefined;
	};
	const strings = {
		description: field('description', DESCRIPTION_LIMIT), command: field('command', COMMAND_LIMIT), path: field('path', PATH_LIMIT),
		oldText: field('oldText', TEXT_HEAD_LIMIT), newText: field('newText', TEXT_HEAD_LIMIT), content: field('content', TEXT_HEAD_LIMIT),
		url: field('url', URL_LIMIT), prompt: field('prompt', PROMPT_LIMIT), mcpServer: field('mcpServer', TOOL_LIMIT), mcpTool: field('mcpTool', TOOL_LIMIT),
	};
	const present: { -readonly [K in keyof typeof strings]?: string } = {};
	for (const key of Object.keys(strings) as (keyof typeof strings)[]) {
		const candidate = strings[key];
		if (candidate !== undefined) {
			present[key] = candidate;
		}
	}
	const args = Array.isArray(raw.args) && raw.args.length <= MAX_ARGS
		? raw.args.map(record).filter((arg): arg is Record<string, unknown> => arg !== undefined
			&& typeof arg.key === 'string' && arg.key.length > 0 && arg.key.length <= ARG_KEY_LIMIT
			&& typeof arg.value === 'string' && arg.value.length <= ARG_VALUE_LIMIT).map(arg => ({ key: arg.key as string, value: arg.value as string }))
		: [];
	const contentLines = typeof raw.contentLines === 'number' && Number.isSafeInteger(raw.contentLines) && raw.contentLines >= 0 ? raw.contentLines : undefined;
	const agent = readAgent(raw.agent);
	return {
		tool, kind, ...present,
		...(raw.replaceAll === true ? { replaceAll: true } : {}),
		...(contentLines !== undefined ? { contentLines } : {}),
		...(args.length > 0 ? { args } : {}),
		...(raw.truncated === true ? { truncated: true } : {}),
		...(agent !== undefined ? { agent } : {}),
	};
}

/**
 * permission_suggestions（Claude Code が「以後は確認しない」で足すものの候補）の残り方。候補が無ければ undefined。
 * モードを変えるものがあれば `mode`、すべて `destination: 'session'` なら `session`、それ以外（設定ファイル・知らない値・無し）は `settings`。
 */
export function paradisApprovalSuggestionScope(suggestions: unknown): ParadisAgentApprovalSuggestionScope | undefined {
	if (!Array.isArray(suggestions)) {
		return undefined;
	}
	const entries = suggestions.map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined);
	if (entries.length === 0) {
		return undefined;
	}
	if (entries.some(entry => entry.type === 'setMode')) {
		return 'mode';
	}
	// 残り方の分からないもの（`destination` が無い・知らない値）は、残る側（settings）に倒す
	return entries.every(entry => entry.destination === 'session') ? 'session' : 'settings';
}

/** 届いた `suggestionScope` を読む。 */
export function paradisParseApprovalSuggestionScope(value: unknown): ParadisAgentApprovalSuggestionScope | undefined {
	return value === 'session' || value === 'settings' || value === 'mode' ? value : undefined;
}

/**
 * 拒否に添えた指示を、Claude Code へ返す拒否の文にする。TUI の「No, and tell Claude what to do differently」
 * （Tab to amend）が書く tool_result と同じ文にする（Claude Code 2.1.289 で実測。mod の deny の message は
 * そのまま tool_result に入る）。モデルはこの文を利用者の指示として読んで作業を続ける。
 *
 * Para Code は、この文が含む {@link PARADIS_APPROVAL_INSTRUCTION_MARKER} を見て、止まった拒否とはみなさない
 * （ペインを作業中のままにし、待機へ落とさない。paradisMobileAgentChat.ts の paradisIsToolRejection）。
 */
export function paradisApprovalDenyMessage(instruction: string): string {
	return `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). ${PARADIS_APPROVAL_INSTRUCTION_MARKER}\n${paradisSanitizeApprovalInstruction(instruction)}`;
}

/**
 * 拒否に指示が添えてあるときの tool_result の目印（Claude Code 2.1.289 の TUI の amend と同じ文。実測）。
 * これを含む拒否は、エージェントが指示で作業を続ける（止まった拒否ではない）。
 */
export const PARADIS_APPROVAL_INSTRUCTION_MARKER = 'To tell you how to proceed, the user said:';

/**
 * 指示から、制御文字（改行とタブは残す）と、表示の向きを変える文字（U+202A〜U+202E・U+2066〜U+2069）と、
 * 行・段落の区切り（U+2028・U+2029）を除き、前後の空白を落とす。
 */
export function paradisSanitizeApprovalInstruction(instruction: string): string {
	return instruction.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
}
