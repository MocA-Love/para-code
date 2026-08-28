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

import { IParadisMcpPortFileRecord, IParadisMcpStdioWritable, PARADIS_MCP_LOCAL_TOOLS, PARADIS_MCP_MAX_INFLIGHT_REQUESTS, ParadisMcpInflightTracker, ParadisMcpStdioLineBuffer, ParadisMcpStdioWriter, paradisMcpShouldPauseStdin, postParadisMcpRequest, resolveLiveParadisMcpPortFile, shouldEmitParadisMcpHttpResponse } from './paradisBrowserMcpShimCore.js';

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

// オフライン時の tools/list 応答に使うツール定義。かつてはこのファイルとshared process側の
// `paradisAgentBrowserService.ts` の `TOOLS` の両方へ手で複製しており、更新漏れが繰り返し
// 起きたため、vs/* に依存しない `paradisBrowserMcpShimCore.ts` の `PARADIS_MCP_LOCAL_TOOLS`
// へ一本化した（サーバー側もこの同じ配列を参照する）。内蔵chrome-devtools-mcp由来の動的ツールは
// ここには載らない（オフラインでは元々使えず、オンライン時は透過転送されるため）。
const LOCAL_TOOLS = PARADIS_MCP_LOCAL_TOOLS;

const SESSION_HEALTH_TOOL_NAME = 'get_session_health';

interface IJsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
}

/**
 * このstdioシム自身（Para Codeの shared process へたどり着く前の、trasnport層）の診断情報。
 * shared process側の `get_session_health` が返すセッション/ブラウザ側の情報を補う、二段構えの片側。
 * shared processへ到達できないときは、こちらだけでも「どこで詰まっているか」を切り分けられる。
 */
function localShimTransportReport(reachable: boolean, record: IParadisMcpPortFileRecord | undefined, unreachableReason?: string): Record<string, unknown> {
	return {
		paneTokenEnvPresent: Boolean(paneToken),
		portFileEnvConfigured: Boolean(portFilePath),
		portFileReadable: reachable,
		resolvedServerPort: record?.port,
		...(unreachableReason !== undefined ? { unreachableReason } : {}),
	};
}

