/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process内で動く、ペイントークン⇔共有ブラウザページのバインディングレジストリ + MCPサーバー本体。
// MCPプロトコルは自前の最小JSON-RPC over Streamable HTTP実装（stateless、POSTのみ、SSEなし）。
// @modelcontextprotocol/sdk はnode_modulesにtransitiveとして存在するが、直接依存に昇格させると
// 製品ビルド（esbuildバンドル・同梱node_modules）への影響範囲が読みにくいこと、必要なのは
// initialize / tools/list / tools/call のごく小さなサブセットだけであることから採用しなかった。
//
// ペイン分離はこのレジストリ層で保証する（トークン→バインド済みページ以外へはアクセス不可）。
// upstreamの playwrightService.ts（_trackedPages等）は一切改造しない。

import type * as http from 'http';
import { promises as fs, unlinkSync } from 'fs';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { IPCServer } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisPaneBinding, IParadisSharedPageInfo, PARADIS_CDP_TARGET_CHANNEL, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_NAME } from '../common/paradisAgentBrowser.js';
import { ParadisCdpGateway } from './paradisCdpGateway.js';
import { ParadisCdpUpstream } from './paradisCdpUpstream.js';

/**
 * PlaywrightChannel（vs/platform/browserView/node/playwrightChannel.ts）の `call` と構造的に一致する
 * 最小インターフェース。ウィンドウ毎の PlaywrightService インスタンスへ ctx キーでアクセスするために使う。
 * PlaywrightChannel 自体には手を入れず、公開メソッド `call` 経由でのみ利用する。
 */
export interface IParadisPlaywrightInvoker {
	call<T>(ctx: string, command: string, arg?: unknown): Promise<T>;
}

interface IBindingEntry {
	readonly windowCtx: string;
	readonly pageId: string;
	readonly pageInfo: IParadisSharedPageInfo;
	/** バインドされた時刻（epoch ms）。 */
	readonly boundAt: number;
	/** バインド済みページのChromium DevTools targetId（electron-mainへの問い合わせ結果のキャッシュ）。 */
	cdpTargetId?: string;
}

interface IPaneShellEntry {
	readonly windowCtx: string;
	readonly token: string;
	readonly shellPid: number;
}

interface IJsonRpcRequest {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
}

/** 全ペイン共通で使うPlaywrightセッションID（PlaywrightServiceはウィンドウ毎に分離済み）。 */
const MCP_PLAYWRIGHT_SESSION_ID = 'paradis-agent-browser';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

// allow-any-unicode-next-line
const NOT_BOUND_MESSAGE = 'このターミナルペインに共有されたブラウザページはありません。Para Code側でブラウザページを開き、コマンドパレットから「Paradis: Share Browser Page with Terminal Pane」を実行してこのペインに共有してください。';

