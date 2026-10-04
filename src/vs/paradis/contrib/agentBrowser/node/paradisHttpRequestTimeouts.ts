/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code の MCP / hook / 音声取込の HTTP サーバー（127.0.0.1）の時間の上限。
//
// サーバー全体の requestTimeout（要求を全部受け取るまでの上限）は、SSH 先の声を chunked で受ける
// `/paradis-mcp/mobile-voice` が 1 発話 120 秒まで続くので 130 秒にする。それ以外の経路（MCP の JSON-RPC・
// agent-hook・Claude Code の mod・ticket の発行）は、これまでの 30 秒の守り（本文を送りきらない相手で枠を
// 塞がせない）を {@link paradisArmRequestBodyTimeout} で経路ごとに掛ける。音声取込は自前の 120 秒・最初の音・
// 届く速さで縛る。

import type * as http from 'http';

/** サーバー全体の requestTimeout。音声取込の 120 秒に余裕を足す。 */
export const PARADIS_MCP_REQUEST_TIMEOUT_MS = 130_000;
/** 音声取込以外の経路で、本文を受け取りきるまでの上限（以前のサーバー全体の requestTimeout と同じ）。 */
export const PARADIS_MCP_BODY_TIMEOUT_MS = 30_000;

/** サーバーの時間の上限を設定する。 */
export function paradisConfigureMcpHttpServer(server: http.Server): void {
	server.maxConnections = 256;
	server.maxHeadersCount = 100;
	server.maxRequestsPerSocket = 100;
	server.headersTimeout = 10_000;
	server.requestTimeout = PARADIS_MCP_REQUEST_TIMEOUT_MS;
	server.keepAliveTimeout = 5_000;
	server.timeout = 300_000;
}

/**
 * 要求の本文を `timeoutMs` までに受け取りきらなければ、408 を返して（応答のヘッダーを送る前なら）接続を切る。
 * Node の requestTimeout と同じ守りを経路ごとに掛ける。受け取りきったら何もしない。
 */
export function paradisArmRequestBodyTimeout(req: http.IncomingMessage, res: http.ServerResponse, timeoutMs = PARADIS_MCP_BODY_TIMEOUT_MS): void {
	if (req.complete) {
		return;
	}
	const timer = setTimeout(() => {
		if (req.complete || req.destroyed || res.writableEnded) {
			return;
		}
		if (!res.headersSent && !res.writableEnded) {
			res.writeHead(408, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
			res.end(JSON.stringify({ error: 'Request timed out.' }));
		}
		req.destroy();
	}, timeoutMs);
	(timer as { unref?: () => void }).unref?.();
	// 要求の側には聞き手を足さない（読み終えた経路が聞き手の数を確かめている）。応答が終われば時計も要らない
	const clear = () => clearTimeout(timer);
	res.once('finish', clear);
	res.once('close', clear);
}
