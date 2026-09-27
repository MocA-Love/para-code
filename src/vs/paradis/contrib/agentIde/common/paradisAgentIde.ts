/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが Para Code を操作する MCP ツール（O1、q.html の Q75）で、shared process と
// ウィンドウの両方が読む定義。ツールの定義・引数の検証・ウィンドウへ渡す要求の形をここに置く。
//
// 権限の決まり（Q75 の回答）:
// - 読み取り（一覧・画面を読む・待つ）は常に使える。範囲は呼び出し元ペインのウィンドウの中
// - 送信・作成・閉じる・削除は設定 `paradis.agentIde.allowActions`（既定オフ）でオンにしたときだけ
// - 入力を送れるのは同じスペースのターミナルだけ。設定 `paradis.agentIde.actionScope` で同じウィンドウ全体へ
//   広げられる。そのエージェント自身が作ったターミナル・スペースは、スペースが違っても送れる
//   （作った子エージェントへ続きの指示を出せないと、作る意味が無いため）
// - 閉じる・削除は、そのエージェント自身が作ったものだけ
// - 許可待ち・質問中のペインへは何も送らない。Enter を送るかは毎回明示させる

/** ウィンドウが shared process の IPCServer へ登録するチャネル名。 */
export const PARADIS_AGENT_IDE_CHANNEL = 'paradisAgentIde';
/** {@link PARADIS_AGENT_IDE_CHANNEL} の呼び出しメソッド名。引数は `[呼び出し元のペイントークン, 要求]`。 */
export const PARADIS_AGENT_IDE_METHOD = 'run';

/** スキルファイルの設置を受け持つ shared process のチャネル名。 */
export const PARADIS_AGENT_IDE_SKILLS_CHANNEL = 'paradisAgentIdeSkills';

/** 送信・作成・閉じる・削除を許すか（既定オフ）。 */
export const PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING = 'paradis.agentIde.allowActions';
/** 入力を送れる範囲。`space`（既定）か `window`。 */
export const PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING = 'paradis.agentIde.actionScope';

export type ParadisAgentIdeActionScope = 'space' | 'window';

/** 設定値を読み違えない形に直す。知らない値は狭い方（`space`）に倒す。 */
export function paradisAgentIdeActionScope(value: unknown): ParadisAgentIdeActionScope {
	return value === 'window' ? 'window' : 'space';
}

/** 設定値を読み違えない形に直す。`true` のときだけ許す。 */
export function paradisAgentIdeActionsAllowed(value: unknown): boolean {
	return value === true;
}

/** 画面を読むときの既定の行数と上限。 */
export const PARADIS_AGENT_IDE_DEFAULT_READ_LINES = 80;
export const PARADIS_AGENT_IDE_MAX_READ_LINES = 500;

/** 待機の既定と上限（秒）。上限は Codex の MCP ツールの既定のタイムアウト（0.155.1 で 300 秒）より短くする。 */
export const PARADIS_AGENT_IDE_DEFAULT_WAIT_SECONDS = 60;
export const PARADIS_AGENT_IDE_MAX_WAIT_SECONDS = 240;

/** 1回に送れる文字数の上限。長い指示はファイルに書いてパスを渡させる。 */
export const PARADIS_AGENT_IDE_MAX_INPUT_LENGTH = 8_000;
/** 待機で探す文字列の長さの上限。 */
export const PARADIS_AGENT_IDE_MAX_WAIT_TEXT_LENGTH = 200;

/** エージェントへ見せるターミナルの状態。 */
export type ParadisAgentIdeTerminalStatus = 'working' | 'waiting_for_permission' | 'asking_question' | 'finished' | 'idle';

/** 待つ条件。 */
export type ParadisAgentIdeWaitCondition = 'agent_stopped' | 'needs_input' | 'text';

/** `send_terminal_key` で送れるキー。 */
export const PARADIS_AGENT_IDE_KEYS = ['enter', 'escape', 'ctrl_c', 'tab', 'backspace', 'up', 'down', 'left', 'right'] as const;
export type ParadisAgentIdeKey = typeof PARADIS_AGENT_IDE_KEYS[number];

