/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot が自分の項目をタスクボードへ載せる道具（bot_board_add_task）の定義と、引数の検め・返事の文（副作用なし）。
//
// 載せるのは動いている手元のボードの未着手だけ（ボードを起こさない・窓を出さない）。載せたタスクには出どころ
// （Bot の名前と項目の番号）の札が付き、項目にはそのタスクを結ぶ。ボードのエージェントの工程の報告は、この結び付けと
// 照合して項目へ写す。

import { IParadisMcpToolDefinition } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { TASK_BOARD_ADD_TASK_LIMITS, TaskBoardAddTaskResult } from '../../taskBoard/common/paradisTaskBoard.js';

export const PARADIS_BOT_BOARD_ADD_TASK_TOOL = 'bot_board_add_task';
export const PARADIS_BOT_BOARD_TOOL_NAMES: ReadonlySet<string> = new Set([PARADIS_BOT_BOARD_ADD_TASK_TOOL]);

/**
 * Bot ごとの上限（項目ごとの上限 `PARADIS_BOT_ITEM_LIMITS.boardTasks` とは別）。1 つの Bot がボードを埋めないように、
 * まだ閉じていない自分の項目に結んだタスクの数と、1 時間あたりに載せる数を数える。
 */
export const PARADIS_BOT_BOARD_LIMITS = Object.freeze({ openTasks: 20, perHour: 10 });

export const PARADIS_BOT_BOARD_TOOLS: readonly IParadisMcpToolDefinition[] = [
	{
		name: PARADIS_BOT_BOARD_ADD_TASK_TOOL,
		description: `Para Code bots only. Put one of your open items on the Para Code task board as a new to-do task. Your owner starts it from the board, and the board's flow (an agent in a workspace) does the work. The board agent gets only the title (with the board's own step instructions); the body is shown on the card for people to read. The task shows which bot and item it came from, and the item gets a link to it. Only works while your owner has the task board open on this computer. Up to ${PARADIS_BOT_BOARD_LIMITS.perHour} an hour and ${PARADIS_BOT_BOARD_LIMITS.openTasks} on your open items. You see the board agent's step reports as comments on the item; a report is not the end of the task, so check the work before you close the item.`,
		inputSchema: {
			type: 'object',
			properties: {
				number: { type: 'integer', minimum: 1, description: 'The number of your item (e.g. 35 for #35).' },
				title: { type: 'string', maxLength: TASK_BOARD_ADD_TASK_LIMITS.title, description: 'The task title. Defaults to the item title.' },
				body: { type: 'string', maxLength: TASK_BOARD_ADD_TASK_LIMITS.body, description: 'A description shown on the card for your owner (the board agent does not see it). Defaults to the item description.' },
			},
			required: ['number'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
];

export interface IParadisBotBoardAddTaskArgs {
	readonly number: number;
	readonly title?: string;
	readonly body?: string;
}

export type ParadisBotBoardAddTaskArgs =
	| { readonly ok: true; readonly value: IParadisBotBoardAddTaskArgs }
	| { readonly ok: false; readonly message: string };

/** 引数を検める。知らない引数（`bot_id` など）は断る。長すぎる文は切らずに断る。 */
export function paradisParseBotBoardAddTaskArgs(args: unknown): ParadisBotBoardAddTaskArgs {
	if (!isRecord(args) || Object.keys(args).some(key => key !== 'number' && key !== 'title' && key !== 'body')) {
		return { ok: false, message: `${PARADIS_BOT_BOARD_ADD_TASK_TOOL} takes "number", and optionally "title" and "body".` };
	}
	const { number, title, body } = args;
	if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
		return { ok: false, message: '"number" must be the number of one of your items.' };
	}
	if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0 || title.length > TASK_BOARD_ADD_TASK_LIMITS.title)) {
		return { ok: false, message: `"title" must be text of 1 to ${TASK_BOARD_ADD_TASK_LIMITS.title} characters.` };
	}
	if (body !== undefined && (typeof body !== 'string' || body.length > TASK_BOARD_ADD_TASK_LIMITS.body)) {
		return { ok: false, message: `"body" must be text of up to ${TASK_BOARD_ADD_TASK_LIMITS.body} characters.` };
	}
	return { ok: true, value: { number, ...(title !== undefined ? { title } : {}), ...(body !== undefined && body.trim().length > 0 ? { body } : {}) } };
}

/** ボードが載せなかった理由を、Bot が持ち主へ伝えられる文にする。 */
export function paradisBotBoardRefusalMessage(result: Exclude<TaskBoardAddTaskResult, { readonly ok: true }>): string {
	switch (result.reason) {
		case 'not-running':
			return 'The Para Code task board is not open, so the task was not added. Ask your owner to open the task board, then try again.';
		case 'remote':
			return 'The open task board belongs to an SSH window, so the task was not added. Bots only put tasks on the task board of this computer.';
		default:
			return `The task board did not confirm that it added the task${result.message ? ` (${result.message.slice(0, 200)})` : ''}, so it may or may not be on the board. Tell your owner in your reply instead of trying again.`;
	}
}
