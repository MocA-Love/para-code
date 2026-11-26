/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// どのペインのエージェントからでも Bot を管理する MCP の道具（list_bots・create_bot・update_bot・start_bot・
// stop_bot・remove_bot）の定義と、引数の検め。人が画面でできる操作（作成のモーダル・設定のタブ・帯のメニュー）と
// 1 対 1 に揃える。
//
// 守り（paradisBotManageToolProvider.ts）:
// - 書く道具は、IDE 系の書く道具と同じ設定 `paradis.agentIde.allowActions` がオンで、接続元がそのペインの中の
//   プロセスのときだけ
// - Bot のペインからは、書く道具を全部断る（Bot が自分や他の Bot を作り変え、権限を広げる穴を塞ぐ）
// - 権限（permission）は受けない。作った Bot は利用者の既定の権限で動く（launch_agent と同じ上限）。エージェントの
//   種類と役割（SOUL.md）の書き換えも受けない。どれも利用者が Bot の設定・ファイルのタブで変える
// - 削除は、利用者の確認のダイアログを通す（remove_space と同じ）
// - 顔の色と形は、選べる名前だけ

import { isPlainRecord } from '../../../common/paradisGuards.js';
import type { IParadisMcpToolDefinition } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { PARADIS_AGENT_KINDS, ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisBotPatch, PARADIS_BOT_FACE_COLORS, PARADIS_BOT_FACE_SHAPES, PARADIS_BOT_LIMITS, ParadisBotFaceColor, ParadisBotFaceShape } from './paradisBots.js';
import { IParadisBotSummary } from './paradisBotsApi.js';

export const PARADIS_BOT_LIST_TOOL = 'list_bots';
export const PARADIS_BOT_CREATE_TOOL = 'create_bot';
export const PARADIS_BOT_UPDATE_TOOL = 'update_bot';
export const PARADIS_BOT_START_TOOL = 'start_bot';
export const PARADIS_BOT_STOP_TOOL = 'stop_bot';
export const PARADIS_BOT_REMOVE_TOOL = 'remove_bot';

/** 役割（人格メモの種）の長さ。 */
export const PARADIS_BOT_ROLE_LIMIT = 4000;

const ACTIONS_NOTE = 'Needs the user\'s setting paradis.agentIde.allowActions (off by default; when it is off, the error says where the user turns it on). A Para Code bot cannot use it.';
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const BOT_ARGUMENT = { type: 'string', description: 'The bot id from list_bots.' } as const;
const FACE_PROPERTIES = {
	face_color: { type: 'string', enum: [...PARADIS_BOT_FACE_COLORS], description: 'Colour of the bot\'s face.' },
	face_shape: { type: 'string', enum: [...PARADIS_BOT_FACE_SHAPES], description: 'Shape of the bot\'s face.' },
} as const;
const MODEL_PROPERTIES = {
	model: { type: 'string', description: 'Model id for the agent (as in the agent picker, e.g. "opus" or "gpt-6.2-sol"). Omit for the user\'s default.' },
	effort: { type: 'string', description: 'Reasoning effort id (e.g. "medium"). Omit for the default.' },
} as const;