const TOOLS = [
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

/**
 * バインディングレジストリ + MCP HTTPサーバー + CDPゲートウェイ。
 * `127.0.0.1` の固定既定ポート（{@link PARADIS_MCP_DEFAULT_PORT}、専有時のみ動的フォールバック）で
 * listenし、`<userDataDir>/paradis-browser-mcp.json` に `{ port, pid }` を書き出す（dispose時に削除）。
 */
export class ParadisAgentBrowserService extends Disposable {

	private readonly _bindings = new Map<string, IBindingEntry>();
	/** workbenchから同期される「ペイントークン ⇔ シェルPID」表（CDPゲートウェイの呼び出し元識別用）。 */
	private readonly _paneShells = new Map<string, IPaneShellEntry>();
	/**
	 * MCPリクエスト（またはCDPゲートウェイのPID識別）で実際に接続実績のあったペイントークンの集合。
	 * バインディングダイアログの「MCP未接続」表示に使う（shared processの生存期間のみ保持）。
	 */
	private readonly _seenTokens = new Set<string>();
	private readonly _portFilePath: string;
	private readonly _cdpGateway: ParadisCdpGateway;
	private _httpServer: http.Server | undefined;
	private _port: number | undefined;

	constructor(
		userDataPath: string,
		private readonly playwrightInvoker: IParadisPlaywrightInvoker,
		ipcServer: IPCServer<string>,
		private readonly mainProcessService: IMainProcessService,
		private readonly logService: ILogService,
	) {
		super();
		this._portFilePath = join(userDataPath, PARADIS_MCP_PORT_FILE_NAME);
		this._cdpGateway = this._register(new ParadisCdpGateway(
			{
				getBoundTargetId: token => this._bindings.get(token)?.cdpTargetId,
				ensureBoundTargetId: token => this._ensureBoundTargetId(token),
				getTokenForShellPid: pid => {
					for (const entry of this._paneShells.values()) {
						if (entry.shellPid === pid) {
							// CDPゲートウェイがPID経由で呼び出し元ペインを識別できた＝接続実績あり。
							this._seenTokens.add(entry.token);
							return entry.token;
						}
					}
					return undefined;
				},
			},
			new ParadisCdpUpstream(userDataPath, logService),
			logService,
		));
		// ウィンドウ切断（リロード・クローズ）時はページ共有（tracked pages）も失われるため、
		// そのウィンドウ由来のバインディングをまとめて破棄して整合させる。
		this._register(ipcServer.onDidRemoveConnection(connection => this.removeBindingsForWindow(connection.ctx)));
		void this._startServer();
	}

	// --- バインディングレジストリ（workbenchからIPCチャネル経由で呼ばれる） ---

	async bind(windowCtx: string, token: string, pageId: string, pageInfo: IParadisSharedPageInfo): Promise<void> {
		this._bindings.set(token, { windowCtx, pageId, pageInfo, boundAt: Date.now() });
		this.logService.debug(`[ParadisAgentBrowser] Bound pane ${token} -> page ${pageId} (${pageInfo.url}) in ${windowCtx}`);
		// 既存のCDP接続は古いページのスコープスナップショットを持つため強制切断する
		// （クライアントは次のツール呼び出しで再接続し、新しいバインドを拾う）。
		this._cdpGateway.closeConnectionsForToken(token);
		// targetIdを先行解決してキャッシュを温める（ゲートウェイの同期クロージャ用）。
		void this._ensureBoundTargetId(token);
	}

	async unbind(token: string): Promise<void> {
		if (this._bindings.delete(token)) {
			this.logService.debug(`[ParadisAgentBrowser] Unbound pane ${token}`);
			this._cdpGateway.closeConnectionsForToken(token);
		}
	}

	/**
	 * workbenchウィンドウから「ペイントークン ⇔ シェルPID」の対応表を同期する
	 * （ウィンドウ単位で全置換）。CDPゲートウェイが接続元PIDの祖先チェーンと突合して
	 * 呼び出し元ペインを識別するために使う（env読み取り不可のWindowsでは主経路）。
	 */
	async syncPaneShells(windowCtx: string, entries: readonly { token: string; shellPid: number }[]): Promise<void> {
		for (const [token, entry] of [...this._paneShells]) {
			if (entry.windowCtx === windowCtx) {
				this._paneShells.delete(token);
			}
		}
		for (const entry of entries) {
			if (typeof entry.token === 'string' && typeof entry.shellPid === 'number' && entry.shellPid > 0) {
				this._paneShells.set(entry.token, { windowCtx, token: entry.token, shellPid: entry.shellPid });
			}
		}
	}

	async listBindings(windowCtx: string): Promise<IParadisPaneBinding[]> {
		const result: IParadisPaneBinding[] = [];
		for (const [token, entry] of this._bindings) {
			if (entry.windowCtx === windowCtx) {
				result.push({ token, pageId: entry.pageId, pageInfo: entry.pageInfo, boundAt: entry.boundAt });
			}
		}
		return result;
	}

	/**
	 * MCP/CDP経由で接続実績のあるペイントークンの一覧を返す。
	 * トークンはウィンドウをまたいで一意（UUID）なので、windowCtxでの絞り込みは行わない。
	 */
	async listSeenTokens(): Promise<string[]> {
		return [...this._seenTokens];
	}

	/** ウィンドウ切断時に、そのウィンドウのバインディングとシェルPID表をまとめて破棄する。 */
	removeBindingsForWindow(windowCtx: string): void {
		for (const [token, entry] of [...this._bindings]) {
			if (entry.windowCtx === windowCtx) {
				this._bindings.delete(token);
				this._cdpGateway.closeConnectionsForToken(token);
			}
		}
		for (const [token, entry] of [...this._paneShells]) {
			if (entry.windowCtx === windowCtx) {
				this._paneShells.delete(token);
			}
		}
	}

	/**
	 * バインド済みページのDevTools targetIdを解決して返す（キャッシュ付き）。
	 * 解決はelectron-mainの {@link PARADIS_CDP_TARGET_CHANNEL} チャネル経由で行う。
	 */
	private async _ensureBoundTargetId(token: string): Promise<string | undefined> {
		const binding = this._bindings.get(token);
		if (!binding) {
			return undefined;
		}
		if (binding.cdpTargetId) {
			return binding.cdpTargetId;
		}
		try {
			const targetId = await this.mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL)
				.call<string | null>('resolveTargetId', [binding.pageId]);
			const current = this._bindings.get(token);
			if (targetId && current === binding) {
				current.cdpTargetId = targetId;
			}
			return targetId ?? undefined;
		} catch (error) {
			this.logService.warn(`[ParadisAgentBrowser] Failed to resolve CDP targetId for page ${binding.pageId}`, error);
			return undefined;
		}
	}

	// --- MCP HTTPサーバー ---

	private async _startServer(): Promise<void> {
		const { createServer } = await import('http');
		if (this._store.isDisposed) {
			return;
		}
		const server = createServer((req, res) => {
			this._handleRequest(req, res).catch(error => {
				this.logService.error('[ParadisAgentBrowser] Unhandled error in HTTP handler', error);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
				}
				res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
			});
		});
		// CDPゲートウェイのWebSocket upgrade（/cdp/devtools/* および /devtools/*）
		server.on('upgrade', (req, socket, head) => {
			void this._cdpGateway.handleUpgrade(req, socket, head);
		});
		this._httpServer = server;

		// 固定既定ポートを第一候補にする（`PARA_CODE_CDP_URL` が再起動を跨いで同一文字列に
		// なることが要件）。専有時のみ動的ポートへフォールバックし、警告を残す。
		// ポートファイルには常に実ポートが書かれるため、stdioシム経路には影響しない。
		const listen = (port: number) => new Promise<boolean>(resolve => {
			const onError = (error: NodeJS.ErrnoException) => {
				server.removeListener('listening', onListening);
				this.logService.warn(`[ParadisAgentBrowser] Failed to listen on 127.0.0.1:${port}: ${error.code ?? error.message}`);
				resolve(false);
			};
			const onListening = () => {
				server.removeListener('error', onError);
				resolve(true);
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, '127.0.0.1');
		});

		let listening = await listen(PARADIS_MCP_DEFAULT_PORT);
		if (!listening && !this._store.isDisposed) {
			this.logService.warn(`[ParadisAgentBrowser] Default port ${PARADIS_MCP_DEFAULT_PORT} is in use. Falling back to a dynamic port — the PARA_CODE_CDP_URL injected into terminals will be stale; use the get_cdp_endpoint MCP tool (or the port file) for the live URL.`);
			listening = await listen(0);
		}
		if (!listening) {
			this.logService.error('[ParadisAgentBrowser] Failed to start MCP server (no port available)');
			this._httpServer = undefined;
			return;
		}

		const address = this._httpServer.address();
		if (!address || typeof address === 'string') {
			this.logService.error('[ParadisAgentBrowser] Unexpected server address', String(address));
			return;
		}
		this._port = address.port;

		try {
			await fs.writeFile(this._portFilePath, JSON.stringify({ port: this._port, pid: process.pid }));
			this.logService.info(`[ParadisAgentBrowser] MCP server listening on 127.0.0.1:${this._port} (port file: ${this._portFilePath})`);
		} catch (error) {
			this.logService.error('[ParadisAgentBrowser] Failed to write MCP port file', error);
		}
	}

	private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		// CDPゲートウェイのHTTPエンドポイント（GET /json/* および GET /cdp/json/*）
		if (this._cdpGateway.isGatewayHttpRequest(req)) {
			return this._cdpGateway.handleRequest(req, res);
		}

		if (req.method !== 'POST') {
			res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
			res.end(JSON.stringify({ error: 'Method not allowed. This is a Para Code MCP endpoint (Streamable HTTP, POST only) with a CDP gateway under /cdp (GET /cdp/json/version etc.).' }));
			return;
		}

		const token = this._extractToken(req);
		if (!token) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing pane token. Provide it via "Authorization: Bearer <token>" or the "?pane=<token>" query parameter.' }));
			return;
		}
		// MCPリクエストが届いた＝このペインのエージェントCLIはMCP接続済み（listSeenTokens用）。
		this._seenTokens.add(token);

		let body: string;
		try {
			body = await this._readBody(req);
		} catch (error) {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: String(error) }));
			return;
		}

		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch {
			this._sendJsonRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
			return;
		}

		if (Array.isArray(message) || !message || typeof message !== 'object') {
			this._sendJsonRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request (batch messages are not supported)' } });
			return;
		}

		const rpc = message as IJsonRpcRequest;
		if (typeof rpc.method !== 'string') {
			// レスポンス/不正メッセージ: statelessサーバーなので受理だけする
			res.writeHead(202);
			res.end();
			return;
		}

		if (rpc.id === undefined || rpc.id === null) {
			// notification（notifications/initialized 等）は202で受理
			res.writeHead(202);
			res.end();
			return;
		}

		try {
			const result = await this._dispatch(token, rpc);
			this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, result });
		} catch (error) {
			if (error instanceof JsonRpcMethodError) {
				this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, error: { code: error.code, message: error.message } });
			} else {
				this._sendJsonRpc(res, { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } });
			}
		}
	}

	private async _dispatch(token: string, rpc: IJsonRpcRequest): Promise<unknown> {
		switch (rpc.method) {
			case 'initialize': {
				const params = rpc.params as { protocolVersion?: unknown } | undefined;
				const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
				return {
					protocolVersion: requested,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'para-code-agent-browser', version: '1.0.0' },
				};
			}
			case 'ping':
				return {};
			case 'tools/list':
				return { tools: TOOLS };
			case 'tools/call':
				return this._callTool(token, rpc.params as { name?: unknown } | undefined);
			default:
				throw new JsonRpcMethodError(-32601, `Method not found: ${rpc.method}`);
		}
	}

	private async _callTool(token: string, params: { name?: unknown } | undefined): Promise<unknown> {
		const name = typeof params?.name === 'string' ? params.name : undefined;
		if (!name || !TOOLS.some(t => t.name === name)) {
			throw new JsonRpcMethodError(-32602, `Unknown tool: ${String(name)}`);
		}

		if (name === 'get_cdp_endpoint') {
			// CDPエンドポイント自体はバインド無しでも案内する（バインド状況も添える）。
			const boundEntry = this._bindings.get(token);
			const httpBase = this._port !== undefined ? `http://127.0.0.1:${this._port}/cdp` : undefined;
			if (!httpBase) {
				// allow-any-unicode-next-line
				return this._toolError('CDPゲートウェイのHTTPサーバーがまだ起動していません。少し待って再試行してください。');
			}
			return this._toolText(JSON.stringify({
				httpBase,
				// allow-any-unicode-next-line
				note: 'chrome-devtools-mcp の --browserUrl や browser-use の CDP URL にこの httpBase を指定してください。操作できるのはこのターミナルペインに共有されたページのみです。',
				boundPage: boundEntry ? { url: boundEntry.pageInfo.url, title: boundEntry.pageInfo.title } : null,
				...(boundEntry ? {} : { hint: NOT_BOUND_MESSAGE }),
			}, null, 2));
		}

		const binding = this._bindings.get(token);
		if (!binding) {
			return this._toolError(NOT_BOUND_MESSAGE);
		}

		switch (name) {
			case 'get_shared_page':
				return this._toolText(JSON.stringify({ url: binding.pageInfo.url, title: binding.pageInfo.title, pageId: binding.pageId }, null, 2));
			case 'read_page': {
				try {
					const summary = await this.playwrightInvoker.call<string>(binding.windowCtx, 'getSummary', [MCP_PLAYWRIGHT_SESSION_ID, binding.pageId]);
					return this._toolText(summary);
				} catch (error) {
					// allow-any-unicode-next-line
					return this._toolError(`共有ページの読み取りに失敗しました（ページやウィンドウが閉じられた可能性があります）: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			default:
				throw new JsonRpcMethodError(-32602, `Unknown tool: ${name}`);
		}
	}

	private _toolText(text: string): unknown {
		return { content: [{ type: 'text', text }] };
	}

	private _toolError(text: string): unknown {
		return { content: [{ type: 'text', text }], isError: true };
	}

	private _extractToken(req: http.IncomingMessage): string | undefined {
		const auth = req.headers.authorization;
		if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7) {
			return auth.slice(7).trim() || undefined;
		}
		try {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const pane = url.searchParams.get('pane');
			return pane || undefined;
		} catch {
			return undefined;
		}
	}

	private _readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					reject(new Error('Request body too large'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	private _sendJsonRpc(res: http.ServerResponse, payload: unknown): void {
		if (!res.headersSent) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
		}
		res.end(JSON.stringify(payload));
	}

	override dispose(): void {
		this._httpServer?.close();
		this._httpServer = undefined;
		try {
			unlinkSync(this._portFilePath);
		} catch {
			// ポートファイルが既に無い場合は無視
		}
		super.dispose();
	}
}

/** JSON-RPCのエラーレスポンスに変換されるエラー。 */
class JsonRpcMethodError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}
