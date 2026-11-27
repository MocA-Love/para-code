/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP へ、どのペインのエージェントからでも Bot を管理する道具（list_bots ほか 6 つ）を足すプロバイダ。
// 守りの決まりは common/paradisBotManageTools.ts の冒頭。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, paradisMcpToolError as toolError, paradisMcpToolJson as toolJson } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE } from '../../agentIde/common/paradisAgentIde.js';
import { isPlainRecord } from '../../../common/paradisGuards.js';
import {
	PARADIS_BOT_CREATE_TOOL,
	PARADIS_BOT_LIST_TOOL,
	PARADIS_BOT_MANAGE_INSTRUCTIONS,
	PARADIS_BOT_MANAGE_TOOL_NAMES,
	PARADIS_BOT_MANAGE_TOOLS,
	PARADIS_BOT_REMOVE_TOOL,
	PARADIS_BOT_START_TOOL,
	PARADIS_BOT_STOP_TOOL,
	paradisBotChangeRequest,
	paradisBotManageRow,
	paradisBotUpdateNeedsConfirmation,
	PARADIS_BOT_SCHEDULE_TASK_TOOL,
	paradisParseBotCreateArgs,
	paradisParseBotRefArgs,
	paradisParseBotUpdateArgs,
} from '../common/paradisBotManageTools.js';
import { IParadisBot } from '../common/paradisBots.js';
import { PARADIS_BOTS_ENABLED_SETTING, PARADIS_BOTS_WINDOW_CHANNEL, ParadisBotsServiceResult, ParadisBotsWindowResult } from '../common/paradisBotsApi.js';
import { PARADIS_READ_ONLY_MCP_TOOL_NAMES } from '../../agentBrowser/common/paradisMcpReadOnlyTools.js';
import { PARADIS_BOT_PATROL_TOOLS } from '../common/paradisBotTools.js';
import { PARADIS_CREATE_SCHEDULED_RUN_TOOL } from '../../scheduledRuns/common/paradisScheduledRunTools.js';
import { ParadisBotsService } from './paradisBotsService.js';

const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so it refuses changes to bots. This always happens for agents connected over SSH.';
const READ_CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane, so it refuses the request. Start this agent CLI from a terminal inside Para Code.';
const FROM_BOT_MESSAGE = 'This terminal is a Para Code bot. A bot cannot create, change, start, stop or remove bots (including itself); only the user or an agent outside the bots can. Tell your owner what you would change.';
const BOTS_DISABLED_MESSAGE = `Para Code bots are still experimental and turned off. The user can turn them on with the setting ${PARADIS_BOTS_ENABLED_SETTING}; do not try to change the setting yourself.`;
const UNKNOWN_BOT_MESSAGE = 'There is no bot with that id. Call list_bots for the ids.';
const IDE_ACTION_FROM_BOT_MESSAGE = 'This terminal is a Para Code bot. A bot cannot start, open, type into or close other terminals, or change spaces, with the IDE tools: a terminal it started would not be a bot and could change bots. The reading tools still work. Tell your owner what you would do.';
const SCHEDULE_FROM_BOT_MESSAGE = 'This terminal is a Para Code bot. A bot cannot create scheduled runs: the run would start later in a terminal that is not a bot and could change bots. Tell your owner what you would schedule.';
const FROM_BOARD_TASK_MESSAGE = 'This terminal runs a task board task that a Para Code bot put on the board, so Para Code treats it like the bot: it cannot create, change, start, stop or remove bots. Tell the user what you would change. The mark stays on this terminal; work the user wants to do without it belongs in a new terminal.';
const IDE_ACTION_FROM_BOARD_TASK_MESSAGE = 'This terminal runs a task board task that a Para Code bot put on the board, so Para Code treats it like the bot: it cannot start, open, type into or close other terminals, change spaces, or create scheduled runs. The reading tools still work. Tell the user what you would do. The mark stays on this terminal; work the user wants to do without it belongs in a new terminal.';