export const PARADIS_BOT_MANAGE_TOOLS: readonly IParadisMcpToolDefinition[] = [
	{
		name: PARADIS_BOT_LIST_TOOL,
		description: 'List the user\'s Para Code bots: id, name, agent, model, face, whether it is paused or pinned, what it is doing now (stopped, idle, working) and how many of its questions wait for the user.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: READ_ONLY,
	},
	{
		name: PARADIS_BOT_CREATE_TOOL,
		description: `Create a Para Code bot: a named agent with a role and a memory that runs in its own home folder and keeps a list of items for the user. It runs with the user's default permission mode. Start it with start_bot. ${ACTIONS_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', maxLength: PARADIS_BOT_LIMITS.name, description: 'Name shown in the bot list. Must be unique.' },
				role: { type: 'string', maxLength: PARADIS_BOT_ROLE_LIMIT, description: 'What the bot does and when it asks the user, in a few sentences. Becomes its SOUL.md, which the bot reads first.' },
				agent: { type: 'string', enum: [...PARADIS_AGENT_KINDS], description: 'Agent CLI the bot runs.' },
				...MODEL_PROPERTIES,
				...FACE_PROPERTIES,
				pinned: { type: 'boolean', description: 'Keep the bot visible even when the bot list is collapsed.' },
			},
			required: ['name', 'agent'],
			additionalProperties: false,
		},
		annotations: WRITE,
	},
	{
		name: PARADIS_BOT_UPDATE_TOOL,
		description: `Change a bot: its name, model, effort, face, pin, or pause it (a paused bot does not start and its questions leave the user's turn). The agent, the permission mode and the role (SOUL.md) are changed only by the user in the bot's page. ${ACTIONS_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				bot: BOT_ARGUMENT,
				name: { type: 'string', maxLength: PARADIS_BOT_LIMITS.name },
				model: { type: ['string', 'null'], description: 'Model id, or null for the user\'s default.' },
				effort: { type: ['string', 'null'], description: 'Effort id, or null for the default.' },
				...FACE_PROPERTIES,
				pinned: { type: 'boolean' },
				paused: { type: 'boolean' },
			},
			required: ['bot'],
			additionalProperties: false,
		},
		annotations: WRITE,
	},
	{
		name: PARADIS_BOT_START_TOOL,
		description: `Start a bot: open its terminal in the background of the current space of your window, with its agent running in its home folder. Does nothing if it already runs in your window. ${ACTIONS_NOTE}`,
		inputSchema: { type: 'object', properties: { bot: BOT_ARGUMENT }, required: ['bot'], additionalProperties: false },
		annotations: WRITE,
	},
	{
		name: PARADIS_BOT_STOP_TOOL,
		description: `Stop a bot: close its terminals in every window. Its items, home folder and memory stay. ${ACTIONS_NOTE}`,
		inputSchema: { type: 'object', properties: { bot: BOT_ARGUMENT }, required: ['bot'], additionalProperties: false },
		annotations: DESTRUCTIVE,
	},
	{
		name: PARADIS_BOT_REMOVE_TOOL,
		description: `Ask the user to remove a bot. Para Code shows the user a confirmation dialog saying an agent asked for it, and removes the bot (its items too; its home folder stays) only if they agree, so this returns before anything is removed. Only one request can be pending at a time. ${ACTIONS_NOTE}`,
		inputSchema: { type: 'object', properties: { bot: BOT_ARGUMENT }, required: ['bot'], additionalProperties: false },
		annotations: DESTRUCTIVE,
	},
];

export const PARADIS_BOT_MANAGE_TOOL_NAMES: ReadonlySet<string> = new Set(PARADIS_BOT_MANAGE_TOOLS.map(tool => tool.name));

/** MCP の `initialize` の説明と `para help ide` の手引きに足す 1 段。 */
export const PARADIS_BOT_MANAGE_INSTRUCTIONS = 'Bot management tools (list_bots, create_bot, update_bot, start_bot, stop_bot, remove_bot): manage the user\'s Para Code bots when the user asks you to. Changing anything needs the same user setting as the other IDE actions (paradis.agentIde.allowActions); a bot\'s own terminal cannot use them. Bots run with the user\'s default permission mode; only the user changes a bot\'s agent, permission mode or role. remove_bot only asks the user, who confirms it in a dialog.';

export type ParadisBotManageArgs<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function refuse<T>(message: string): ParadisBotManageArgs<T> {
	return { ok: false, message };
}

const UNKNOWN_ARGUMENT = (name: string, allowed: readonly string[]) => `${name} takes only these arguments: ${allowed.join(', ')}.`;

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): string | undefined {
	return Object.keys(args).find(key => !allowed.includes(key));
}

function optionalText(value: unknown, limit: number): string | undefined | false {
	if (value === undefined) {
		return undefined;
	}
	return typeof value === 'string' && value.length <= limit ? value : false;
}

function face(args: Record<string, unknown>): { faceColor?: ParadisBotFaceColor; faceShape?: ParadisBotFaceShape } | false {
	const color = PARADIS_BOT_FACE_COLORS.find(candidate => candidate === args.face_color);
	const shape = PARADIS_BOT_FACE_SHAPES.find(candidate => candidate === args.face_shape);
	if ((args.face_color !== undefined && color === undefined) || (args.face_shape !== undefined && shape === undefined)) {
		return false;
	}
	return { ...(color !== undefined ? { faceColor: color } : {}), ...(shape !== undefined ? { faceShape: shape } : {}) };
}

/** `bot` だけを受ける道具（start_bot・stop_bot・remove_bot）。 */
export function paradisParseBotRefArgs(name: string, value: unknown): ParadisBotManageArgs<string> {
	const args = value === undefined ? {} : value;
	if (!isPlainRecord(args)) {
		return refuse('The arguments must be an object.');
	}
	if (onlyKeys(args, ['bot']) !== undefined) {
		return refuse(UNKNOWN_ARGUMENT(name, ['bot']));
	}
	return typeof args.bot === 'string' && args.bot.length > 0 && args.bot.length <= PARADIS_BOT_LIMITS.id ? { ok: true, value: args.bot } : refuse('Pass the bot id from list_bots as "bot".');
}

