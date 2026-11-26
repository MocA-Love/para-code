/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP へ、Bot が自分の作業項目を読み書きする道具（bot_item_*）を足すプロバイダ。
//
// どの Bot として書くかは引数で受けない。呼び出し元のペイントークン（MCP サーバーが検証済み）を、
// Bot のサービスが持つ「ペイン → Bot」の表で引く。表に無いペインは断る。トークンは同じ利用者の別プロセス
// からも読めるので、どの道具も接続元がそのペインの中のプロセスだと確かめられたときだけ通す（Bot は手元の PC
// だけで動くので、SSH の戻り経路からの読み取りも通さない）。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, paradisMcpToolError as toolError, paradisMcpToolJson as toolJson } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { paradisBotAskTip } from '../common/paradisBotAsk.js';
import { ParadisBotsServiceResult } from '../common/paradisBotsApi.js';
import {
	PARADIS_BOT_ITEM_ADD_TOOL,
	PARADIS_BOT_ITEM_LIST_PAGE,
	PARADIS_BOT_ITEM_LIST_TOOL,
	PARADIS_BOT_ITEM_SHOW_TOOL,
	PARADIS_BOT_READ_TOOLS,
	PARADIS_BOT_SERVER_INSTRUCTIONS,
	PARADIS_BOT_SUGGEST_TOOL,
	PARADIS_BOT_TOOL_NAMES,
	PARADIS_BOT_TOOLS,
	paradisBotItemListRow,
	paradisBotItemView,
	paradisParseBotItemAddArgs,
	paradisParseBotItemListArgs,
	paradisParseBotItemShowArgs,
	paradisParseBotItemUpdateArgs,
	paradisParseBotSuggestArgs,
} from '../common/paradisBotTools.js';
import { ParadisBotsService } from './paradisBotsService.js';

const NOT_A_BOT_MESSAGE = 'This terminal is not a Para Code bot, so the bot item tools do nothing here. Only a terminal that Para Code started for a bot can use them.';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside the bot\'s own terminal pane, so it does not read or change the bot\'s items. This happens inside tmux, screen, zellij, WSL or a container.';
const PAUSED_MESSAGE = 'Your owner paused this bot, so Para Code does not change its items. Tell your owner in your reply and end your turn.';

function failure(result: { readonly code: string; readonly message: string }): unknown {
	return toolError(`${result.message} (${result.code})`);
}

export class ParadisBotToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'ide';

	constructor(private readonly service: ParadisBotsService) { }

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_BOT_TOOLS;
	}

	instructions(): string {
		return PARADIS_BOT_SERVER_INSTRUCTIONS;
	}

	async callTool(paneToken: string, name: string, args: unknown, _signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!PARADIS_BOT_TOOL_NAMES.has(name)) {
			return undefined;
		}
		await this.service.ready;
		const bot = this.service.botOfPane(paneToken);
		if (bot === undefined) {
			return toolError(NOT_A_BOT_MESSAGE);
		}
		if (!context || await context.classifyCaller() !== 'pane') {
			return toolError(CALLER_UNVERIFIED_MESSAGE);
		}
		if (bot.paused && !PARADIS_BOT_READ_TOOLS.has(name)) {
			return toolError(PAUSED_MESSAGE);
		}
		switch (name) {
			case PARADIS_BOT_ITEM_LIST_TOOL: {
				const parsed = paradisParseBotItemListArgs(args);
				if (!parsed.ok) {
					return toolError(parsed.message);
				}
				const all = this.service.listItems({ botId: bot.id, ...(parsed.value.all ? {} : { open: true }) });
				const page = all.slice(parsed.value.cursor, parsed.value.cursor + PARADIS_BOT_ITEM_LIST_PAGE);
				const next = parsed.value.cursor + page.length;
				return toolJson({ bot: bot.name, items: page.map(paradisBotItemListRow), ...(next < all.length ? { next_cursor: next } : {}) });
			}
			case PARADIS_BOT_ITEM_SHOW_TOOL: {
				const parsed = paradisParseBotItemShowArgs(args);
				if (!parsed.ok) {
					return toolError(parsed.message);
				}
				const result = await this.service.botReadItem(bot.id, parsed.value.number);
				return result.ok ? toolJson(paradisBotItemView(result.value, parsed.value.after)) : failure(result);
			}
			case PARADIS_BOT_SUGGEST_TOOL: {
				const parsed = paradisParseBotSuggestArgs(args);
				if (!parsed.ok) {
					return toolError(parsed.message);
				}
				const result = await this.service.botSuggest(bot.id, paneToken, parsed.value.title, parsed.value.request);
				return result.ok ? toolJson({ suggested: result.value.title }) : failure(result);
			}
			case PARADIS_BOT_ITEM_ADD_TOOL: {
				const parsed = paradisParseBotItemAddArgs(args);
				if (!parsed.ok) {
					return toolError(parsed.message);
				}
				return this.written(await this.service.botAddItem(bot.id, parsed.value));
			}
			default: {
				const parsed = paradisParseBotItemUpdateArgs(args);
				if (!parsed.ok) {
					return toolError(parsed.message);
				}
				const tip = parsed.value.changes.questions ? paradisBotAskTip(parsed.value.changes.questions) : undefined;
				return this.written(await this.service.botUpdateItem(bot.id, parsed.value.number, parsed.value.changes), tip);
			}
		}
	}

	private written(result: ParadisBotsServiceResult<{ readonly number: number; readonly status: string; readonly lastEventId: number }>, tip?: string): unknown {
		if (!result.ok) {
			return failure(result);
		}
		return toolJson({ number: result.value.number, status: result.value.status, last_event: result.value.lastEventId, ...(tip !== undefined ? { tip } : {}) });
	}
}
