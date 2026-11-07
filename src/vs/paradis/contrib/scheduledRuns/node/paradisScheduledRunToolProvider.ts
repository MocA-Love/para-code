/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP サーバーへ定期実行の道具（create_scheduled_run）を足すプロバイダ。shared process で動く。
// ここでは接続元の確かめ（手元のペインだけ）、引数の形の検証、ペインごとの回数の上限を受け持ち、どのリポジトリで
// 作るか・エージェントの id が正しいかの判断、保存、利用者への通知は呼び出し元ペインのウィンドウ
// （paradisScheduledRunsMcpChannel.ts）が行う。ペインのスペースとエージェントの一覧を知っているのはウィンドウだけのため。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	PARADIS_CREATE_SCHEDULED_RUN_TOOL,
	PARADIS_SCHEDULED_RUN_TOOL_CREATE_LIMIT,
	PARADIS_SCHEDULED_RUN_TOOL_CREATE_WINDOW_MS,
	PARADIS_SCHEDULED_RUN_TOOLS,
	PARADIS_SCHEDULED_RUNS_MCP_CHANNEL,
	PARADIS_SCHEDULED_RUNS_MCP_METHOD,
	ParadisScheduledRunToolResult,
	paradisParseCreateScheduledRun,
} from '../common/paradisScheduledRunTools.js';

const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so it does not create a scheduled run. This happens inside tmux, screen, zellij, WSL or a container, and for agents on an SSH host. Ask the user to create it in Para Code (gear menu > 定期実行).';
const WINDOW_FAILURE_MESSAGE = 'Para Code could not reach the window of this terminal pane to create the scheduled run. Retry in a few seconds.';
const CREATE_LIMIT_MESSAGE = `This terminal pane created ${PARADIS_SCHEDULED_RUN_TOOL_CREATE_LIMIT} scheduled runs in the last ${PARADIS_SCHEDULED_RUN_TOOL_CREATE_WINDOW_MS / 60_000} minutes, so Para Code turns this one down. Ask the user before creating more.`;

function toolText(value: object): unknown {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

export class ParadisScheduledRunToolProvider implements IParadisMcpToolProvider {

	/** ペインごとの、作った時刻（{@link PARADIS_SCHEDULED_RUN_TOOL_CREATE_WINDOW_MS} より古いものは捨てる）。 */
	private readonly _created = new Map<string, number[]>();

	constructor(private readonly _now: () => number = Date.now) { }

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_SCHEDULED_RUN_TOOLS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (name !== PARADIS_CREATE_SCHEDULED_RUN_TOOL) {
			return undefined;
		}
		// トークンは同じユーザーの別プロセスからも読めるので、手元のペインの中からの呼び出しだけを受ける
		if (!context || await context.classifyCaller() !== 'pane') {
			return toolError(CALLER_UNVERIFIED_MESSAGE);
		}
		const parsed = paradisParseCreateScheduledRun(args);
		if (!parsed.ok) {
			return toolError(parsed.error);
		}
		const recent = this._recentCreations(paneToken);
		if (recent.length >= PARADIS_SCHEDULED_RUN_TOOL_CREATE_LIMIT) {
			return toolError(CREATE_LIMIT_MESSAGE);
		}
		const call = await context.callOwningWindow<ParadisScheduledRunToolResult>({
			channelName: PARADIS_SCHEDULED_RUNS_MCP_CHANNEL,
			method: PARADIS_SCHEDULED_RUNS_MCP_METHOD,
			args: [paneToken, parsed.request],
			failureLabel: name,
			failureMessage: WINDOW_FAILURE_MESSAGE,
		}, signal);
		if (!call.ok) {
			return toolError(call.error);
		}
		const result = call.value;
		if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
			return toolError(WINDOW_FAILURE_MESSAGE);
		}
		if (!result.ok) {
			return toolError(result.error);
		}
		this._created.set(paneToken, [...recent, this._now()]);
		return toolText(result.data);
	}

	private _recentCreations(paneToken: string): number[] {
		const since = this._now() - PARADIS_SCHEDULED_RUN_TOOL_CREATE_WINDOW_MS;
		const recent = (this._created.get(paneToken) ?? []).filter(time => time > since);
		if (recent.length === 0) {
			this._created.delete(paneToken);
		}
		return recent;
	}
}