// --- ウィンドウへ渡す要求 -------------------------------------------------------------------

export type ParadisAgentIdeRequest =
	| { readonly op: 'listSpaces' }
	| { readonly op: 'listTerminals'; readonly space?: string }
	| { readonly op: 'readTerminal'; readonly terminal: string; readonly lines: number }
	/** 待機用。状態の判断に使うペイントークンを shared process へ返す（エージェントへは出さない）。 */
	| { readonly op: 'probeTerminal'; readonly terminal: string; readonly lines: number }
	/** 送る前の確かめ。範囲の判断をして、状態の判断に使うペイントークンを返す。 */
	| { readonly op: 'resolveWriteTarget'; readonly terminal: string }
	| { readonly op: 'sendInput'; readonly terminal: string; readonly text: string; readonly pressEnter: boolean }
	| { readonly op: 'sendKey'; readonly terminal: string; readonly key: ParadisAgentIdeKey }
	| { readonly op: 'launchAgent'; readonly agent: string; readonly prompt?: string; readonly space?: string; readonly model?: string; readonly effort?: string }
	| { readonly op: 'createTerminal'; readonly space?: string }
	| { readonly op: 'createSpace'; readonly repository?: string; readonly name?: string; readonly branch?: string; readonly baseBranch?: string; readonly prompt?: string; readonly agent?: string; readonly model?: string; readonly effort?: string; readonly runSetup?: boolean }
	| { readonly op: 'closeTerminal'; readonly terminal: string }
	| { readonly op: 'removeSpace'; readonly space: string };

export type ParadisAgentIdeOperation = ParadisAgentIdeRequest['op'];

/** ウィンドウからの応答。`internal` は shared process だけが使い、エージェントへの応答には載せない。 */
export type ParadisAgentIdeResult =
	| { readonly ok: true; readonly data: object; readonly internal?: IParadisAgentIdeInternal }
	| { readonly ok: false; readonly error: string };

export interface IParadisAgentIdeInternal {
	/** 対象ペインのトークン。hook から分かる状態を引くのに使う。**秘密なのでエージェントへ出さない。** */
	readonly paneToken?: string;
	/** 対象のターミナルが無くなっている（待機を打ち切る）。 */
	readonly gone?: boolean;
	/** 画面の末尾の文字列（待機の文字列探し用）。 */
	readonly screen?: string;
	/** ウィンドウ側の表示から見た状態（hook の状態が無いときの代わり）。 */
	readonly status?: ParadisAgentIdeTerminalStatus;
}

// --- 状態の変換 -----------------------------------------------------------------------------

/** hook の状態（`working` など）をエージェントに見せる語へ直す。 */
export function paradisAgentIdeStatusLabel(status: 'working' | 'permission' | 'question' | 'review' | undefined): ParadisAgentIdeTerminalStatus {
	switch (status) {
		case 'working': return 'working';
		case 'permission': return 'waiting_for_permission';
		case 'question': return 'asking_question';
		case 'review': return 'finished';
		default: return 'idle';
	}
}

/** 人の判断を待っている状態か（この間は何も送らない）。 */
export function paradisAgentIdeNeedsHuman(status: ParadisAgentIdeTerminalStatus): boolean {
	return status === 'waiting_for_permission' || status === 'asking_question';
}

/** 送った直後に「エージェントが動き出すまで」を待つ猶予。 */
export const PARADIS_AGENT_IDE_START_GRACE_MS = 5_000;

/**
 * 「エージェントの番が終わった（または人の答え待ちになった）」を判定する。定期実行など、
 * 指示を入れてから終わるまで待つ機能でも同じ規則を使えるよう、状態の出どころから切り離してある。
 *
 * 指示を送った直後は、まだ `working` になる前の古い状態（`finished` / `idle`）が見えるので、
 * 「待っている間に動いていた」「待ち始めた後に止まった」「猶予を過ぎた」のどれかで止まったと確定する。
 */
export class ParadisAgentStopWatcher {
	private _sawWorking = false;

	constructor(private readonly _startedAt: number, private readonly _graceMs: number = PARADIS_AGENT_IDE_START_GRACE_MS) { }

