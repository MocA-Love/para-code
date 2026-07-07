/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDPゲートウェイ（Supersetの cdp-gateway.ts の移植）。
// agent-browser HTTPサーバー（shared process）に相乗りし、chrome-devtools-mcp /
// browser-use等の既存ブラウザ自動化MCPが期待するCDPエンドポイント
// （`/json/*`、`/devtools/browser/<id>`、`/devtools/page/<id>`）を提供する。
// パスは `/cdp` プレフィックス付き・無しの両方を受け付ける
// （puppeteerは `new URL('/json/version', browserURL)` でベースURLのパスを落とすため、
// ルート直下でも同じエンドポイントを提供する必要がある）。
//
// 呼び出し元の識別は接続ごとに行う（paradisCdpPeerResolver.ts参照）:
//   1. URLクエリ `?pane=<token>`（最優先）
//   2. loopbackピアPID → 祖先チェーンのenv / 既知シェルPID表 → ペイントークン
// 解決したトークンをバインディングレジストリと突合し、バインド済みページの
// targetId（とその子孫）だけが見える・触れるようにフィルタする（paradisCdpFilterProxy.ts）。
//
// セキュリティ: 127.0.0.1のみ。`/json/*` が無認証なのはpuppeteerがAuthorizationヘッダーや
// クエリを落とすためで、代わりに「Para Codeターミナルペインの子孫プロセスであること」を
// capabilityとして要求する（バインドが無ければ空一覧が返るだけで何も操作できない）。

import { randomBytes } from 'crypto';
import type * as http from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import type * as wsTypes from 'ws';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisCdpScreenshotOptions } from '../common/paradisAgentBrowser.js';
import { IParadisBoundContext, IParadisWsModule, paradisProxyBrowserUpgrade, paradisProxyPageUpgrade } from './paradisCdpFilterProxy.js';
import { paradisResolvePaneTokenForPeerPort } from './paradisCdpPeerResolver.js';
import { ParadisCdpUpstream } from './paradisCdpUpstream.js';

/** ゲートウェイがバインディングレジストリ（サービス本体）へ問い合わせるための契約。 */
export interface IParadisCdpGatewayDelegate {
	/** トークンにバインド済みのページのDevTools targetId（キャッシュ済みなら同期で返る）。 */
	getBoundTargetId(token: string): string | undefined;
	/** 未解決ならelectron-mainへの解決を待って返す。バインド無し/ページ消滅ならundefined。 */
	ensureBoundTargetId(token: string): Promise<string | undefined>;
	/** workbenchから同期された シェルPID → ペイントークン 表の参照。 */
	getTokenForShellPid(pid: number): string | undefined;
	/**
	 * バインド済みページのスクリーンショットをelectron-mainのupstream実装
	 * （BrowserView.captureScreenshot: 非表示時の回避策付き）で撮り、base64を返す。
	 * バインド無し・ビュー消滅・キャプチャ失敗時はundefined（呼び出し元がフォールバックする）。
	 */
	captureBoundPageScreenshot(token: string, options: IParadisCdpScreenshotOptions): Promise<string | undefined>;
	/** バインド済みページのwebContentsへフォーカスを強制する（fire-and-forget、失敗は無視）。 */
	focusBoundPage(token: string): void;
}

