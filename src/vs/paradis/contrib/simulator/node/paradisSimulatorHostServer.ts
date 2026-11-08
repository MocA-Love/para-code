/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ホストの子プロセスの中で動く受け口。serve-sim の `simMiddleware` を組み込み、**Unix ソケットだけで**
// 待ち受ける（TCP の番号を開かない。q.html Q585 の D1）。
//
// 守りは 3 重:
//  1. 許可の一覧（`paradisSimulatorHostRoute`）に無い要求はミドルウェアへ渡さず 404。
//     `/exec`・`/devtools*`・`/api/diagnostics`・grid の start・shutdown などはここで止まる。
//  2. ここでも `Authorization: Bearer <token>` を確かめ、違えば 401（ミドルウェアへ渡さない）。
//  3. Unix ソケットの相手は serve-sim から見て「ループバック」にならない（`remoteAddress` が無い）ので、
//     serve-sim 自身の token の検査もすべての要求と upgrade に掛かる。`allowExec` は渡さない。
// ソケットは 0700 のフォルダの中に置き、ファイルも 0600 にする（同じ利用者のほかのプロセス以外は触れない）。

import { timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { Socket } from 'net';
import { paradisBearerToken, paradisSimulatorHostRoute } from '../common/paradisSimulator.js';

/** serve-sim の `SimMiddleware` のうち、ここで使う分。 */
export interface IParadisSimulatorMiddleware {
	(req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => Promise<void>): Promise<void>;
	handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
}

export interface IParadisSimulatorHostServerOptions {
	readonly socketPath: string;
	readonly token: string;
	readonly middleware: IParadisSimulatorMiddleware;
	readonly onError?: (message: string, error?: unknown) => void;
}

export interface IParadisSimulatorHostServer {
	readonly server: Server;
	close(): Promise<void>;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
	if (!presented) {
		return false;
	}
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function sendStatus(res: ServerResponse, status: 401 | 404 | 500): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Internal Error');
}

function rejectUpgrade(socket: Socket, status: 401 | 404): void {
	try {
		socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	} catch {
		socket.destroy();
	}
}

/**
 * 受け口を作って待ち受けを始める。`socketPath` のフォルダは呼び出し側が 0700 で用意しておくこと。
 */
export async function paradisStartSimulatorHostServer(options: IParadisSimulatorHostServerOptions): Promise<IParadisSimulatorHostServer> {
	const { middleware, token } = options;
	const { createServer } = await import('http');
	const server = createServer((req, res) => {
		const route = paradisSimulatorHostRoute(req.method, req.url, false);
		if (!route) {
			sendStatus(res, 404);
			return;
		}
		if (!tokenMatches(paradisBearerToken(req.headers.authorization), token)) {
			sendStatus(res, 401);
			return;
		}
		// クエリを落とした形に直してから渡す（`?device=` で別の端末へ向け直させない）
		req.url = route.url;
		middleware(req, res, async () => sendStatus(res, 404)).catch(error => {
			options.onError?.(`request ${route.endpoint} failed`, error);
			sendStatus(res, 500);
		});
	});
	server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
		const route = paradisSimulatorHostRoute(req.method, req.url, true);
		if (!route) {
			rejectUpgrade(socket, 404);
			return;
		}
		if (!tokenMatches(paradisBearerToken(req.headers.authorization), token)) {
			rejectUpgrade(socket, 401);
			return;
		}
		req.url = route.url;
		try {
			middleware.handleUpgrade(req, socket, head);
		} catch (error) {
			options.onError?.('upgrade failed', error);
			socket.destroy();
		}
	});
	server.on('clientError', (_error, socket) => socket.destroy());

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.socketPath, () => {
			server.off('error', reject);
			resolve();
		});
	});
	await fs.chmod(options.socketPath, 0o600);
	server.on('error', error => options.onError?.('server error', error));

	return {
		server,
		close: () => new Promise<void>(resolve => {
			server.close(() => resolve());
			server.closeAllConnections();
		}),
	};
}
