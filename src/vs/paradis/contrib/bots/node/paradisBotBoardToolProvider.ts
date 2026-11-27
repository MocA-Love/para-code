/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP へ、Bot が自分の項目をタスクボードへ載せる道具（bot_board_add_task）を足すプロバイダ。
//
// どの Bot かは引数で受けず、呼び出し元のペインの結び付けから引く（bot_item_* と同じ）。通すのは、Bot の機能が
// オンで、会話のペイン（見回りは読むだけ）で、接続元がそのペインの中のプロセスだと確かめられ、Bot が一時停止して
// おらず、自分の開いている項目のときだけ。順番は ボードへ載せる → 項目へ結ぶ。結べなかったら、載ったことを返事に出す。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, paradisMcpToolError as toolError, paradisMcpToolJson as toolJson } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import type { ITaskBoardAddTaskRequest, TaskBoardAddTaskResult } from '../../taskBoard/common/paradisTaskBoard.js';
import { PARADIS_BOT_BOARD_TOOL_NAMES, PARADIS_BOT_BOARD_TOOLS, paradisBotBoardRefusalMessage, paradisParseBotBoardAddTaskArgs } from '../common/paradisBotBoard.js';
import { PARADIS_BOT_ITEM_LIMITS, paradisBotItemBoardTaskCount, paradisIsBotItemClosed } from '../common/paradisBotItems.js';
import { ParadisBotsService } from './paradisBotsService.js';

const BOTS_DISABLED_MESSAGE = 'Para Code bots are turned off in this Para Code (the setting paradis.bots.enabled), so nothing was put on the task board. Tell your owner in your reply.';
const NOT_A_BOT_MESSAGE = 'This terminal is not a Para Code bot, so it cannot put tasks on the task board.';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside the bot\'s own terminal pane, so it does not put the task on the board. This happens inside tmux, screen, zellij, WSL or a container.';
const PATROL_MESSAGE = 'This is a look-around, which only reads. Do not put tasks on the board here; offer it with bot_suggest.';
const PAUSED_MESSAGE = 'Your owner paused this bot, so Para Code does not put its tasks on the board. Tell your owner in your reply and end your turn.';
const BUSY_MESSAGE = 'Para Code is already putting this item on the task board. Wait for that answer instead of calling again.';

/** ボードへタスクを載せる口（shared process から main のボードの host へ）。 */
export type ParadisBotBoardAddTask = (request: ITaskBoardAddTaskRequest) => Promise<TaskBoardAddTaskResult>;

export class ParadisBotBoardToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'ide';

	/** ボードへ載せている最中の項目（同じ項目を重ねて載せない）。 */
	private readonly adding = new Set<string>();

	/**
	 * @param enabled Bot の機能（`paradis.bots.enabled`）がオンか
	 * @param addTask ボードへタスクを載せる口
	 */
	constructor(
		private readonly service: ParadisBotsService,
		private readonly enabled: () => boolean,
		private readonly addTask: ParadisBotBoardAddTask,
	) { }

	/** 会話の Bot のペインにだけ出す。 */
	listTools(paneToken?: string): readonly IParadisMcpToolDefinition[] {
		return this.enabled() && paneToken !== undefined && paneToken.length > 0 && this.service.botOfPane(paneToken) !== undefined && this.service.purposeOfPane(paneToken) === 'chat' ? PARADIS_BOT_BOARD_TOOLS : [];
	}

	async callTool(paneToken: string, name: string, args: unknown, _signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!PARADIS_BOT_BOARD_TOOL_NAMES.has(name)) {
			return undefined;
		}
		if (!this.enabled()) {
			return toolError(BOTS_DISABLED_MESSAGE);
		}
		await this.service.ready;
		if (this.service.botOfPane(paneToken) === undefined) {
			return toolError(NOT_A_BOT_MESSAGE);
		}
		if (!context || await context.classifyCaller() !== 'pane') {
			return toolError(CALLER_UNVERIFIED_MESSAGE);
		}
		// 接続元を確かめている間に、Bot を消した・止めた・結び付けが外れたかもしれないので引き直す
		const bot = this.service.botOfPane(paneToken);
		if (bot === undefined) {
			return toolError(NOT_A_BOT_MESSAGE);
		}
		if (this.service.purposeOfPane(paneToken) === 'patrol') {
			return toolError(PATROL_MESSAGE);
		}
		if (bot.paused) {
			return toolError(PAUSED_MESSAGE);
		}
		const parsed = paradisParseBotBoardAddTaskArgs(args);
		if (!parsed.ok) {
			return toolError(parsed.message);
		}
		const item = this.service.listItems({ botId: bot.id }).find(candidate => candidate.number === parsed.value.number);
		if (item === undefined) {
			return toolError(`You have no item #${parsed.value.number}.`);
		}
		if (paradisIsBotItemClosed(item)) {
			return toolError(`Item #${item.number} is closed. Reopen it first if there is work left.`);
		}
		if (!this.service.itemsWritable()) {
			return toolError('The items were written by a newer Para Code, so this version does not change them.');
		}
		if (paradisBotItemBoardTaskCount(item) >= PARADIS_BOT_ITEM_LIMITS.boardTasks) {
			return toolError(`Item #${item.number} already has ${PARADIS_BOT_ITEM_LIMITS.boardTasks} task board tasks. Finish or close those first.`);
		}
		if (this.adding.has(item.uid)) {
			return toolError(BUSY_MESSAGE);
		}
		this.adding.add(item.uid);
		try {
			const title = parsed.value.title ?? item.title;
			const body = parsed.value.body ?? item.description;
			const result = await this.addTask({ title, ...(body !== undefined ? { body } : {}), origin: { kind: 'bot', botId: bot.id, botName: bot.name, itemNumber: item.number } });
			if (!result.ok) {
				return toolError(paradisBotBoardRefusalMessage(result));
			}
			// ボードがこのタスクを動かすペインに「Bot が起こした」印を付けるため、項目へ結ぶ前に控える（結べなくても残す）
			await this.service.noteBotBoardTask(bot.id, result.taskId);
			const linked = await this.service.linkBoardTask(bot.id, item.uid, result.taskId);
			if (!linked.ok) {
				return toolError(`The task board added the task (${result.taskId}), but Para Code could not link it to item #${item.number}: ${linked.message} Do not add it again; tell your owner.`);
			}
			return toolJson({ item: item.number, task: result.taskId, note: 'The task waits in the to-do column of the task board. Its step reports appear as comments on your item.' });
		} catch (error) {
			return toolError(`Para Code could not reach the task board, so the task may not have been added. Tell your owner instead of calling again. (${String(error).slice(0, 200)})`);
		} finally {
			this.adding.delete(item.uid);
		}
	}
}
