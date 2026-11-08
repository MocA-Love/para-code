/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP サーバーへ「ポートの転送」の道具を足すプロバイダ。shared process で動く。
// ここでは接続元の確かめと引数の検査を受け持ち、転送の読み書きと確認のダイアログは呼び出し元ペインの
// ウィンドウ（paradisPortToolsChannel.ts）が行う（どの窓の転送かは、呼んだペインを持つ窓で決まる）。
//
// 接続元の扱いはブックマーク・IDE の道具と違う: SSH の窓のペインからの呼び出しは必ず SSH の戻り経路（tunnel）に
// なるので、変える操作も pane と tunnel から受け付け、確かめられない接続（unverified）だけを断る。変える操作の
// 守りは、ウィンドウ側で毎回出す確認のダイアログが受け持つ（q.html の Q590-1、案 2）。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	PARADIS_PORT_TOOLS,
	PARADIS_PORT_TOOLS_CHANGE_TIMEOUT_MS,
	PARADIS_PORT_TOOLS_CHANNEL,
	PARADIS_PORT_TOOLS_METHOD,
	ParadisPortToolRequest,
	ParadisPortToolResult,
	paradisParsePortToolCall,
	paradisPortToolRequestChanges,
} from '../common/paradisPortTools.js';

const CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane (or from the SSH host of its window), so it refuses the request. Start this agent CLI from a terminal inside Para Code.';
const WINDOW_FAILURE_MESSAGE = 'Para Code could not reach the window of this terminal pane to use its port forwards. Retry in a few seconds.';
const CHANGE_TIMEOUT_MESSAGE = 'Para Code did not finish in time. The user may not have answered the confirmation dialog, or the change may still be running. Call list_port_forwards to see the current state before asking again.';

function toolText(value: object): unknown {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

export class ParadisPortToolProvider implements IParadisMcpToolProvider {

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_PORT_TOOLS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		const parsed = paradisParsePortToolCall(name, args);
		if (parsed === undefined) {
			return undefined;
		}
		if (!context) {
			return toolError(CALLER_UNVERIFIED_MESSAGE);
		}
		// トークンは同じユーザーの別プロセスからも読めるので、接続元を確かめる。SSH の窓のペインは tunnel になるので通す
		const caller = await context.classifyCaller();
		if (caller === 'unverified') {
			return toolError(CALLER_UNVERIFIED_MESSAGE);
		}
		if (!parsed.ok) {
			return toolError(parsed.error);
		}
		return this._callWindow(paneToken, name, parsed.request, context, signal);
	}

	private async _callWindow(paneToken: string, name: string, request: ParadisPortToolRequest, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<unknown> {
		const changes = paradisPortToolRequestChanges(request);
		const call = await context.callOwningWindow<ParadisPortToolResult>({
			channelName: PARADIS_PORT_TOOLS_CHANNEL,
			method: PARADIS_PORT_TOOLS_METHOD,
			args: [paneToken, request],
			failureLabel: name,
			failureMessage: WINDOW_FAILURE_MESSAGE,
			// 変える操作は利用者の確認と転送の張り直しを待つので、既定の 10 秒では足りない
			...(changes ? { timeoutMs: PARADIS_PORT_TOOLS_CHANGE_TIMEOUT_MS, timeoutMessage: CHANGE_TIMEOUT_MESSAGE } : {}),
		}, signal);
		if (!call.ok) {
			return toolError(call.error);
		}
		const result = call.value;
		if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
			return toolError(WINDOW_FAILURE_MESSAGE);
		}
		return result.ok ? toolText(result.data) : toolError(result.error);
	}
}
