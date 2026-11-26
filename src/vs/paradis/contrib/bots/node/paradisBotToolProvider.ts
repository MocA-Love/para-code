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
	PARADIS_BOT_TOOL_NAMES,
	PARADIS_BOT_TOOLS,
	paradisBotItemListRow,
	paradisBotItemView,
	paradisParseBotItemAddArgs,
	paradisParseBotItemListArgs,
	paradisParseBotItemShowArgs,
	paradisParseBotItemUpdateArgs,
} from '../common/paradisBotTools.js';
import { ParadisBotsService } from './paradisBotsService.js';

const NOT_A_BOT_MESSAGE = 'This terminal is not a Para Code bot, so the bot item tools do nothing here. Only a terminal that Para Code started for a bot can use them.';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside the bot\'s own terminal pane, so it does not read or change the bot\'s items. This happens inside tmux, screen, zellij, WSL or a container.';
const BOTS_DISABLED_MESSAGE = 'Para Code bots are turned off in this Para Code (the setting paradis.bots.enabled), so the bot item tools do nothing. Tell your owner in your reply.';
const PAUSED_MESSAGE = 'Your owner paused this bot, so Para Code does not change its items. Tell your owner in your reply and end your turn.';

function failure(result: { readonly code: string; readonly message: string }): unknown {
	return toolError(`${result.message} (${result.code})`);
}

export class ParadisBotToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'ide';

	/**
	 * @param enabled Bot の機能（試験中の設定 `paradis.bots.enabled`）がオンか。オフなら道具も説明も出さない
	 */
	constructor(
		private readonly service: ParadisBotsService,
		private readonly enabled: () => boolean = () => true,
	) { }

	/** Bot として起動されたペインにだけ出す（ほかのペインの道具の一覧と説明を Bot の道具で埋めない）。 */
	private shownTo(paneToken: string | undefined): boolean {
		return this.enabled() && paneToken !== undefined && paneToken.length > 0 && this.service.botOfPane(paneToken) !== undefined;
	}

	listTools(paneToken?: string): readonly IParadisMcpToolDefinition[] {
		return this.shownTo(paneToken) ? PARADIS_BOT_TOOLS : [];
	}

	instructions(paneToken?: string): string | undefined {
		return this.shownTo(paneToken) ? PARADIS_BOT_SERVER_INSTRUCTIONS : undefined;
	}

	async callTool(paneToken: string, name: string, args: unknown, _signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!PARADIS_BOT_TOOL_NAMES.has(name)) {
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
				const deliverable = this.service.itemsWritable();
				return toolJson({ bot: bot.name, items: page.map(item => paradisBotItemListRow(item, deliverable)), ...(next < all.length ? { next_cursor: next } : {}) });
			}
			case PARADIS_BOT_ITEM_SHOW_TOOL: {
				const parsed = paradisParseBotItemShowArgs(args);
				if (!parsed.ok) {
					return toolError(parsed.message);
				}
				const result = await this.service.botReadItem(bot.id, parsed.value.number);
				return result.ok ? toolJson(paradisBotItemView(result.value, parsed.value.after, this.service.itemsWritable())) : failure(result);
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
