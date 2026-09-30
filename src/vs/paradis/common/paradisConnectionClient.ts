/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャネルの呼び出し元（context）から、接続先（REH）へ繋いだクライアントを見分ける。
//
// REH は同じ接続先へ繋いだ複数のウィンドウ（別の PC からのものを含む）を1つのプロセスで受ける。ログインの
// 手続きのように「始めたウィンドウだけが見てよい」ものは、この値で持ち主を決める。shared process の
// context はウィンドウの名前の文字列で、そこでは持ち主を分けない（従来どおり）。

/**
 * REH の context（`RemoteAgentConnectionContext`）の `clientId`。shared process の context（文字列）や、
 * 形が合わないものは undefined（持ち主を分けない）。
 */
export function paradisConnectionClientId(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') {
		return undefined;
	}
	const clientId = (ctx as { clientId?: unknown }).clientId;
	return typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined;
}

/**
 * 持ち主を分けた手続きを、呼び出し元が触ってよいか。持ち主の無いもの（shared process で始めたもの）は
 * 誰でも触れる。持ち主のあるものは、同じクライアントからの呼び出しだけ。
 */
export function paradisIsConnectionClientAllowed(owner: string | undefined, caller: string | undefined): boolean {
	return owner === undefined || owner === caller;
}