const PATROL_WRITE_MESSAGE = 'This is a look-around, which only reads. Para Code refuses every tool that clicks, types, moves, writes, sends or starts something here, even if it is always allowed in your settings. Offer what you would do with bot_suggest.';
const TASK_WRITE_MESSAGE = 'This is a scheduled task that your owner limited to reading (and the web). Para Code refuses every tool that clicks, types, moves, writes, sends or starts something here, even if it is always allowed in your settings. Say in your report what you would do.';

/**
 * Bot の見回りのペインからの para-browser の呼び出しを、読むだけの道具（`PARADIS_READ_ONLY_MCP_TOOL_NAMES`）と見回りの
 * Bot の道具（`PARADIS_BOT_PATROL_TOOLS`。`bot_suggest` ほか）に限る（{@link paradisRegisterMcpCallRefusal} に渡す）。
 * 見回りの起動の引数（`paradisBotPatrolLaunchArgs`）と同じ一覧で、利用者がエージェントの側で常に許可した書く道具も
 * サーバーの側で断る（見回りは誰も見ていない時間に外の文を読むので、読んだ文に誘導されて書かないように）。
 */
export function paradisBotPatrolToolRefusal(service: Pick<ParadisBotsService, 'ready' | 'botOfPane' | 'purposeOfPane' | 'isReadOnlyPane'>): (paneToken: string, toolName: string) => Promise<string | undefined> {
	return async (paneToken, toolName) => {
		if (PARADIS_READ_ONLY_MCP_TOOL_NAMES.has(toolName) || PARADIS_BOT_PATROL_TOOLS.has(toolName)) {
			return undefined;
		}
		await service.ready;
		// 起動し直した後に初めて現れたペインの結び付けを戻してから、用途を引く
		if (service.botOfPane(paneToken) === undefined || !service.isReadOnlyPane(paneToken)) {
			return undefined;
		}
		return service.purposeOfPane(paneToken) === 'patrol' ? PATROL_WRITE_MESSAGE : TASK_WRITE_MESSAGE;
	};
}

/**
 * IDE の操作の道具（launch_agent・create_terminal・send_terminal_input ほか）と、後で別のペインを起こす道具
 * （create_scheduled_run）を、Bot のペインと、Bot が載せたタスクのためにボードが動かしたペインからは断る
 * （{@link paradisRegisterAgentIdeActionRefusal} に渡す）。Bot が Bot でないペインを起こす・動かして、そこから
 * Bot を変える道具を呼ぶ穴を塞ぐ。
 */
export function paradisBotIdeActionRefusal(service: Pick<ParadisBotsService, 'ready' | 'botOfPane' | 'boardOriginOfPane'>): (paneToken: string, toolName: string) => Promise<string | undefined> {
	return async (paneToken, toolName) => {
		// 起動の直後は結び付けの表を読み終えていないので、待ってから引く（待たないと門が開いたままになる）
		await service.ready;
		if (service.botOfPane(paneToken) !== undefined) {
			return toolName === PARADIS_CREATE_SCHEDULED_RUN_TOOL ? SCHEDULE_FROM_BOT_MESSAGE : IDE_ACTION_FROM_BOT_MESSAGE;
		}
		return service.boardOriginOfPane(paneToken) !== undefined ? IDE_ACTION_FROM_BOARD_TASK_MESSAGE : undefined;
	};
}
/** 起動はターミナルの起動とエージェントの立ち上がりを待つ。 */
const START_TIMEOUT_MS = 60_000;

/** 書く道具を許すか（IDE 系の書く道具と同じ設定）。 */
export interface IParadisBotManageSettings {
	actionsEnabled(): boolean;
	/** Bot の機能（試験中）。オフのときは読む道具も断る。 */
	botsEnabled(): boolean;
	/**
	 * Bot の定期実行を作る（定期実行のサービスの `setBotTask` をエージェントの印付きで呼ぶ。無効で作られ、利用者が有効にする）。
	 * 無ければ schedule_bot_task は断る。
	 */
	scheduleTask?(botId: string, input: unknown): Promise<{ readonly ok: boolean; readonly error?: string; readonly definition?: { readonly id: string; readonly name: string } }>;
}