	/**
	 * @param status 今の状態
	 * @param statusChangedAt その状態になった時刻（hook の記録。分からなければ undefined）
	 * @param now 今の時刻
	 */
	observe(status: ParadisAgentIdeTerminalStatus, statusChangedAt: number | undefined, now: number): boolean {
		if (status === 'working') {
			this._sawWorking = true;
			return false;
		}
		if (paradisAgentIdeNeedsHuman(status)) {
			return true;
		}
		return this._sawWorking
			|| (statusChangedAt !== undefined && statusChangedAt >= this._startedAt)
			|| now - this._startedAt >= this._graceMs;
	}
}

// --- 送る文字の整形 -------------------------------------------------------------------------

/**
 * 送る本文から、打鍵として解釈される制御文字を取り除く。
 *
 * 本文は貼り付け（bracketed paste）で送るが、ESC を含めると貼り付けの終わりの印
 * （`ESC [201~`）を偽造でき、その後ろが打鍵として流れる。タブは Claude Code の質問画面で
 * 「次の質問へ」に食われる（NOTES / メモリの TUI 実測）。改行だけは複数行の指示のために残す。
 */
export function paradisAgentIdeSanitizeInput(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/\t/g, '    ')
		// C0 制御文字（改行を除く）・DEL・C1 制御文字を落とす
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

/** キーの名前 → 送るバイト列。矢印キーはアプリケーションモードで別の列になる。 */
export function paradisAgentIdeKeySequence(key: ParadisAgentIdeKey, applicationCursorKeys: boolean): string {
	const arrow = (final: string) => applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
	switch (key) {
		case 'enter': return '\r';
		case 'escape': return '\x1b';
		case 'ctrl_c': return '\x03';
		case 'tab': return '\t';
		case 'backspace': return '\x7f';
		case 'up': return arrow('A');
		case 'down': return arrow('B');
		case 'right': return arrow('C');
		case 'left': return arrow('D');
	}
}

/** ターミナルの画面の末尾 `lines` 行を、後ろの空行を落として返す。 */
export function paradisAgentIdeTailLines(allLines: readonly string[], lines: number): string {
	let end = allLines.length;
	while (end > 0 && allLines[end - 1].trim().length === 0) {
		end--;
	}
	return allLines.slice(Math.max(0, end - lines), end).map(line => line.replace(/\s+$/, '')).join('\n');
}

// --- ツールの定義 ---------------------------------------------------------------------------

export const PARADIS_AGENT_IDE_TOOL_GUIDE = 'read_para_code_guide';

/** 送信・作成・閉じる・削除の系統のツール（設定でオンにしたときだけ動く）。 */
export const PARADIS_AGENT_IDE_ACTION_TOOLS: ReadonlySet<string> = new Set([
	'send_terminal_input',
	'send_terminal_key',
	'launch_agent',
	'create_terminal',
	'create_space',
	'close_terminal',
	'remove_space',
]);

const TERMINAL_ARGUMENT = {
	type: 'string',
	description: 'Terminal id from list_terminals (looks like "t_1a2b3c4d5e6f"). Ids are not secret and stay the same across window reloads.',
} as const;

const SPACE_ARGUMENT = {
	type: 'string',
	description: 'Space key from list_spaces (a repository id or "worktree:<uri>"). Omit to use the space this terminal pane belongs to.',
} as const;

const ACTIONS_OFF_NOTE = 'Only works when the user has turned on "Allow agents to operate terminals and spaces" in Para Code settings (off by default).';

export interface IParadisAgentIdeToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
}

