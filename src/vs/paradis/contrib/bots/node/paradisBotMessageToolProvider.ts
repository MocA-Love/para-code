/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP へ、Bot 同士の伝言の道具（bot_tell・bot_ask）を足すプロバイダ。
//
// 送り手は引数で受けず、呼び出し元のペインの結び付けから引く（bot_item_* と同じ）。通すのは、Bot の機能が
// オンで、会話のペイン（見回りは読むだけ）で、接続元がそのペインの中のプロセスだと確かめられ、Bot が一時停止して
// おらず、宛先が同じグループのメンバーのときだけ。順番は グループの記録 → 宛先のペインを持つウィンドウへ届ける。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider, paradisMcpToolError as toolError, paradisMcpToolJson as toolJson } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	IParadisBotGroupsPort,
	PARADIS_BOT_ASK_TOOL,
	PARADIS_BOT_GROUPS_WINDOW_CHANNEL,
	PARADIS_BOT_MESSAGE_TOOL_NAMES,
	PARADIS_BOT_MESSAGE_TOOLS,
	paradisBotMessageDeliveryText,
	paradisBotMessageTarget,
	paradisParseBotMessageArgs,
} from '../common/paradisBotMessages.js';
import { ParadisBotsService } from './paradisBotsService.js';

let groupsPort: IParadisBotGroupsPort | undefined;

/** グループの機能が shared process で口を差し込む。返した IDisposable で外す。 */
export function paradisRegisterBotGroupsPort(port: IParadisBotGroupsPort): IDisposable {
	groupsPort = port;
	return toDisposable(() => {
		if (groupsPort === port) {
			groupsPort = undefined;
		}
	});
}

/** 今のグループの機能の口（まだ無ければ undefined）。 */
export function paradisBotGroupsPort(): IParadisBotGroupsPort | undefined {
	return groupsPort;
}

const BOTS_DISABLED_MESSAGE = 'Para Code bots are turned off in this Para Code (the setting paradis.bots.enabled), so bot messages are not sent. Tell your owner in your reply.';
const NOT_A_BOT_MESSAGE = 'This terminal is not a Para Code bot, so it cannot send bot messages.';
const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside the bot\'s own terminal pane, so it does not send the message. This happens inside tmux, screen, zellij, WSL or a container.';
const PATROL_MESSAGE = 'This is a look-around, which only reads. Do not send messages here; offer what is worth doing with bot_suggest.';
const PAUSED_MESSAGE = 'Your owner paused this bot, so Para Code does not send its messages. Tell your owner in your reply and end your turn.';
const NO_GROUPS_MESSAGE = 'Bot groups are not available in this Para Code, so there is no one to send this to.';

export class ParadisBotMessageToolProvider implements IParadisMcpToolProvider {
	readonly cliGroup = 'ide';

	/**
	 * @param enabled Bot の機能（`paradis.bots.enabled`）がオンか
	 * @param groups グループの機能の口（テストで差し替える）
	 */
	constructor(
		private readonly service: ParadisBotsService,
		private readonly enabled: () => boolean,
		private readonly groups: () => IParadisBotGroupsPort | undefined = paradisBotGroupsPort,
	) { }

	/** 会話の Bot のペインで、ほかのメンバーのいるグループに入っているときだけ出す。 */
	listTools(paneToken?: string): readonly IParadisMcpToolDefinition[] {
		if (!this.enabled() || paneToken === undefined || paneToken.length === 0 || this.service.purposeOfPane(paneToken) !== 'chat') {
			return [];
		}
		const bot = this.service.botOfPane(paneToken);
		const groups = this.groups();
		return bot !== undefined && groups !== undefined && groups.groupsOf(bot.id).some(group => group.memberIds.some(memberId => memberId !== bot.id)) ? PARADIS_BOT_MESSAGE_TOOLS : [];
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (!PARADIS_BOT_MESSAGE_TOOL_NAMES.has(name)) {
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
		const parsed = paradisParseBotMessageArgs(name, args);
		if (!parsed.ok) {
			return toolError(parsed.message);
		}
		const groups = this.groups();
		if (groups === undefined) {
			return toolError(NO_GROUPS_MESSAGE);
		}
		const target = paradisBotMessageTarget(bot.id, parsed.value.to, groups.groupsOf(bot.id), botId => this.service.getBot(botId)?.name);
		if (!target.ok) {
			return toolError(target.message);
		}
		const recipient = this.service.getBot(target.botId)!;
		if (recipient.paused) {
			return toolError(`Your owner paused "${recipient.name}", so it does not take messages now.`);
		}
		const kind = name === PARADIS_BOT_ASK_TOOL ? 'asked' : 'told';
		const recorded = await groups.appendRecord(target.groupId, { kind, from: bot.id, to: recipient.id, text: parsed.value.text });
		if (!recorded.ok) {
			return toolError(recorded.message ?? 'Para Code could not record this message in the group.');
		}
		const delivered = await context.callOwningWindow<string | undefined>({
			channelName: PARADIS_BOT_GROUPS_WINDOW_CHANNEL,
			method: 'deliver',
			args: [paneToken, recipient.id, paradisBotMessageDeliveryText(kind, bot.name, parsed.value.text)],
			failureLabel: name,
			failureMessage: `Para Code recorded the message in the group but could not deliver it to "${recipient.name}". Do not send it again; tell your owner if it matters.`,
		}, signal);
		if (!delivered.ok) {
			return toolError(delivered.error);
		}
		if (typeof delivered.value === 'string' && delivered.value.length > 0) {
			return toolError(`Para Code recorded the message in the group but could not deliver it to "${recipient.name}": ${delivered.value.slice(0, 300)}`);
		}
		return toolJson({ to: recipient.name, sent: kind === 'asked' ? 'question' : 'message', ...(kind === 'asked' ? { note: `The answer comes back to this terminal as a message from "${recipient.name}".` } : {}) });
	}
}
