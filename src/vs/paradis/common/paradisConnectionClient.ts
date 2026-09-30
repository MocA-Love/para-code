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
//
// REH の context の `clientId` は使えない。workbench は全ウィンドウが同じ定数 `'renderer'` で繋ぐ
// （abstractRemoteAgentService.ts の connectRemoteAgentManagement。serverServices.ts の StaticRouter も
// この値が前提）。代わりに context のオブジェクトそのものを使う。IPCServer は context を接続ごとに1回
// 読み込み、同じ接続（再接続を含む）には同じ参照を渡す。

import { generateUuid } from '../../base/common/uuid.js';

const connectionIds = new WeakMap<object, string>();

/**
 * REH の接続ごとの識別子（context のオブジェクトごとに1つ振る）。shared process の context（文字列）や
 * オブジェクトでないものは undefined（持ち主を分けない）。
 */
export function paradisConnectionClientId(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') {
		return undefined;
	}
	let id = connectionIds.get(ctx);
	if (id === undefined) {
		id = generateUuid();
		connectionIds.set(ctx, id);
	}
	return id;
}

/**
 * 持ち主を分けた手続きを、呼び出し元が触ってよいか。持ち主の無いもの（shared process で始めたもの）は
 * 誰でも触れる。持ち主のあるものは、同じ接続からの呼び出しだけ。
 */
export function paradisIsConnectionClientAllowed(owner: string | undefined, caller: string | undefined): boolean {
	return owner === undefined || owner === caller;
}