/** shared processから返った `get_session_health` の応答へ、シム自身の診断を追記する。 */
function withLocalShimTransportReport(parsedBody: unknown, record: IParadisMcpPortFileRecord | undefined): unknown {
	const message = parsedBody as { result?: { content?: unknown } };
	const content = message.result?.content;
	if (!Array.isArray(content)) {
		// エラー応答等、contentを持たない形はそのまま透過する（誤って形を壊さないため）。
		return parsedBody;
	}
	const shimText = `Local stdio shim (this MCP client's transport layer, before reaching Para Code):\n${JSON.stringify(localShimTransportReport(true, record), null, 2)}`;
	return {
		...(parsedBody as object),
		result: { ...(message.result as object), content: [...content, { type: 'text', text: shimText }] },
	};
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

const stdoutWriter = new ParadisMcpStdioWriter(process.stdout as unknown as IParadisMcpStdioWritable, {
	onDidChangeBackpressure: () => drainInput(),
	onError: error => failOutput(error),
});

function writeResponse(payload: unknown): Promise<void> {
	return stdoutWriter.write(JSON.stringify(payload) + '\n');
}

function writeResult(id: number | string | null, result: unknown): Promise<void> {
	return writeResponse({ jsonrpc: '2.0', id, result });
}

function writeErrorResponse(id: number | string | null, message: string): Promise<void> {
	return writeResponse({ jsonrpc: '2.0', id, error: { code: -32000, message } });
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
	const toolName = method === 'tools/call' && isRequest && params && typeof params === 'object'
		? (params as { name?: unknown }).name
		: undefined;

	// Para Code に接続できない場合はローカルで応答して MCP 接続自体は成立させる。
	// initialize / tools/list は正常応答し、ツール呼び出しだけ guidance を返す。
	let unavailable = getUnavailableMessage();
	let record: IParadisMcpPortFileRecord | undefined;
	if (unavailable === undefined) {
		try {
			// Resolve for every forwarded line. A stale shared-process PID triggers exactly one re-read.
			record = resolveLiveParadisMcpPortFile(portFilePath!);
		} catch {
			unavailable = NO_SERVER_MESSAGE;
		}
	}
	if (unavailable !== undefined) {
		if (!isRequest) {
			// idの無いnotification/レスポンスは応答不要（サーバーへも送れないため破棄）
			return;
		}
		switch (method) {
			case 'initialize':
				await writeResult(id, localInitializeResult(params));
				return;
			case 'ping':
				await writeResult(id, {});
				return;
			case 'tools/list':
				await writeResult(id, { tools: LOCAL_TOOLS });
				return;
			case 'tools/call':
				if (toolName === SESSION_HEALTH_TOOL_NAME) {
					// get_session_health自体は診断が仕事なので、未接続そのものを isError にはしない
					// （「接続できていない」というのがこのツールにとっての正常な報告内容のため）。
					await writeResult(id, { content: [{ type: 'text', text: JSON.stringify({ shimTransport: localShimTransportReport(false, undefined, unavailable) }, null, 2) }] });
					return;
				}
				// ツール実行エラーは JSON-RPC エラーではなく isError 付きの結果で返す（LLMが本文を読める）
				await writeResult(id, { content: [{ type: 'text', text: unavailable }], isError: true });
				return;
			default:
				await writeErrorResponse(id, unavailable);
				return;
		}
	}

	let status: number;
	let body: string;
	try {
		({ status, body } = await postParadisMcpRequest({ record: record!, body: line, token: paneToken! }));
	} catch (error) {
		const detail = `Failed to reach Para Code MCP server on 127.0.0.1:${record!.port}: ${error instanceof Error ? error.message : String(error)}`;
		if (toolName === SESSION_HEALTH_TOOL_NAME) {
			await writeResult(id, { content: [{ type: 'text', text: JSON.stringify({ shimTransport: localShimTransportReport(false, record, detail) }, null, 2) }] });
			return;
		}
		await respondToUnreachableServer(id, isRequest, method, detail);
		return;
	}
	if (!shouldEmitParadisMcpHttpResponse(status, body, isRequest)) {
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
		const detail = `Para Code MCP server returned HTTP ${status} or an invalid JSON-RPC response`;
		await respondToUnreachableServer(id, isRequest, method, detail);
		return;
	}
	await writeResponse(toolName === SESSION_HEALTH_TOOL_NAME ? withLocalShimTransportReport(parsedBody, record) : parsedBody);
}

/**
 * サーバーへ到達できなかった／サーバーが不正な応答を返したときの応答。
 *
 * `tools/call` はLLMが読める `isError: true` のcontentで返す（他のツール未接続時の案内
 * (unavailable) と同じ形に揃える）。initialize/tools/list等プロトコル層の失敗は、
 * これまで通りJSON-RPCエラーのままにする（LLMへ本文として見せるものではないため）。
 */
async function respondToUnreachableServer(id: number | string | null, isRequest: boolean, method: string | undefined, detail: string): Promise<void> {
	if (!isRequest) {
		process.stderr.write(`[para-browser-mcp-shim] ${detail}\n`);
		return;
	}
	if (method === 'tools/call') {
		await writeResult(id, { content: [{ type: 'text', text: detail }], isError: true });
		return;
	}
	await writeErrorResponse(id, detail);
}

const input = new ParadisMcpStdioLineBuffer();
let stdinEnded = false;
let stdinPaused = false;
let inputFailed = false;
let exitSettlementStarted = false;

const inflight = new ParadisMcpInflightTracker(PARADIS_MCP_MAX_INFLIGHT_REQUESTS, () => drainInput());

function settleAndExit(exitCode: number, finalOutput: Promise<void> = Promise.resolve()): void {
	if (exitSettlementStarted) {
		return;
	}
	exitSettlementStarted = true;
	void Promise.allSettled([inflight.waitForSettled(), finalOutput])
		.then(() => stdoutWriter.end())
		.then(() => process.exitCode = exitCode);
}

function stopInput(): void {
	input.clear();
	try {
		process.stdin.pause();
		stdinPaused = true;
	} catch {
		// Continue settling accepted work even when stdin is already closed.
	}
	try {
		process.stdin.destroy();
	} catch {
		// Natural process exit still waits for all accepted forwarding work below.
	}
}

function failOutput(error: Error): void {
	if (inputFailed) {
		return;
	}
	inputFailed = true;
	stopInput();
	process.stderr.write(`[para-browser-mcp-shim] ${error.message}\n`);
	settleAndExit(1);
}

function failInput(error: unknown): void {
	if (inputFailed) {
		return;
	}
	inputFailed = true;
	const message = error instanceof Error ? error.message : String(error);
	stopInput();
	settleAndExit(1, writeErrorResponse(null, message));
}

function updateInputFlowControl(): void {
	if (inputFailed || stdinEnded) {
		return;
	}
	const shouldPause = paradisMcpShouldPauseStdin(inflight.hasCapacity, stdoutWriter.isBackpressured);
	if (shouldPause && !stdinPaused) {
		process.stdin.pause();
		stdinPaused = true;
	} else if (!shouldPause && stdinPaused) {
		stdinPaused = false;
		process.stdin.resume();
	}
}

function drainInput(): void {
	if (inputFailed) {
		return;
	}
	try {
		while (inflight.hasCapacity && !stdoutWriter.isBackpressured) {
			const line = input.takeLine();
			if (line === undefined) {
				break;
			}
			if (line.length > 0 && !inflight.track(forwardLine(line))) {
				throw new Error('Para Code MCP inflight request capacity changed unexpectedly');
			}
		}
		updateInputFlowControl();
		if (!stdinEnded) {
			return;
		}
		if (input.hasCompleteLine) {
			// EOF may arrive while the bounded set of accepted requests is still in flight. Their settlement callback
			// re-enters this drain without allocating another waiter or forwarding Promise.
			return;
		}
		input.finish();
		settleAndExit(0);
	} catch (error) {
		failInput(error);
	}
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	try {
		input.append(chunk);
		drainInput();
	} catch (error) {
		failInput(error);
	}
});
process.stdin.on('end', () => {
	stdinEnded = true;
	drainInput();
});
process.stdin.on('error', error => failInput(error));
