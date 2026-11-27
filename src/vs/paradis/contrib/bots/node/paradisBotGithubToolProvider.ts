/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP へ、Bot が GitHub の新着を読む道具（bot_github_news）を足すプロバイダ。読むだけ（読んだ印も書かない）。
//
// 出すのは、Bot の機能がオンで、GitHub の見張りをオンにした Bot のペイン（会話と見回り）だけ。どの Bot かは引数で受けず、
// ペインの結び付けから引く。接続元がそのペインの中のプロセスだと確かめられなければ断る（bot_item_* と同じ）。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, paradisMcpToolError as toolError, paradisMcpToolJson as toolJson } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisBotGithubNotice, PARADIS_BOT_GITHUB_NEWS_TOOL, PARADIS_BOT_GITHUB_TOOLS, ParadisBotGithubStatus, paradisBotGithubNewsView } from '../common/paradisBotGithub.js';
import { ParadisBotsService } from './paradisBotsService.js';

const BOTS_DISABLED_MESSAGE = 'Para Code bots are turned off in this Para Code (the setting paradis.bots.enabled). Tell your owner in your reply.';
const NOT_A_BOT_MESSAGE = 'This terminal is not a Para Code bot, so it has no GitHub news.';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside the bot\'s own terminal pane, so it does not answer. This happens inside tmux, screen, zellij, WSL or a container.';
const NOT_WATCHING_MESSAGE = 'Your owner has not let you watch GitHub, so Para Code does not read GitHub for you.';

/** 見張りが持っている新着と様子（テストで差し替える）。 */
export interface IParadisBotGithubNewsSource {
	getNotices(): readonly IParadisBotGithubNotice[];
	getStatus(): ParadisBotGithubStatus;
}

export class ParadisBotGithubToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'ide';

	constructor(
		private readonly service: ParadisBotsService,
		private readonly enabled: () => boolean,
		private readonly source: IParadisBotGithubNewsSource,
	) { }

	listTools(paneToken?: string): readonly IParadisMcpToolDefinition[] {
		if (!this.enabled() || paneToken === undefined || paneToken.length === 0) {
			return [];
		}
		return this.service.botOfPane(paneToken)?.watchGithub === true ? PARADIS_BOT_GITHUB_TOOLS : [];
	}

	async callTool(paneToken: string, name: string, args: unknown, _signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (name !== PARADIS_BOT_GITHUB_NEWS_TOOL) {
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
		const bot = this.service.botOfPane(paneToken);
		if (bot === undefined) {
			return toolError(NOT_A_BOT_MESSAGE);
		}
		if (bot.watchGithub !== true) {
			return toolError(NOT_WATCHING_MESSAGE);
		}
		if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 0)) {
			return toolError(`${PARADIS_BOT_GITHUB_NEWS_TOOL} takes no arguments.`);
		}
		return toolJson(paradisBotGithubNewsView(this.source.getNotices(), this.source.getStatus()));
	}
}
