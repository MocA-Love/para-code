/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の定期実行の道具（create_scheduled_run）の定義と引数の検証。
//
// エージェントが作れるのは「無効の」定期実行だけ（shared process が作成直後を必ず無効にする）。利用者が
// 中身（指示・事前確認のコマンド・時刻）を画面で確かめて、自分で有効にするまで動かない。権限は選ばせず
// エージェントの既定にする（確認なしで動かす権限は利用者が画面で選ぶ）。

import { IParadisMcpToolDefinition } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { isRecord } from '../../../common/paradisGuards.js';
import {
	PARADIS_SCHEDULED_RUN_DEFAULT_DAILY_LIMIT,
	PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT,
	PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH,
	PARADIS_SCHEDULED_RUN_MAX_PROMPT_LENGTH,
	PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES,
	PARADIS_SCHEDULED_RUN_PRECHECK_DEFAULT_TIMEOUT_SECONDS,
	PARADIS_SCHEDULED_RUN_PRECHECK_MAX_COMMAND_LENGTH,
	PARADIS_SCHEDULED_RUN_PRECHECK_MAX_TIMEOUT_SECONDS,
} from './paradisScheduledRuns.js';

export const PARADIS_CREATE_SCHEDULED_RUN_TOOL = 'create_scheduled_run';
/** 呼び出し元ペインのウィンドウの受け口。 */
export const PARADIS_SCHEDULED_RUNS_MCP_CHANNEL = 'paradisScheduledRunsMcp';
export const PARADIS_SCHEDULED_RUNS_MCP_METHOD = 'create';
/** 定期実行の画面を開くコマンド。 */
export const PARADIS_OPEN_SCHEDULED_RUNS_COMMAND_ID = 'paradis.openScheduledRuns';
/** 1 つのペインが作れる数（この時間あたり）。 */
export const PARADIS_SCHEDULED_RUN_TOOL_CREATE_LIMIT = 5;
export const PARADIS_SCHEDULED_RUN_TOOL_CREATE_WINDOW_MS = 60 * 60_000;

export const PARADIS_SCHEDULED_RUN_TOOLS: readonly IParadisMcpToolDefinition[] = [
	{
		name: PARADIS_CREATE_SCHEDULED_RUN_TOOL,
		description: `Create a Para Code scheduled run: at the times of "schedule", Para Code starts an agent CLI with "prompt" in the repository of this terminal pane. It is created DISABLED: the user reviews it in Para Code (gear menu > 定期実行) and turns it on; tell the user to do that. Safety limits always apply: one run at a time, at most "daily_limit" automatic runs a day, at least ${PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES} minutes apart, each run stopped after 30 minutes. Optional "precheck_command" is a shell command run in the repository before each scheduled run (sh on macOS and Linux, Command Prompt cmd.exe on Windows); the agent starts only when it exits 0 (for example only when there is a new pull request), and its output is not passed to the agent. The agent uses its default model and permission; the user can change them. Para Code marks it as created by an agent and shows the prompt and precheck_command to the user before the first enable.`,
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: `Short name shown to the user (up to ${PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH} characters).` },
				schedule: { type: 'string', description: 'Five-field cron expression in the local time of this computer (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5" for weekdays at 9:00.' },
				prompt: { type: 'string', description: `The instruction the agent receives on each run (up to ${PARADIS_SCHEDULED_RUN_MAX_PROMPT_LENGTH} characters, one line).` },
				agent: { type: 'string', description: 'Agent id from the user\'s Para Code agent list (for example "claude" or "codex"). Omit for the first agent in the list.' },
				target: { type: 'string', enum: ['repository', 'new_space'], description: '"repository" (default) runs in the main checkout of the repository; "new_space" creates a new worktree space for every run.' },
				base_ref: { type: 'string', description: 'For "new_space": the branch to start from. Omit for the current branch.' },
				daily_limit: { type: 'integer', minimum: 1, maximum: PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT, description: `Automatic runs allowed per day (default ${PARADIS_SCHEDULED_RUN_DEFAULT_DAILY_LIMIT}).` },
				precheck_command: { type: 'string', description: `Shell command run before each scheduled run; the run starts only when it exits 0 (up to ${PARADIS_SCHEDULED_RUN_PRECHECK_MAX_COMMAND_LENGTH} characters). Runs with sh on macOS and Linux and with Command Prompt (cmd.exe) on Windows. Only for repositories in a local folder of this computer (not SSH, WSL or network folders).` },
				precheck_timeout_seconds: { type: 'integer', minimum: 1, maximum: PARADIS_SCHEDULED_RUN_PRECHECK_MAX_TIMEOUT_SECONDS, description: `Time limit of precheck_command (default ${PARADIS_SCHEDULED_RUN_PRECHECK_DEFAULT_TIMEOUT_SECONDS}).` },
			},
			required: ['name', 'schedule', 'prompt'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
];

