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
//
// Para Code外（ペイン外・Para Code未起動）から起動された場合でも、シムはMCPサーバーとして
// 正常に起動し、initialize / tools/list には応答する（＝CLIのMCP接続自体は成功させる）。
// 実際のツール呼び出し時のみ、LLMが読んで状況を理解できる明確なエラーメッセージを返す。

import type * as http from 'http';
import { readFileSync } from 'fs';

// eslint警告(local/code-no-http-import)対応: httpは動的importで遅延ロードする
const httpModulePromise: Promise<typeof http> = import('http');

const PORT_FILE_ENV = 'PARA_CODE_MCP_PORT_FILE';
const TOKEN_ENV = 'PARA_CODE_TERMINAL_PANE_ID';

const portFilePath = process.env[PORT_FILE_ENV];
const paneToken = process.env[TOKEN_ENV];

// 起動時にenvが欠けていても process.exit(1) しない（＝MCPサーバーとしては起動する）。
// ここで落とすと CLI 側の MCP 接続自体が失敗し、ツール一覧すら得られなくなるため。
// 状況は stderr に1行残すだけに留め、ツール呼び出し時に guidance を返す。
if (!paneToken || !portFilePath) {
	process.stderr.write(
		`[para-browser-mcp-shim] Not running inside a Para Code terminal pane ` +
		`(${!paneToken ? TOKEN_ENV + ' ' : ''}${!portFilePath ? PORT_FILE_ENV + ' ' : ''}missing). ` +
		`The MCP server will start, but its tools will report as unavailable until launched from a Para Code pane.\n`
	);
}

// Para Code に接続できないときに LLM へ返す文言（英語。LLM が状況+推奨アクションを読める簡潔さ）。
const OUTSIDE_PANE_MESSAGE =
	`This tool is unavailable because it was not launched from a terminal pane inside Para Code ` +
	`(the ${TOKEN_ENV} environment variable is not set). Para Code shares each browser page only with ` +
	`the specific pane its agent CLI runs in. Re-launch your agent CLI from a terminal inside Para Code ` +
	`to use this tool, or simply continue working without this MCP server.`;

const NO_SERVER_MESSAGE =
	`This tool is unavailable because Para Code does not appear to be running (its MCP port file could ` +
	`not be read). Start Para Code and re-launch your agent CLI from a terminal pane inside it to use ` +
	`this tool, or simply continue working without this MCP server.`;

// オフライン時の tools/list 応答に使うツール定義（shared process側の TOOLS と同一内容の複製。
// このシムは vs/* を import できないためインラインで持つ）。
const LOCAL_TOOLS = [
	{
		name: 'get_shared_page',
		description: 'Get the URL and title of the browser page currently shared with this terminal pane in Para Code. Returns an error message if no page is shared yet.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'read_page',
		description: 'Read the current content of the browser page shared with this terminal pane in Para Code, as an accessibility snapshot (includes element references, text and structure).',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'get_cdp_endpoint',
		description: 'Get the Chrome DevTools Protocol (CDP) gateway endpoint of Para Code. Point chrome-devtools-mcp (--browserUrl) or browser-use (CDP URL) at the returned httpBase to drive the browser page shared with this terminal pane.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
] as const;

interface IJsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
}

function resolvePort(): number {
	const raw = readFileSync(portFilePath!, 'utf8');
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object' || typeof (parsed as { port?: unknown }).port !== 'number') {
		throw new Error(`Invalid port file: ${portFilePath}`);
	}
	return (parsed as { port: number }).port;
}

/**
 * Para Code に接続できない理由を判定する。undefined = 接続可能。
 * ペイン外（トークン無し）と Para Code 未起動（ポートファイル読めない）を区別する。
 */
function getUnavailableMessage(): string | undefined {
	if (!paneToken) {
		return OUTSIDE_PANE_MESSAGE;
	}
	if (!portFilePath) {
		return NO_SERVER_MESSAGE;
	}
	try {
		resolvePort();
	} catch {
		return NO_SERVER_MESSAGE;
	}
	return undefined;
}

function localInitializeResult(params: unknown): unknown {
	const requested = params && typeof params === 'object' && typeof (params as { protocolVersion?: unknown }).protocolVersion === 'string'
		? (params as { protocolVersion: string }).protocolVersion
		: '2025-03-26';
	return {
		protocolVersion: requested,
		capabilities: { tools: { listChanged: false } },
		serverInfo: { name: 'para-code-agent-browser', version: '1.0.0' },
	};
}

function writeResponse(payload: unknown): void {
	process.stdout.write(JSON.stringify(payload) + '\n');
}

function writeResult(id: number | string | null, result: unknown): void {
	writeResponse({ jsonrpc: '2.0', id, result });
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
	let method: string | undefined;
	let params: unknown;
	let isRequest = false;
	try {
		const message = JSON.parse(line) as IJsonRpcMessage;
		if (message && typeof message === 'object') {
			method = typeof message.method === 'string' ? message.method : undefined;
			if (message.id !== undefined && message.id !== null && typeof message.method === 'string') {
				id = message.id;
				params = message.params;
				isRequest = true;
			}
		}
	} catch {
		// パースできない行はそのままサーバーに送って判断させる（接続可能な場合のみ）
	}

	// Para Code に接続できない場合はローカルで応答して MCP 接続自体は成立させる。
	// initialize / tools/list は正常応答し、ツール呼び出しだけ guidance を返す。
	const unavailable = getUnavailableMessage();
	if (unavailable !== undefined) {
		if (!isRequest) {
			// idの無いnotification/レスポンスは応答不要（サーバーへも送れないため破棄）
			return;
		}
		switch (method) {
			case 'initialize':
				writeResult(id, localInitializeResult(params));
				return;
			case 'ping':
				writeResult(id, {});
				return;
			case 'tools/list':
				writeResult(id, { tools: LOCAL_TOOLS });
				return;
			case 'tools/call':
				// ツール実行エラーは JSON-RPC エラーではなく isError 付きの結果で返す（LLMが本文を読める）
				writeResult(id, { content: [{ type: 'text', text: unavailable }], isError: true });
				return;
			default:
				writeErrorResponse(id, unavailable);
				return;
		}
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