function isLoopback(address: string | undefined): boolean {
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 先頭の `/cdp` プレフィックスと末尾スラッシュを正規化したパスを返す。 */
function normalizePath(pathname: string): string {
	let p = pathname;
	if (p === '/cdp' || p.startsWith('/cdp/')) {
		p = p.slice('/cdp'.length) || '/';
	}
	if (p.length > 1 && p.endsWith('/')) {
		p = p.slice(0, -1);
	}
	return p;
}

const JSON_PATHS = new Set(['/json', '/json/list', '/json/version', '/json/protocol']);

export class ParadisCdpGateway extends Disposable {

	/** TCPソケット単位のトークン解決キャッシュ（正の解決のみメモ化）。 */
	private readonly _socketTokens = new WeakMap<Socket, string>();
	/** トークン別のアクティブWS接続（バインド変更時の強制切断用）。 */
	private readonly _connectionsByToken = new Map<string, Set<wsTypes.WebSocket>>();
	/** /json/version が返すブラウザWS URLのid部分（Chromium風の見た目にするだけの飾り）。 */
	private readonly _browserWsIds = new Map<string, string>();

	private _wsModulePromise: Promise<IParadisWsModule> | undefined;
	private _wss: wsTypes.WebSocketServer | undefined;

	constructor(
		private readonly delegate: IParadisCdpGatewayDelegate,
		private readonly upstream: ParadisCdpUpstream,
		private readonly logService: ILogService,
	) {
		super();
	}

	// --- ルーティング判定 ---

	isGatewayHttpRequest(req: http.IncomingMessage): boolean {
		if (req.method !== 'GET') {
			return false;
		}
		const pathname = this._pathnameOf(req);
		return pathname !== undefined && JSON_PATHS.has(normalizePath(pathname));
	}

	// --- HTTP（/json/*） ---

	async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const pathname = normalizePath(this._pathnameOf(req) ?? '/');
		try {
			if (!isLoopback(req.socket.remoteAddress)) {
				this._sendJson(res, 403, { error: 'Loopback connections only.' });
				return;
			}
			if (pathname === '/json/protocol') {
				this._sendJson(res, 200, await this.upstream.fetchJson('/json/protocol'));
				return;
			}
			const token = await this._resolveToken(req);
			const host = req.headers.host ?? '127.0.0.1';
			if (pathname === '/json/version') {
				const body = await this.upstream.fetchJson('/json/version') as Record<string, unknown>;
				const paneQuery = token ? `?pane=${encodeURIComponent(token)}` : '';
				this._sendJson(res, 200, {
					...body,
					webSocketDebuggerUrl: `ws://${host}/cdp/devtools/browser/${this._browserWsIdFor(token ?? '')}${paneQuery}`,
				});
				return;
			}
			// /json または /json/list
			const targetId = token ? await this.delegate.ensureBoundTargetId(token) : undefined;
			if (!token || !targetId) {
				// トークン不明またはバインド無し: 空一覧（クライアントには「ページが無い」と見える）
				this._sendJson(res, 200, []);
				return;
			}
			const raw = await this.upstream.fetchJson('/json/list') as Array<Record<string, unknown>>;
			const paneQuery = `?pane=${encodeURIComponent(token)}`;
			const out = raw
				.filter(t => typeof t.id === 'string' && t.id === targetId)
				.map(t => ({
					...t,
					// Electronは埋め込みビューを `type: "webview"` で公開しうるが、puppeteerの
					// browser.pages() は type==='page' しか数えないため書き換える
					type: t.type === 'webview' ? 'page' : t.type,
					webSocketDebuggerUrl: `ws://${host}/cdp/devtools/page/${targetId}${paneQuery}`,
					devtoolsFrontendUrl: `http://${host}/cdp/devtools/page/${targetId}${paneQuery}`,
				}));
			this._sendJson(res, 200, out);
		} catch (error) {
			this.logService.warn('[ParadisCdpGateway] request error', error);
			this._sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	// --- WebSocket upgrade（/devtools/*） ---

	async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		try {
			const pathname = normalizePath(this._pathnameOf(req) ?? '/');
			const browserMatch = pathname.match(/^\/devtools\/browser\/[^/]+$/);
			const pageMatch = pathname.match(/^\/devtools\/page\/([^/]+)$/);
			if (!browserMatch && !pageMatch) {
				socket.destroy();
				return;
			}
			const s = socket as unknown as Socket;
			if (!isLoopback(s.remoteAddress)) {
				socket.destroy();
				return;
			}
			const token = await this._resolveToken(req);
			const upstreamPort = await this.upstream.resolvePort();
			if (!upstreamPort) {
				socket.destroy();
				return;
			}
			const ws = await this._getWsModule();
			const wss = this._getWss(ws);
			if (this._store.isDisposed) {
				socket.destroy();
				return;
			}

			if (pageMatch) {
				// ページレベル: 要求されたtargetIdがバインド済みセットに含まれる場合のみ許可
				const tid = pageMatch[1];
				const boundTid = token ? await this.delegate.ensureBoundTargetId(token) : undefined;
				if (!token || !tid || tid !== boundTid) {
					socket.destroy();
					return;
				}
				paradisProxyPageUpgrade(req, socket, head, ws, wss, upstreamPort, tid, this._makeContext(token), this.logService);
				return;
			}

			// ブラウザレベル: トークン未解決/バインド無しでも接続自体は許可する
			// （chrome-devtools-mcp等のハンドシェイクを通すため。見えるターゲットは0件）。
			// バインドは boundTargetIds() クロージャ経由で毎回参照されるため、
			// 接続後にバインドされた場合も追加のターゲットが見えるようになる。
			if (token) {
				await this.delegate.ensureBoundTargetId(token); // キャッシュを温める（同期クロージャ用）
			}
			const version = await this.upstream.fetchJson('/json/version') as { webSocketDebuggerUrl?: string };
			if (!version.webSocketDebuggerUrl) {
				socket.destroy();
				return;
			}
			const upstreamUrl = new URL(version.webSocketDebuggerUrl);
			upstreamUrl.host = `127.0.0.1:${upstreamPort}`;
			await paradisProxyBrowserUpgrade(req, socket, head, ws, wss, upstreamPort, upstreamUrl.toString(), this._makeContext(token), this.logService);
		} catch (error) {
			this.logService.warn('[ParadisCdpGateway] upgrade error', error);
			socket.destroy();
		}
	}

	// --- バインド変更時の強制切断 ---

	/** 指定トークンのアクティブなCDP接続を強制切断する（クライアントは次のツール呼び出しで再接続する）。 */
	closeConnectionsForToken(token: string): void {
		const set = this._connectionsByToken.get(token);
		if (!set || set.size === 0) {
			return;
		}
		this.logService.debug(`[ParadisCdpGateway] Closing ${set.size} CDP connection(s) for pane ${token} (binding changed)`);
		for (const ws of [...set]) {
			try {
				ws.close(1000, 'para-code: binding changed, reconnect');
			} catch {
				// ignore
			}
		}
		this._connectionsByToken.delete(token);
	}

	/**
	 * ペイントークンを退役させる (ペイン/ウィンドウ終了時にサービス側から呼ぶ)。
	 * アクティブ接続を切断し、トークン別にキャッシュしていた飾りのブラウザWS id も落として
	 * トークン数に比例した単調リークを防ぐ。
	 */
	retireToken(token: string): void {
		this.closeConnectionsForToken(token);
		this._browserWsIds.delete(token);
	}

	override dispose(): void {
		for (const token of [...this._connectionsByToken.keys()]) {
			this.closeConnectionsForToken(token);
		}
		this._wss?.close();
		this._wss = undefined;
		super.dispose();
	}

	// --- 内部ヘルパー ---

	private _makeContext(token: string | undefined): IParadisBoundContext {
		return {
			boundTargetIds: () => {
				const tid = token ? this.delegate.getBoundTargetId(token) : undefined;
				return tid ? new Set([tid]) : new Set<string>();
			},
			captureBoundPageScreenshot: options => token ? this.delegate.captureBoundPageScreenshot(token, options) : Promise.resolve(undefined),
			focusBoundPage: () => {
				if (token) {
					this.delegate.focusBoundPage(token);
				}
			},
			onOpen: ws => {
				if (!token) {
					return;
				}
				let set = this._connectionsByToken.get(token);
				if (!set) {
					set = new Set();
					this._connectionsByToken.set(token, set);
				}
				set.add(ws);
				ws.on('close', () => {
					const current = this._connectionsByToken.get(token);
					current?.delete(ws);
					if (current && current.size === 0) {
						this._connectionsByToken.delete(token);
					}
				});
			},
		};
	}

	/**
	 * 接続元のペイントークンを解決する（`?pane=`クエリ → ピアPID解決の順）。
	 * ピアPID解決はソケット単位でメモ化する（keep-alive接続での再exec回避。正の解決のみ。
	 * 負の結果は一時的なレース—lsofの追い越し等—でありうるためメモ化しない）。
	 */
	private async _resolveToken(req: http.IncomingMessage): Promise<string | undefined> {
		const queryToken = this._queryPaneOf(req);
		if (queryToken) {
			return queryToken;
		}
		const s = req.socket as Socket;
		const cached = this._socketTokens.get(s);
		if (cached) {
			return cached;
		}
		const remotePort = s.remotePort;
		if (typeof remotePort !== 'number') {
			return undefined;
		}
		const token = await paradisResolvePaneTokenForPeerPort(remotePort, process.pid, {
			getTokenForShellPid: pid => this.delegate.getTokenForShellPid(pid),
		});
		if (token) {
			this._socketTokens.set(s, token);
		} else {
			this.logService.debug(`[ParadisCdpGateway] Could not resolve pane token for peer port ${remotePort}`);
		}
		return token;
	}

	private _pathnameOf(req: http.IncomingMessage): string | undefined {
		try {
			return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
		} catch {
			return undefined;
		}
	}

	private _queryPaneOf(req: http.IncomingMessage): string | undefined {
		try {
			return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('pane') || undefined;
		} catch {
			return undefined;
		}
	}

	private _browserWsIdFor(token: string): string {
		let id = this._browserWsIds.get(token);
		if (!id) {
			id = randomBytes(16).toString('hex');
			this._browserWsIds.set(token, id);
		}
		return id;
	}

	private _getWsModule(): Promise<IParadisWsModule> {
		this._wsModulePromise ??= import('ws').then(m => ({ WebSocket: m.WebSocket, WebSocketServer: m.WebSocketServer }));
		return this._wsModulePromise;
	}

	private _getWss(ws: IParadisWsModule): wsTypes.WebSocketServer {
		this._wss ??= new ws.WebSocketServer({ noServer: true });
		return this._wss;
	}

	private _sendJson(res: http.ServerResponse, status: number, body: unknown): void {
		if (!res.headersSent) {
			res.writeHead(status, { 'Content-Type': 'application/json' });
		}
		res.end(JSON.stringify(body));
	}
}