/** ウィンドウへ渡す 1 回の作成（shared process で形を確かめ済み。中身の規則はウィンドウと shared process の保存で見る）。 */
export interface IParadisScheduledRunToolRequest {
	readonly name: string;
	readonly schedule: string;
	readonly prompt: string;
	readonly agent?: string;
	readonly target: 'repository' | 'newSpace';
	readonly baseRef?: string;
	readonly dailyLimit: number;
	readonly precheck?: { readonly command: string; readonly timeoutSeconds: number };
}

/** ウィンドウからの答え。`error` はそのままエージェントへ返す英文。 */
export type ParadisScheduledRunToolResult = { readonly ok: true; readonly data: object } | { readonly ok: false; readonly error: string };

const KNOWN_ARGUMENTS = new Set(['name', 'schedule', 'prompt', 'agent', 'target', 'base_ref', 'daily_limit', 'precheck_command', 'precheck_timeout_seconds']);

/** 引数を確かめて、ウィンドウへ渡す形にする。 */
export function paradisParseCreateScheduledRun(args: unknown): { readonly ok: true; readonly request: IParadisScheduledRunToolRequest } | { readonly ok: false; readonly error: string } {
	if (!isRecord(args)) {
		return { ok: false, error: 'Pass the arguments as an object with "name", "schedule" and "prompt".' };
	}
	const unknown = Object.keys(args).filter(key => !KNOWN_ARGUMENTS.has(key));
	if (unknown.length > 0) {
		return { ok: false, error: `Unknown arguments: ${unknown.join(', ')}. Read the tool description for the accepted arguments.` };
	}
	const text = (key: string, max: number, required: boolean): string | undefined | false => {
		const value = args[key];
		if (value === undefined || value === null || (value === '' && !required)) {
			return required ? false : undefined;
		}
		return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : false;
	};
	const name = text('name', PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH, true);
	if (name === false || name === undefined) {
		return { ok: false, error: `"name" must be a non-empty string of up to ${PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH} characters.` };
	}
	const schedule = text('schedule', 200, true);
	if (schedule === false || schedule === undefined) {
		return { ok: false, error: '"schedule" must be a five-field cron expression such as "0 9 * * 1-5".' };
	}
	const prompt = text('prompt', PARADIS_SCHEDULED_RUN_MAX_PROMPT_LENGTH, true);
	if (prompt === false || prompt === undefined) {
		return { ok: false, error: `"prompt" must be a non-empty string of up to ${PARADIS_SCHEDULED_RUN_MAX_PROMPT_LENGTH} characters.` };
	}
	const agent = text('agent', 200, false);
	if (agent === false) {
		return { ok: false, error: '"agent" must be an agent id such as "claude" or "codex".' };
	}
	const targetArg = args.target ?? 'repository';
	if (targetArg !== 'repository' && targetArg !== 'new_space') {
		return { ok: false, error: '"target" must be "repository" or "new_space".' };
	}
	const baseRef = text('base_ref', 200, false);
	if (baseRef === false || (baseRef !== undefined && targetArg !== 'new_space')) {
		return { ok: false, error: '"base_ref" is a branch name and only applies with "target": "new_space".' };
	}
	const dailyLimit = args.daily_limit ?? PARADIS_SCHEDULED_RUN_DEFAULT_DAILY_LIMIT;
	if (typeof dailyLimit !== 'number' || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT) {
		return { ok: false, error: `"daily_limit" must be an integer from 1 to ${PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT}.` };
	}
	const precheckCommand = text('precheck_command', PARADIS_SCHEDULED_RUN_PRECHECK_MAX_COMMAND_LENGTH, false);
	if (precheckCommand === false) {
		return { ok: false, error: `"precheck_command" must be a shell command of up to ${PARADIS_SCHEDULED_RUN_PRECHECK_MAX_COMMAND_LENGTH} characters.` };
	}
	const timeout = args.precheck_timeout_seconds ?? PARADIS_SCHEDULED_RUN_PRECHECK_DEFAULT_TIMEOUT_SECONDS;
	if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > PARADIS_SCHEDULED_RUN_PRECHECK_MAX_TIMEOUT_SECONDS
		|| (args.precheck_timeout_seconds !== undefined && precheckCommand === undefined)) {
		return { ok: false, error: `"precheck_timeout_seconds" must be an integer from 1 to ${PARADIS_SCHEDULED_RUN_PRECHECK_MAX_TIMEOUT_SECONDS} and needs "precheck_command".` };
	}
	return {
		ok: true,
		request: {
			name: name.trim(),
			schedule: schedule.trim(),
			prompt,
			...(agent !== undefined ? { agent } : {}),
			target: targetArg === 'new_space' ? 'newSpace' : 'repository',
			...(baseRef !== undefined ? { baseRef: baseRef.trim() } : {}),
			dailyLimit,
			...(precheckCommand !== undefined ? { precheck: { command: precheckCommand, timeoutSeconds: timeout } } : {}),
		},
	};
}
