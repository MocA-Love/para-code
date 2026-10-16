/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP サーバーへブックマークの道具（list_bookmarks・edit_bookmarks）を足すプロバイダ。shared process で動く。
// ここでは接続元の確かめ（読み取りは手元のペインと SSH の戻り経路、書き込みは手元のペインだけ）、引数の検証、
// url を省いた追加での今のタブの URL と題名の取り出しを受け持ち、木の読み書きと利用者への通知は呼び出し元ペインの
// ウィンドウ（paradisBookmarkMcpChannel.ts）が行う。

import { IParadisMcpToolCallContext, IParadisMcpToolDefinition, IParadisMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	PARADIS_BOOKMARK_CREATE_LIMIT,
	PARADIS_BOOKMARK_CREATE_WINDOW_MS,
	PARADIS_BOOKMARK_DELETE_TIMEOUT_MS,
	PARADIS_BOOKMARK_MCP_CHANNEL,
	PARADIS_BOOKMARK_MCP_METHOD,
	PARADIS_BOOKMARK_TOOLS,
	PARADIS_EDIT_BOOKMARKS_TOOL,
	PARADIS_LIST_BOOKMARKS_TOOL,
	ParadisBookmarkToolRequest,
	ParadisBookmarkToolResult,
	paradisBookmarkToolTitle,
	paradisBookmarkToolUrlAllowed,
	paradisParseEditBookmarks,
	paradisParseListBookmarks,
} from '../common/paradisBookmarkTools.js';

const READ_CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside a Para Code terminal pane, so it refuses the request. Start this agent CLI from a terminal inside Para Code.';
const EDIT_CALLER_UNVERIFIED_MESSAGE = 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so it does not change bookmarks. This happens inside tmux, screen, zellij, WSL or a container.';
const SSH_REFUSED_MESSAGE = 'Agents on an SSH host can read the bookmarks with list_bookmarks but cannot change them. Ask the user to change them.';
const NO_TAB_MESSAGE = 'This terminal pane has no browser tab to bookmark (or tab_id is not one of its tabs). Pass "url", or open or select a tab first (list_browser_tabs).';
const TAB_URL_MESSAGE = 'That tab does not show an http or https page, so Para Code does not bookmark it. Pass "url" instead.';
const WINDOW_FAILURE_MESSAGE = 'Para Code could not reach the window of this terminal pane to use the bookmarks. Retry in a few seconds.';
const CREATE_LIMIT_MESSAGE = `This terminal pane added ${PARADIS_BOOKMARK_CREATE_LIMIT} bookmarks and folders in the last ${PARADIS_BOOKMARK_CREATE_WINDOW_MS / 60_000} minutes, so Para Code turns this one down. Ask the user before adding more.`;
const DELETE_TIMEOUT_MESSAGE = 'The user did not answer the deletion dialog in time, so nothing was deleted. Ask the user in the conversation before asking again.';

function toolText(value: object): unknown {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

export class ParadisBookmarkToolProvider implements IParadisMcpToolProvider {

	/** ペインごとの、足したブックマークとフォルダの時刻（{@link PARADIS_BOOKMARK_CREATE_WINDOW_MS} より古いものは捨てる）。 */
	private readonly _created = new Map<string, number[]>();

	constructor(private readonly _now: () => number = Date.now) { }

	listTools(): readonly IParadisMcpToolDefinition[] {
		return PARADIS_BOOKMARK_TOOLS;
	}

	async callTool(paneToken: string, name: string, args: unknown, signal?: AbortSignal, context?: IParadisMcpToolCallContext): Promise<unknown | undefined> {
		if (name !== PARADIS_LIST_BOOKMARKS_TOOL && name !== PARADIS_EDIT_BOOKMARKS_TOOL) {
			return undefined;
		}
		if (!context) {
			return toolError(READ_CALLER_UNVERIFIED_MESSAGE);
		}
		// トークンは同じユーザーの別プロセスからも読めるので、接続元を確かめる（読み取りは SSH の戻り経路も許す）
		const caller = await context.classifyCaller();
		if (name === PARADIS_LIST_BOOKMARKS_TOOL) {
			if (caller === 'unverified') {
				return toolError(READ_CALLER_UNVERIFIED_MESSAGE);
			}
			const parsed = paradisParseListBookmarks(args);
			if (!parsed.ok) {
				return toolError(parsed.error);
			}
			// SSH の接続先へは URL のクエリとフラグメントを渡さない（token や社内の情報を接続先の機械へ持ち出させない）
			return this._callWindow(paneToken, name, caller === 'tunnel' && parsed.request.op === 'list' ? { ...parsed.request, redactUrls: true } : parsed.request, context, signal);
		}
		if (caller === 'tunnel') {
			return toolError(SSH_REFUSED_MESSAGE);
		}
		if (caller !== 'pane') {
			return toolError(EDIT_CALLER_UNVERIFIED_MESSAGE);
		}
		const parsed = paradisParseEditBookmarks(args);
		if (!parsed.ok) {
			return toolError(parsed.error);
		}
		let request = parsed.request;
		const creates = request.op === 'add' || request.op === 'createFolder';
		if (creates && this._recentCreations(paneToken).length >= PARADIS_BOOKMARK_CREATE_LIMIT) {
			return toolError(CREATE_LIMIT_MESSAGE);
		}
		if (parsed.needsTab && request.op === 'add') {
			const tab = await context.getPaneTab?.(parsed.needsTab.tabId, signal);
			if (!tab) {
				return toolError(NO_TAB_MESSAGE);
			}
			if (!paradisBookmarkToolUrlAllowed(tab.url)) {
				return toolError(TAB_URL_MESSAGE);
			}
			request = { ...request, url: tab.url, title: request.title || paradisBookmarkToolTitle(tab.title) };
		}
		const result = await this._callWindow(paneToken, name, request, context, signal);
		if (creates && !(result as { isError?: boolean }).isError) {
			this._created.set(paneToken, [...this._recentCreations(paneToken), this._now()]);
		}
		return result;
	}

	private _recentCreations(paneToken: string): number[] {
		const since = this._now() - PARADIS_BOOKMARK_CREATE_WINDOW_MS;
		const recent = (this._created.get(paneToken) ?? []).filter(time => time > since);
		if (recent.length === 0) {
			this._created.delete(paneToken);
		}
		return recent;
	}

	private async _callWindow(paneToken: string, name: string, request: ParadisBookmarkToolRequest, context: IParadisMcpToolCallContext, signal?: AbortSignal): Promise<unknown> {
		const call = await context.callOwningWindow<ParadisBookmarkToolResult>({
			channelName: PARADIS_BOOKMARK_MCP_CHANNEL,
			method: PARADIS_BOOKMARK_MCP_METHOD,
			args: [paneToken, request],
			failureLabel: name,
			failureMessage: WINDOW_FAILURE_MESSAGE,
			// 削除は利用者の確認を待つので、既定の 10 秒では足りない
			...(request.op === 'delete' ? { timeoutMs: PARADIS_BOOKMARK_DELETE_TIMEOUT_MS, timeoutMessage: DELETE_TIMEOUT_MESSAGE } : {}),
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