export const PARADIS_AGENT_IDE_TOOLS: readonly IParadisAgentIdeToolDefinition[] = [
	{
		name: PARADIS_AGENT_IDE_TOOL_GUIDE,
		description: 'Read the guide for the Para Code IDE tools (spaces, terminals, other agents): the workflow, the permission rules and common mistakes. Call this once before using list_terminals / send_terminal_input / launch_agent / create_space.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'list_spaces',
		description: 'List the spaces (repositories and their git worktrees) in the Para Code window that owns this terminal pane, the agents you can launch (with model/effort ids), and whether actions (send/create/close) are enabled. The space of this pane has "current": true; the one on screen has "on_screen": true.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'list_terminals',
		description: 'List the terminals in the Para Code window that owns this terminal pane, with their space, title and agent status (working, waiting_for_permission, asking_question, finished, idle). Your own pane has "self": true. "can_send": true means send_terminal_input would be accepted right now. Always use the "id" from here, never a title.',
		inputSchema: {
			type: 'object',
			properties: { space: { type: 'string', description: 'Only list terminals of this space key (from list_spaces). Omit to list every terminal in the window.' } },
			additionalProperties: false,
		},
	},
	{
		name: 'read_terminal',
		description: 'Read the last lines of another terminal\'s screen (including scrollback) as plain text, plus its agent status. Use it before sending input, and after wait_for_terminal to read what an agent answered.',
		inputSchema: {
			type: 'object',
			properties: {
				terminal: TERMINAL_ARGUMENT,
				lines: { type: 'integer', minimum: 1, maximum: PARADIS_AGENT_IDE_MAX_READ_LINES, description: `How many lines from the bottom to return (default ${PARADIS_AGENT_IDE_DEFAULT_READ_LINES}).` },
			},
			required: ['terminal'],
			additionalProperties: false,
		},
	},
	{
		name: 'wait_for_terminal',
		description: `Wait until a terminal reaches a state, then return its status and the last lines of its screen. until="agent_stopped": the agent's turn ended, or it now waits for a permission/question answer (right after sending a prompt this first waits up to 5 seconds for the agent to start). until="needs_input": the agent waits for a permission or question answer. until="text": the given text appears in the last 80 lines of the screen (plain substring, case-sensitive; text already on screen matches immediately). Returns "met": false with "timed_out": true when the time runs out - call it again to keep waiting. Maximum ${PARADIS_AGENT_IDE_MAX_WAIT_SECONDS} seconds per call.`,
		inputSchema: {
			type: 'object',
			properties: {
				terminal: TERMINAL_ARGUMENT,
				until: { type: 'string', enum: ['agent_stopped', 'needs_input', 'text'] },
				text: { type: 'string', maxLength: PARADIS_AGENT_IDE_MAX_WAIT_TEXT_LENGTH, description: 'Required when until="text".' },
				timeout_seconds: { type: 'integer', minimum: 1, maximum: PARADIS_AGENT_IDE_MAX_WAIT_SECONDS, description: `Default ${PARADIS_AGENT_IDE_DEFAULT_WAIT_SECONDS}.` },
			},
			required: ['terminal', 'until'],
			additionalProperties: false,
		},
	},
	{
		name: 'send_terminal_input',
		description: `Type text into another terminal (pasted, so an agent CLI receives it as one message). You must say whether to press Enter: press_enter=true submits it (runs a shell command or sends a prompt to an agent), press_enter=false only leaves it in the input line. Refused while the target waits for a permission or question answer (only the user answers those), for your own pane, and for terminals outside your space unless you created them. Control characters are removed; newlines are kept. ${ACTIONS_OFF_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				terminal: TERMINAL_ARGUMENT,
				text: { type: 'string', maxLength: PARADIS_AGENT_IDE_MAX_INPUT_LENGTH, description: 'The text to type. For long instructions write them to a file and send its path.' },
				press_enter: { type: 'boolean', description: 'true to press Enter after the text, false to leave it unsent. Required: there is no default.' },
			},
			required: ['terminal', 'text', 'press_enter'],
			additionalProperties: false,
		},
	},
	{
		name: 'send_terminal_key',
		description: `Press one key in another terminal: enter, escape, ctrl_c (interrupt), tab, backspace or an arrow key. Same restrictions as send_terminal_input (never while it waits for a permission or question answer). ${ACTIONS_OFF_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				terminal: TERMINAL_ARGUMENT,
				key: { type: 'string', enum: [...PARADIS_AGENT_IDE_KEYS] },
			},
			required: ['terminal', 'key'],
			additionalProperties: false,
		},
	},
	{
		name: 'launch_agent',
		description: `Open a new terminal tab in a space and start an agent CLI there (ids from list_spaces "agents", e.g. "claude" or "codex"), optionally with a first prompt. The agent starts with the user's default permission mode. Returns the new terminal id; follow up with wait_for_terminal and read_terminal. ${ACTIONS_OFF_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'Agent id from list_spaces "agents".' },
				prompt: { type: 'string', maxLength: PARADIS_AGENT_IDE_MAX_INPUT_LENGTH, description: 'First prompt passed on the command line. Omit to start the agent idle.' },
				space: SPACE_ARGUMENT,
				model: { type: 'string', description: 'Model id from list_spaces "agents". Omit for the default.' },
				effort: { type: 'string', description: 'Effort id from list_spaces "agents". Omit for the default.' },
			},
			required: ['agent'],
			additionalProperties: false,
		},
	},
	{
		name: 'create_terminal',
		description: `Open a new shell terminal tab in a space (without starting anything). Returns its id; use send_terminal_input to run commands in it. ${ACTIONS_OFF_NOTE}`,
		inputSchema: { type: 'object', properties: { space: SPACE_ARGUMENT }, additionalProperties: false },
	},
	{
		name: 'create_space',
		description: `Create a new space: a git worktree on a new branch of a repository, shown in the Para Code sidebar. The user's screen does not switch to it. Optionally starts an agent in it with a first prompt (the usual way to hand a task to another agent). Can take a minute (branch naming, git worktree add, the repository's setup script). Returns the space key and, if an agent was started, its terminal id. ${ACTIONS_OFF_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				repository: { type: 'string', description: 'Repository space key (kind "repository" in list_spaces). Omit to use the repository of your own space.' },
				name: { type: 'string', maxLength: 100, description: 'Display name. Omit to derive it from the prompt.' },
				branch: { type: 'string', maxLength: 100, description: 'New branch name. Omit to derive it from the prompt.' },
				base_branch: { type: 'string', maxLength: 200, description: 'Branch to start from. Omit for the branch currently checked out in the repository.' },
				prompt: { type: 'string', maxLength: PARADIS_AGENT_IDE_MAX_INPUT_LENGTH, description: 'Task for the agent (also used to name the branch).' },
				agent: { type: 'string', description: 'Agent id from list_spaces "agents" to start in the new space. Omit to start no agent.' },
				model: { type: 'string' },
				effort: { type: 'string' },
				run_setup: { type: 'boolean', description: 'Run the repository\'s setup script (default true).' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'close_terminal',
		description: `Close a terminal and end its process. Only terminals that you created with launch_agent, create_terminal or create_space can be closed. ${ACTIONS_OFF_NOTE}`,
		inputSchema: { type: 'object', properties: { terminal: TERMINAL_ARGUMENT }, required: ['terminal'], additionalProperties: false },
	},
	{
		name: 'remove_space',
		description: `Ask the user to delete a worktree space that you created with create_space. Para Code shows the user a confirmation dialog and deletes it only if they agree (uncommitted changes need a second confirmation), so this returns before anything is deleted. ${ACTIONS_OFF_NOTE}`,
		inputSchema: { type: 'object', properties: { space: { type: 'string', description: 'Space key returned by create_space.' } }, required: ['space'], additionalProperties: false },
	},
];