export interface IParadisBotCreateArgs {
	readonly name: string;
	readonly agent: ParadisAgentKind;
	readonly role?: string;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly faceColor?: ParadisBotFaceColor;
	readonly faceShape?: ParadisBotFaceShape;
	readonly pinned?: boolean;
}

const CREATE_KEYS = ['name', 'role', 'agent', 'model', 'effort', 'face_color', 'face_shape', 'pinned'];

export function paradisParseBotCreateArgs(value: unknown): ParadisBotManageArgs<IParadisBotCreateArgs> {
	if (!isPlainRecord(value)) {
		return refuse('The arguments must be an object.');
	}
	if (onlyKeys(value, CREATE_KEYS) !== undefined) {
		// 権限（permission）を渡されたときもここで断る。作った Bot は利用者の既定の権限で動く
		return refuse(`${UNKNOWN_ARGUMENT(PARADIS_BOT_CREATE_TOOL, CREATE_KEYS)} A bot runs with the user's default permission mode; only the user changes it.`);
	}
	const agent = PARADIS_AGENT_KINDS.find(kind => kind === value.agent);
	const role = optionalText(value.role, PARADIS_BOT_ROLE_LIMIT);
	const model = optionalText(value.model, PARADIS_BOT_LIMITS.id);
	const effort = optionalText(value.effort, PARADIS_BOT_LIMITS.id);
	const looks = face(value);
	if (typeof value.name !== 'string' || agent === undefined || role === false || model === false || effort === false || looks === false || (value.pinned !== undefined && typeof value.pinned !== 'boolean')) {
		return refuse(`create_bot needs "name" (up to ${PARADIS_BOT_LIMITS.name} characters) and "agent" (${PARADIS_AGENT_KINDS.join(', ')}); "role" is up to ${PARADIS_BOT_ROLE_LIMIT} characters, and the face takes only the listed colours and shapes.`);
	}
	return {
		ok: true,
		value: {
			name: value.name,
			agent,
			...(role !== undefined && role.trim().length > 0 ? { role } : {}),
			...(model ? { modelId: model } : {}),
			...(effort ? { effortId: effort } : {}),
			...looks,
			...(typeof value.pinned === 'boolean' ? { pinned: value.pinned } : {}),
		},
	};
}

const UPDATE_KEYS = ['bot', 'name', 'model', 'effort', 'face_color', 'face_shape', 'pinned', 'paused'];

/** update_bot の引数。台帳の変更（{@link IParadisBotPatch}）にして返す。 */
export function paradisParseBotUpdateArgs(value: unknown): ParadisBotManageArgs<{ readonly botId: string; readonly patch: IParadisBotPatch }> {
	if (!isPlainRecord(value)) {
		return refuse('The arguments must be an object.');
	}
	if (onlyKeys(value, UPDATE_KEYS) !== undefined) {
		return refuse(`${UNKNOWN_ARGUMENT(PARADIS_BOT_UPDATE_TOOL, UPDATE_KEYS)} The agent, the permission mode and the role are changed only by the user in the bot's page.`);
	}
	if (typeof value.bot !== 'string' || value.bot.length === 0) {
		return refuse('Pass the bot id from list_bots as "bot".');
	}
	const looks = face(value);
	if (looks === false) {
		return refuse(`The face takes only these colours: ${PARADIS_BOT_FACE_COLORS.join(', ')}; and these shapes: ${PARADIS_BOT_FACE_SHAPES.join(', ')}.`);
	}
	const patch: IParadisBotPatch = {
		...(value.name !== undefined ? { name: value.name } : {}),
		...(value.model !== undefined ? { modelId: value.model } : {}),
		...(value.effort !== undefined ? { effortId: value.effort } : {}),
		...looks,
		...(value.pinned !== undefined ? { pinned: value.pinned } : {}),
		...(value.paused !== undefined ? { paused: value.paused } : {}),
	};
	if (Object.keys(patch).length === 0) {
		return refuse('update_bot needs at least one change.');
	}
	return { ok: true, value: { botId: value.bot, patch } };
}

/** list_bots の 1 行。 */
export function paradisBotManageRow(bot: IParadisBotSummary): object {
	return {
		id: bot.id,
		name: bot.name,
		agent: bot.agent,
		...(bot.modelId !== undefined ? { model: bot.modelId } : {}),
		...(bot.effortId !== undefined ? { effort: bot.effortId } : {}),
		face_color: bot.faceColor,
		face_shape: bot.faceShape,
		paused: bot.paused,
		pinned: bot.pinned,
		activity: bot.activity,
		needs_user: bot.needsYou,
		open_items: bot.openItems,
	};
}