function failure(result: { readonly code: string; readonly message: string }): unknown {
	return toolError(`${result.message} (${result.code})`);
}

export class ParadisBotManageToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'ide';

	constructor(
		private readonly service: ParadisBotsService,
		private readonly settings: IParadisBotManageSettings,
	) { }

	/**
	 * Bot の機能がオンのとき、Bot でも、Bot が載せたタスクのペインでもないペインにだけ出す（オフの利用者の全ペインの
	 * 一覧と説明を埋めない。Bot のペインはどうせ書く道具を断られる）。出さなくても、呼ばれたときの門（callTool）はそのまま。
	 */
	private shownTo(paneToken: string | undefined): boolean {
		return this.settings.botsEnabled() && paneToken !== undefined && paneToken.length > 0 && this.service.botOfPane(paneToken) === undefined && this.service.boardOriginOfPane(paneToken) === undefined;
	}

	listTools(paneToken?: string): readonly IParadisMcpToolDefinition[] {
		return this.shownTo(paneToken) ? PARADIS_BOT_MANAGE_TOOLS : [];
	}

	instructions(paneToken?: string): string | undefined {
		return this.shownTo(paneToken) ? PARADIS_BOT_MANAGE_INSTRUCTIONS : undefined;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!PARADIS_BOT_MANAGE_TOOL_NAMES.has(name)) {
			return undefined;
		}
		if (!this.settings.botsEnabled()) {
			return toolError(BOTS_DISABLED_MESSAGE);
		}
		await this.service.ready;
		const write = name !== PARADIS_BOT_LIST_TOOL;
		if (write && !this.settings.actionsEnabled()) {
			return toolError(PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE);
		}
		// トークンだけでは本人と言えないので、接続元のプロセスを確かめる。書くのはそのペインの中のプロセスだけ
		const caller = context ? await context.classifyCaller() : 'unverified';
		if (caller === 'unverified' || (write && caller !== 'pane')) {
			return toolError(write ? CALLER_UNVERIFIED_MESSAGE : READ_CALLER_UNVERIFIED_MESSAGE);
		}
		// Bot のペインからは書かせない（自分や他の Bot の設定を変えて、できることを広げる穴を塞ぐ）
		if (write && this.service.botOfPane(paneToken) !== undefined) {
			return toolError(FROM_BOT_MESSAGE);
		}
		// Bot が載せたタスクのためにボードが動かしたペインも同じ（Bot の書いた指示で動いている）
		if (write && this.service.boardOriginOfPane(paneToken) !== undefined) {
			return toolError(FROM_BOARD_TASK_MESSAGE);
		}
		switch (name) {
			case PARADIS_BOT_LIST_TOOL:
				return toolJson({ bots: this.service.getSnapshot().bots.map(paradisBotManageRow) });
			case PARADIS_BOT_CREATE_TOOL: {
				const parsed = paradisParseBotCreateArgs(args);
				if (!parsed.ok) {
					return toolError(parsed.message);
				}
				const { role, pinned, ...input } = parsed.value;
				const created = await this.service.createBot(input, role);
				// ピン留めは作成の欄に無いので、作った後に変える（画面の作成と同じく、既定は外したまま）
				return this.bot(created.ok && pinned === true ? await this.service.updateBot(created.value.id, { pinned: true }) : created);
			}
			case PARADIS_BOT_SCHEDULE_TASK_TOOL: {
				const input = isPlainRecord(args) ? args : {};
				const botId = typeof input.bot === 'string' ? input.bot : '';
				if (this.service.getBot(botId) === undefined) {
					return toolError(UNKNOWN_BOT_MESSAGE);
				}
				if (this.settings.scheduleTask === undefined) {
					return toolError('Scheduled tasks are not available in this Para Code.');
				}
				const tools = input.tools === undefined ? 'web' : input.tools;
				const result = await this.settings.scheduleTask(botId, { name: typeof input.name === 'string' ? input.name : '', schedule: input.schedule, prompt: input.request, tools, enabled: false });
				return result.ok && result.definition !== undefined
					? toolJson({ bot: botId, task: result.definition.id, name: result.definition.name, enabled: false, note: 'Created turned off. Tell the user to read it and turn it on in the bot\'s settings tab.' })
					: toolError(result.error ?? 'Para Code could not add the scheduled task.');
			}
			default:
				break;
		}
		if (name !== PARADIS_BOT_START_TOOL && name !== PARADIS_BOT_STOP_TOOL && name !== PARADIS_BOT_REMOVE_TOOL) {
			const parsed = paradisParseBotUpdateArgs(args);
			if (!parsed.ok) {
				return toolError(parsed.message);
			}
			const target = this.service.getBot(parsed.value.botId);
			if (target === undefined) {
				return toolError(UNKNOWN_BOT_MESSAGE);
			}
			if (!paradisBotUpdateNeedsConfirmation(target, parsed.value)) {
				return this.bot(await this.service.updateBot(parsed.value.botId, parsed.value.patch));
			}
			// エージェント・権限・役割・名前の変更と、一時停止を解くのは、利用者の確認を通す（確認されたらウィンドウが呼び出し全体を当てる）
			if (!context) {
				return toolError('This Para Code build cannot route bot tools to its window. Update Para Code.');
			}
			return this.askWindow(name, 'confirmChange', [paneToken, paradisBotChangeRequest(target, parsed.value)], context, signal, { bot: target.id },
				'Para Code asked the user to confirm the change. It is applied only if they agree; call list_bots later to see the result.');
		}
		const ref = paradisParseBotRefArgs(name, args);
		if (!ref.ok) {
			return toolError(ref.message);
		}
		const bot = this.service.getBot(ref.value);
		if (bot === undefined) {
			return toolError(UNKNOWN_BOT_MESSAGE);
		}
		if (name === PARADIS_BOT_STOP_TOOL) {
			return toolJson({ bot: bot.id, stopped: this.service.requestStop(bot.id) });
		}
		if (!context) {
			return toolError('This Para Code build cannot route bot tools to its window. Update Para Code.');
		}
		return name === PARADIS_BOT_START_TOOL
			? this.askWindow(name, 'start', [paneToken, bot.id], context, signal, { bot: bot.id })
			: this.askWindow(name, 'confirmRemove', [paneToken, bot.id, bot.name], context, signal, { bot: bot.id },
				'Para Code asked the user to confirm the removal. The bot is removed only if they agree; call list_bots later to see the result.');
	}

	private async askWindow(name: string, method: 'start' | 'confirmRemove' | 'confirmChange', args: unknown[], context: IParadisMcpToolCallContext, signal: AbortSignal | undefined, head: object, note?: string): Promise<unknown> {
		const start = method === 'start';
		const call = await context.callOwningWindow<ParadisBotsWindowResult>({
			channelName: PARADIS_BOTS_WINDOW_CHANNEL,
			method,
			args,
			failureLabel: name,
			failureMessage: start
				? 'Para Code did not finish starting the bot in time, or failed. Call list_bots before trying again, so that you do not start it twice.'
				: `Para Code failed to run ${name} in its window. Retry once; if it keeps failing, tell the user.`,
			...(start ? { timeoutMs: START_TIMEOUT_MS } : {}),
		}, signal);
		if (!call.ok) {
			return toolError(call.error);
		}
		const value = call.value;
		if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') {
			return toolError(`Para Code returned an unexpected response for ${name}.`);
		}
		if (!value.ok) {
			return toolError(value.error);
		}
		return toolJson({ ...head, ...value.data, ...(note !== undefined ? { note } : {}) });
	}

	private bot(result: ParadisBotsServiceResult<IParadisBot>): unknown {
		if (!result.ok) {
			return failure(result);
		}
		const summary = this.service.getSnapshot().bots.find(bot => bot.id === result.value.id);
		return toolJson(summary !== undefined ? paradisBotManageRow(summary) : { id: result.value.id, name: result.value.name });
	}
}