export const PARADIS_AGENT_IDE_TOOL_NAMES: ReadonlySet<string> = new Set(PARADIS_AGENT_IDE_TOOLS.map(tool => tool.name));

// --- 引数の検証 -----------------------------------------------------------------------------

export type ParadisAgentIdeParsedCall =
	| { readonly kind: 'guide' }
	| { readonly kind: 'window'; readonly request: ParadisAgentIdeRequest; readonly action: boolean }
	| { readonly kind: 'wait'; readonly terminal: string; readonly until: ParadisAgentIdeWaitCondition; readonly text?: string; readonly timeoutSeconds: number };

type Args = Record<string, unknown>;

function optionalString(args: Args, key: string, maxLength: number): string | undefined | Error {
	const value = args[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		return new Error(`"${key}" must be a string.`);
	}
	if (value.length > maxLength) {
		return new Error(`"${key}" is too long (limit: ${maxLength} characters, got: ${value.length}).`);
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function requiredString(args: Args, key: string, maxLength: number): string | Error {
	const value = optionalString(args, key, maxLength);
	if (value === undefined) {
		return new Error(`"${key}" is required.`);
	}
	return value;
}

function optionalInteger(args: Args, key: string, min: number, max: number, fallback: number): number | Error {
	const value = args[key];
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return new Error(`"${key}" must be an integer.`);
	}
	return Math.min(max, Math.max(min, value));
}

/**
 * ツール名と引数を、ウィンドウへ渡す要求へ直す。形が合わないものはここで弾き、
 * エージェントがそのまま読めるエラー文を返す。
 */
export function paradisParseAgentIdeCall(name: string, rawArgs: unknown): ParadisAgentIdeParsedCall | { readonly kind: 'error'; readonly error: string } {
	if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
		return { kind: 'error', error: 'Tool arguments must be an object.' };
	}
	const args: Args = (rawArgs ?? {}) as Args;
	const fail = (error: Error) => ({ kind: 'error' as const, error: error.message });
	const terminal = () => requiredString(args, 'terminal', 64);

	switch (name) {
		case PARADIS_AGENT_IDE_TOOL_GUIDE:
			return { kind: 'guide' };
		case 'list_spaces':
			return { kind: 'window', action: false, request: { op: 'listSpaces' } };
		case 'list_terminals': {
			const space = optionalString(args, 'space', 4096);
			if (space instanceof Error) { return fail(space); }
			return { kind: 'window', action: false, request: { op: 'listTerminals', ...(space !== undefined ? { space } : {}) } };
		}
		case 'read_terminal': {
			const id = terminal();
			if (id instanceof Error) { return fail(id); }
			const lines = optionalInteger(args, 'lines', 1, PARADIS_AGENT_IDE_MAX_READ_LINES, PARADIS_AGENT_IDE_DEFAULT_READ_LINES);
			if (lines instanceof Error) { return fail(lines); }
			return { kind: 'window', action: false, request: { op: 'readTerminal', terminal: id, lines } };
		}
		case 'wait_for_terminal': {
			const id = terminal();
			if (id instanceof Error) { return fail(id); }
			const until = args.until;
			if (until !== 'agent_stopped' && until !== 'needs_input' && until !== 'text') {
				return { kind: 'error', error: '"until" must be one of "agent_stopped", "needs_input", "text".' };
			}
			const timeoutSeconds = optionalInteger(args, 'timeout_seconds', 1, PARADIS_AGENT_IDE_MAX_WAIT_SECONDS, PARADIS_AGENT_IDE_DEFAULT_WAIT_SECONDS);
			if (timeoutSeconds instanceof Error) { return fail(timeoutSeconds); }
			if (until === 'text') {
				// 探す文字列は前後の空白も意味を持ちうるので trim しない
				const text = args.text;
				if (typeof text !== 'string' || text.length === 0) {
					return { kind: 'error', error: '"text" is required when until="text".' };
				}
				if (text.length > PARADIS_AGENT_IDE_MAX_WAIT_TEXT_LENGTH) {
					return { kind: 'error', error: `"text" is too long (limit: ${PARADIS_AGENT_IDE_MAX_WAIT_TEXT_LENGTH} characters).` };
				}
				return { kind: 'wait', terminal: id, until, text, timeoutSeconds };
			}
			return { kind: 'wait', terminal: id, until, timeoutSeconds };
		}
		case 'send_terminal_input': {
			const id = terminal();
			if (id instanceof Error) { return fail(id); }
			const text = args.text;
			if (typeof text !== 'string') {
				return { kind: 'error', error: '"text" is required and must be a string.' };
			}
			if (text.length > PARADIS_AGENT_IDE_MAX_INPUT_LENGTH) {
				return { kind: 'error', error: `"text" is too long (limit: ${PARADIS_AGENT_IDE_MAX_INPUT_LENGTH} characters, got: ${text.length}). Write long instructions to a file and send its path instead.` };
			}
			if (typeof args.press_enter !== 'boolean') {
				return { kind: 'error', error: '"press_enter" is required: pass true to submit the text with Enter, or false to only type it.' };
			}
			const sanitized = paradisAgentIdeSanitizeInput(text);
			if (sanitized.trim().length === 0 && !args.press_enter) {
				return { kind: 'error', error: 'Nothing to send: the text is empty after removing control characters. Use send_terminal_key to press a single key.' };
			}
			return { kind: 'window', action: true, request: { op: 'sendInput', terminal: id, text: sanitized, pressEnter: args.press_enter } };
		}
		case 'send_terminal_key': {
			const id = terminal();
			if (id instanceof Error) { return fail(id); }
			const key = args.key;
			if (typeof key !== 'string' || !(PARADIS_AGENT_IDE_KEYS as readonly string[]).includes(key)) {
				return { kind: 'error', error: `"key" must be one of ${PARADIS_AGENT_IDE_KEYS.join(', ')}.` };
			}
			return { kind: 'window', action: true, request: { op: 'sendKey', terminal: id, key: key as ParadisAgentIdeKey } };
		}
		case 'launch_agent': {
			const agent = requiredString(args, 'agent', 64);
			if (agent instanceof Error) { return fail(agent); }
			const prompt = optionalString(args, 'prompt', PARADIS_AGENT_IDE_MAX_INPUT_LENGTH);
			const space = optionalString(args, 'space', 4096);
			const model = optionalString(args, 'model', 128);
			const effort = optionalString(args, 'effort', 64);
			for (const value of [prompt, space, model, effort]) {
				if (value instanceof Error) { return fail(value); }
			}
			return {
				kind: 'window', action: true, request: {
					op: 'launchAgent', agent,
					...(prompt !== undefined ? { prompt: paradisAgentIdeSanitizeInput(prompt as string) } : {}),
					...(space !== undefined ? { space: space as string } : {}),
					...(model !== undefined ? { model: model as string } : {}),
					...(effort !== undefined ? { effort: effort as string } : {}),
				},
			};
		}
		case 'create_terminal': {
			const space = optionalString(args, 'space', 4096);
			if (space instanceof Error) { return fail(space); }
			return { kind: 'window', action: true, request: { op: 'createTerminal', ...(space !== undefined ? { space } : {}) } };
		}
		case 'create_space': {
			const repository = optionalString(args, 'repository', 4096);
			const spaceName = optionalString(args, 'name', 100);
			const branch = optionalString(args, 'branch', 100);
			const baseBranch = optionalString(args, 'base_branch', 200);
			const prompt = optionalString(args, 'prompt', PARADIS_AGENT_IDE_MAX_INPUT_LENGTH);
			const agent = optionalString(args, 'agent', 64);
			const model = optionalString(args, 'model', 128);
			const effort = optionalString(args, 'effort', 64);
			for (const value of [repository, spaceName, branch, baseBranch, prompt, agent, model, effort]) {
				if (value instanceof Error) { return fail(value); }
			}
			if (args.run_setup !== undefined && typeof args.run_setup !== 'boolean') {
				return { kind: 'error', error: '"run_setup" must be a boolean.' };
			}
			const pick = (key: string, value: string | Error | undefined) => value !== undefined ? { [key]: value as string } : {};
			return {
				kind: 'window', action: true, request: {
					op: 'createSpace',
					...pick('repository', repository),
					...pick('name', spaceName),
					...pick('branch', branch),
					...pick('baseBranch', baseBranch),
					...(prompt !== undefined ? { prompt: paradisAgentIdeSanitizeInput(prompt as string) } : {}),
					...pick('agent', agent),
					...pick('model', model),
					...pick('effort', effort),
					...(typeof args.run_setup === 'boolean' ? { runSetup: args.run_setup } : {}),
				},
			};
		}
		case 'close_terminal': {
			const id = terminal();
			if (id instanceof Error) { return fail(id); }
			return { kind: 'window', action: true, request: { op: 'closeTerminal', terminal: id } };
		}
		case 'remove_space': {
			const space = requiredString(args, 'space', 4096);
			if (space instanceof Error) { return fail(space); }
			return { kind: 'window', action: true, request: { op: 'removeSpace', space } };
		}
		default:
			return { kind: 'error', error: `Unknown tool: ${name}` };
	}
}
