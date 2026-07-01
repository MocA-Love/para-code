/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLI（Claude Code / Codex）向けの汎用stdio MCPシム。
// `node out/vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.js` として単体実行される
// プレーンなnodeスクリプトであること（vs/base等への依存禁止、nodeビルトインのみ）。
//
// stdinから改行区切りJSON（MCP stdioフレーミング）を読み、Para Code shared process内の
// MCP HTTPサーバー（Streamable HTTP, stateless）へフォワードする素朴なプロキシ。
// - トークン: PARA_CODE_TERMINAL_PANE_ID（PTY env経由で継承）を Bearer として全リクエストに付与
// - ポート: PARA_CODE_MCP_PORT_FILE のポートファイルを毎リクエスト読み直して解決
//   （shared process再起動によるポート変化への追従）

import type * as http from 'http';
import { readFileSync } from 'fs';

// eslint警告(local/code-no-http-import)対応: httpは動的importで遅延ロードする
const httpModulePromise: Promise<typeof http> = import('http');

const PORT_FILE_ENV = 'PARA_CODE_MCP_PORT_FILE';
const TOKEN_ENV = 'PARA_CODE_TERMINAL_PANE_ID';

const portFilePath = process.env[PORT_FILE_ENV];
const paneToken = process.env[TOKEN_ENV];

if (!portFilePath || !paneToken) {
	process.stderr.write(
		`[para-browser-mcp-shim] Missing required environment variables: ` +
		`${!portFilePath ? PORT_FILE_ENV + ' ' : ''}${!paneToken ? TOKEN_ENV : ''}\n` +
		`This shim must be launched from a shell inside a Para Code terminal pane ` +
		`(the variables are injected into the terminal environment by Para Code).\n`
	);
	process.exit(1);
}

interface IJsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
}

function resolvePort(): number {
	const raw = readFileSync(portFilePath!, 'utf8');
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object' || typeof (parsed as { port?: unknown }).port !== 'number') {
		throw new Error(`Invalid port file: ${portFilePath}`);
	}
	return (parsed as { port: number }).port;
}

function writeResponse(payload: unknown): void {
	process.stdout.write(JSON.stringify(payload) + '\n');
}

function writeErrorResponse(id: number | string | null, message: string): void {
	writeResponse({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

async function postToServer(port: number, line: string): Promise<{ status: number; body: string }> {
	const httpModule = await httpModulePromise;
	return new Promise((resolve, reject) => {
		const request = httpModule.request(
			{
				host: '127.0.0.1',
				port,
				path: '/mcp',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json, text/event-stream',
					'Authorization': `Bearer ${paneToken}`,
					'Content-Length': Buffer.byteLength(line),
				},
			},
			response => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
				response.on('error', reject);
			}
		);
		request.on('error', reject);
		request.end(line);
	});
}

async function forwardLine(line: string): Promise<void> {
	let id: number | string | null = null;
	let isRequest = false;
	try {
		const message = JSON.parse(line) as IJsonRpcMessage;
		if (message && typeof message === 'object' && message.id !== undefined && message.id !== null && typeof message.method === 'string') {
			id = message.id;
			isRequest = true;
		}
	} catch {
		// パースできない行はそのままサーバーに送って判断させる
	}

	let port: number;
	try {
		port = resolvePort();
	} catch (error) {
		const detail = `Para Code MCP server is not running (failed to read port file ${portFilePath}: ${error instanceof Error ? error.message : String(error)}). Is Para Code running?`;
		if (isRequest) {
			writeErrorResponse(id, detail);
		} else {
			process.stderr.write(`[para-browser-mcp-shim] ${detail}\n`);
		}
		return;
	}

	try {
		const { status, body } = await postToServer(port, line);
		if (status === 202 || body.trim().length === 0) {
			// notificationへの受理応答: stdoutには何も書かない
			return;
		}
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(body);
		} catch {
			parsedBody = undefined;
		}
		if (status >= 400 || !parsedBody || typeof parsedBody !== 'object' || (parsedBody as IJsonRpcMessage).jsonrpc !== '2.0') {
			// 401/405等のJSON-RPC以外の応答はJSON-RPCエラーに変換してクライアントへ返す
			const detail = `Para Code MCP server returned HTTP ${status}: ${body.slice(0, 500)}`;
			if (isRequest) {
				writeErrorResponse(id, detail);
			} else {
				process.stderr.write(`[para-browser-mcp-shim] ${detail}\n`);
			}
			return;
		}
		writeResponse(parsedBody);
	} catch (error) {
		const detail = `Failed to reach Para Code MCP server on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`;
		if (isRequest) {
			writeErrorResponse(id, detail);
		} else {
			process.stderr.write(`[para-browser-mcp-shim] ${detail}\n`);
		}
	}
}

const inflight = new Set<Promise<void>>();

function track(promise: Promise<void>): void {
	inflight.add(promise);
	void promise.finally(() => inflight.delete(promise));
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	buffered += chunk;
	let newlineIndex = buffered.indexOf('\n');
	while (newlineIndex !== -1) {
		const line = buffered.slice(0, newlineIndex).trim();
		buffered = buffered.slice(newlineIndex + 1);
		if (line.length > 0) {
			track(forwardLine(line));
		}
		newlineIndex = buffered.indexOf('\n');
	}
});
process.stdin.on('end', () => {
	// stdinクローズ後も処理中のリクエストのレスポンスは書き切ってから終了する
	void Promise.allSettled([...inflight]).then(() => process.exit(0));
});
