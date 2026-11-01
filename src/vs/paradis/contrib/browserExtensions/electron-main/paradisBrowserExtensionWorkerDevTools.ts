/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能の背景の処理（service worker）の DevTools を、管理画面から別のウィンドウで開く（Q527）。
//
// Electron の ServiceWorkerMain には webContents も inspect も無く、webContents.inspectServiceWorker() は対象を
// 選べない。そこで、アプリ本体の remote-debugging のポートの `/json/list` から、その拡張機能の worker
// （type: service_worker、url: chrome-extension://<id>/…）を選び、DevTools の画面（worker_app.html）をその target に
// 繋いで開く。エージェント向けの CDP ゲートウェイ（拡張機能の target を隠す）は通さない。
//
// Chromium の remote debugging は、Origin の付いた WebSocket を `--remote-allow-origins` に無い限り断る（DevTools の画面は
// Origin: devtools://devtools を付ける）。起動時の引数（upstream の mainImpl.ts）は変えず、ここで localhost に小さな
// 中継を立てる。中継は、開いたウィンドウごとの乱数の token が URL にあり、Origin が devtools://devtools のものだけを
// 受け、Origin を外して上流へ渡す（ウェブのページからの WebSocket は Origin が違うので通らない）。
// 中継は最初の 1 要求（WebSocket への切り替え）だけを通し、上流が 101 で切り替えるまでクライアントの続きを渡さない
// （切り替わらなかった接続で、2 本目の要求をほかの target へ送らせない）。DevTools の窓を全部閉じたら待ち受けも止める。
// DevTools の窓は親を持たないので、作業ウィンドウが全部閉じたら一緒に閉じる（Windows・Linux は window-all-closed で終わるため）。
//
// Electron 43.7.7 と 43.8.3 の Linux で、この経路（43.8.3 ではこのファイルそのもの）で worker の console と評価が使えることを
// 確かめた（2026-11-02）。

import * as electron from 'electron';
import { randomBytes } from 'crypto';
import { createServer, connect, Server, Socket } from 'net';
import { raceTimeout } from '../../../../base/common/async.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ParadisCdpUpstreamPortPin, readBoundedText } from '../../agentBrowser/electron-main/paradisCdpUpstreamPortPin.js';
import type { ParadisOpenWorkerDevToolsResult } from '../common/paradisBrowserExtensions.js';

/** DevTools の画面の Origin（Chromium の bundled frontend）。 */
const DEVTOOLS_ORIGIN = 'devtools://devtools';
/** 中継が読む、WebSocket の始まりの要求の大きさの上限。 */
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const FETCH_TIMEOUT_MS = 2_000;
const PORT_WAIT_MS = 5_000;
const WAKE_TIMEOUT_MS = 10_000;

/** `/json/list` の 1 件の、ここで使うところ。 */
interface ITargetEntry {
	readonly id: string;
	readonly type: string;
	readonly url: string;
}

/** `/json/list` の答えから、その拡張機能の worker の target の id を選ぶ（無ければ undefined）。 */
export function paradisPickWorkerTarget(list: unknown, extensionId: string): string | undefined {
	if (!Array.isArray(list)) {
		return undefined;
	}
	const prefix = `chrome-extension://${extensionId}/`;
	const found = list.find((entry): entry is ITargetEntry => !!entry && typeof entry === 'object'
		&& (entry as ITargetEntry).type === 'service_worker'
		&& typeof (entry as ITargetEntry).url === 'string' && (entry as ITargetEntry).url.startsWith(prefix)
		&& typeof (entry as ITargetEntry).id === 'string' && /^[0-9A-Fa-f]{1,64}$/.test((entry as ITargetEntry).id));
	return found?.id;
}

/**
 * 中継が受けた WebSocket の始まりの要求を確かめ、上流へ送る要求にする。受けてはいけないものは undefined。
 * `tokens` は今開いている DevTools のウィンドウの token → target の id。
 */
export function paradisRewriteDevToolsHandshake(head: string, upstreamPort: number, tokens: ReadonlyMap<string, string>): { readonly token: string; readonly request: string } | undefined {
	const lines = head.split('\r\n');
	const request = /^GET \/(?<token>[0-9a-f]{64})\/devtools\/page\/(?<target>[0-9A-Fa-f]{1,64}) HTTP\/1\.1$/.exec(lines[0]);
	if (!request?.groups) {
		return undefined;
	}
	const values = (name: string) => lines.filter(line => line.toLowerCase().startsWith(`${name}:`)).map(line => line.slice(name.length + 1).trim());
	const origins = values('origin');
	const upgrades = values('upgrade');
	const connection = values('connection').join(',').toLowerCase().split(',').map(part => part.trim());
	if (origins.length !== 1 || origins[0] !== DEVTOOLS_ORIGIN || tokens.get(request.groups.token) !== request.groups.target
		|| upgrades.length !== 1 || upgrades[0].toLowerCase() !== 'websocket' || !connection.includes('upgrade')) {
		return undefined;
	}
	const rest = lines.slice(1).filter(line => line.length > 0 && !/^(origin|host):/i.test(line));
	return { token: request.groups.token, request: [`GET /devtools/page/${request.groups.target} HTTP/1.1`, `Host: 127.0.0.1:${upstreamPort}`, ...rest].join('\r\n') + '\r\n\r\n' };
}

/** DevTools の窓（Electron の BrowserWindow の、ここで使うところ）。 */
export interface IParadisDevToolsWindow {
	load(url: string): Promise<void>;
	show(): void;
	isDestroyed(): boolean;
	close(): void;
	onDidClose(listener: () => void): void;
	/** 元の BrowserWindow（作業ウィンドウと見分けるのに使う）。 */
	readonly native?: object;
}

/** DevTools を開くのに使う外のもの（テストでは偽物を渡す）。 */
export interface IParadisWorkerDevToolsEnvironment {
	/** アプリ本体の remote-debugging のポート（確かめられなければ undefined）。 */
	resolvePort(): Promise<number | undefined>;
	/** そのポートの `/json/list`（読めなければ undefined）。 */
	fetchTargets(port: number): Promise<unknown>;
	createWindow(title: string): IParadisDevToolsWindow;
	/** DevTools の窓のほかのウィンドウ（作業ウィンドウ）が全部閉じたら `listener` を呼ぶ。返り値で外す。 */
	onDidCloseLastOtherWindow(isDevToolsWindow: (window: unknown) => boolean, listener: () => void): IDisposable;
}

/** Electron を使う既定の外のもの。 */
function electronEnvironment(): IParadisWorkerDevToolsEnvironment {
	// ポートは開くときに初めて確かめる（作るだけでは Electron とファイルに触らない）。確かめ方は ParadisCdpUpstreamPortPin と同じで、
	// DevToolsActivePort を 2 つ目の Para Code が上書きしていたら、このプロセスのものと確かめられず開かない
	const portPin = new ParadisCdpUpstreamPortPin();
	return {
		resolvePort: () => portPin.resolveWithin(PORT_WAIT_MS),
		fetchTargets: async port => {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
				return response.ok ? JSON.parse(await readBoundedText(response)) : undefined;
			} catch {
				return undefined;
			}
		},
		createWindow: title => {
			const window = new electron.BrowserWindow({ width: 1000, height: 700, title, autoHideMenuBar: true });
			// DevTools の画面がページの題名で上書きしないよう、最初の題名を保つ
			window.on('page-title-updated', event => event.preventDefault());
			return {
				load: async url => { await window.loadURL(url); },
				show: () => {
					window.show();
					window.focus();
				},
				isDestroyed: () => window.isDestroyed(),
				close: () => window.close(),
				onDidClose: listener => window.on('closed', listener),
				native: window,
			};
		},
		onDidCloseLastOtherWindow: (isDevToolsWindow, listener) => {
			let disposed = false;
			const hooked = new WeakSet<object>();
			const hook = (window: electron.BrowserWindow) => {
				if (hooked.has(window) || isDevToolsWindow(window)) {
					return;
				}
				hooked.add(window);
				window.once('closed', () => {
					// 作られた時にはまだ DevTools の窓と分からないことがある（作ってから台帳に入れる）ので、閉じた時にも見る
					if (!disposed && !isDevToolsWindow(window) && electron.BrowserWindow.getAllWindows().every(other => other === window || other.isDestroyed() || isDevToolsWindow(other))) {
						listener();
					}
				});
			};
			electron.BrowserWindow.getAllWindows().forEach(hook);
			const onCreated = (_event: unknown, window: electron.BrowserWindow) => hook(window);
			electron.app.on('browser-window-created', onCreated);
			return toDisposable(() => {
				disposed = true;
				electron.app.removeListener('browser-window-created', onCreated);
			});
		},
	};
}

interface IOpenWindow {
	readonly window: IParadisDevToolsWindow;
	readonly target: string;
	readonly token: string;
}

export class ParadisBrowserExtensionWorkerDevTools implements IDisposable {

	private readonly _environment: IParadisWorkerDevToolsEnvironment;
	/** 開いている DevTools のウィンドウの token → target の id。 */
	private readonly _tokens = new Map<string, string>();
	/** token → その token で張った中継の接続（窓を閉じたら切る）。 */
	private readonly _tokenSockets = new Map<string, Set<Socket>>();
	/** 拡張機能の id → 開いている DevTools のウィンドウ（同じものは前に出す）。 */
	private readonly _windows = new Map<string, IOpenWindow>();
	/** 拡張機能の id → 開いている途中（続けて押しても 1 枚にする）。 */
	private readonly _opening = new Map<string, Promise<ParadisOpenWorkerDevToolsResult>>();
	private _relay: Promise<{ readonly server: Server; readonly port: number }> | undefined;
	private readonly _sockets = new Set<Socket>();
	private _windowWatch: IDisposable | undefined;
	private _disposed = false;

	constructor(
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
		environment?: IParadisWorkerDevToolsEnvironment,
	) {
		this._environment = environment ?? electronEnvironment();
	}

	dispose(): void {
		this._disposed = true;
		this._closeAll();
	}

	/** 開いている DevTools の窓の数（テスト用）。 */
	get openWindowCount(): number {
		return this._windows.size;
	}

	/** その拡張機能の worker の DevTools を開く。`wake` は止まっている worker を起こす（起こせなければ false）。 */
	open(extensionId: string, title: string, wake: () => Promise<boolean>): Promise<ParadisOpenWorkerDevToolsResult> {
		let opening = this._opening.get(extensionId);
		if (!opening) {
			opening = this._open(extensionId, title, wake).finally(() => this._opening.delete(extensionId));
			this._opening.set(extensionId, opening);
		}
		return opening;
	}

	private async _open(extensionId: string, title: string, wake: () => Promise<boolean>): Promise<ParadisOpenWorkerDevToolsResult> {
		const port = await this._environment.resolvePort();
		if (port === undefined) {
			return { ok: false, reason: 'noDebugPort' };
		}
		let target = paradisPickWorkerTarget(await this._environment.fetchTargets(port), extensionId);
		if (target === undefined) {
			// 起こすのが返ってこなくても、開いている途中のまま残さない（続けて押すと同じ待ちを返すため）
			if (!(await raceTimeout(wake(), WAKE_TIMEOUT_MS, () => undefined))) {
				return { ok: false, reason: 'notRunning' };
			}
			target = paradisPickWorkerTarget(await this._environment.fetchTargets(port), extensionId);
			if (target === undefined) {
				return { ok: false, reason: 'notRunning' };
			}
		}
		const existing = this._windows.get(extensionId);
		if (existing && !existing.window.isDestroyed() && existing.target === target) {
			existing.window.show();
			return { ok: true };
		}
		if (existing && !existing.window.isDestroyed()) {
			existing.window.close();
		}
		try {
			const relay = await this._ensureRelay(port);
			if (this._disposed) {
				return { ok: false, reason: 'failed' };
			}
			const token = randomBytes(32).toString('hex');
			this._tokens.set(token, target);
			const window = this._environment.createWindow(title);
			const entry: IOpenWindow = { window, target, token };
			this._windows.set(extensionId, entry);
			this._windowWatch ??= this._environment.onDidCloseLastOtherWindow(candidate => [...this._windows.values()].some(open => (open.window.native ?? open.window) === candidate), () => this._closeAll());
			window.onDidClose(() => this._forgetWindow(extensionId, entry));
			await window.load(`devtools://devtools/bundled/worker_app.html?ws=127.0.0.1:${relay.port}/${token}/devtools/page/${target}`);
			return { ok: true };
		} catch (error) {
			this._logService.warn('[paradis] could not open DevTools for a browser extension worker', error);
			return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 窓が閉じた: その token と接続を捨て、窓が無くなったら中継と見張りを止める。 */
	private _forgetWindow(extensionId: string, entry: IOpenWindow): void {
		this._tokens.delete(entry.token);
		for (const socket of this._tokenSockets.get(entry.token) ?? []) {
			socket.destroy();
		}
		this._tokenSockets.delete(entry.token);
		if (this._windows.get(extensionId) === entry) {
			this._windows.delete(extensionId);
		}
		if (this._windows.size === 0) {
			this._stopRelay();
		}
	}

	private _closeAll(): void {
		for (const { window } of [...this._windows.values()]) {
			if (!window.isDestroyed()) {
				window.close();
			}
		}
		this._windows.clear();
		this._tokens.clear();
		this._tokenSockets.clear();
		this._stopRelay();
	}

	private _stopRelay(): void {
		this._windowWatch?.dispose();
		this._windowWatch = undefined;
		for (const socket of this._sockets) {
			socket.destroy();
		}
		this._sockets.clear();
		const relay = this._relay;
		this._relay = undefined;
		void relay?.then(({ server }) => server.close(), () => undefined);
	}

	private _ensureRelay(upstreamPort: number): Promise<{ readonly server: Server; readonly port: number }> {
		if (!this._relay) {
			const relay = new Promise<{ readonly server: Server; readonly port: number }>((resolve, reject) => {
				const server = createServer(client => this._relayConnection(client, upstreamPort));
				server.on('error', reject);
				server.listen(0, '127.0.0.1', () => {
					const address = server.address();
					if (address && typeof address === 'object') {
						resolve({ server, port: address.port });
					} else {
						reject(new Error('The DevTools relay has no port'));
					}
				});
			});
			relay.catch(() => {
				if (this._relay === relay) {
					this._relay = undefined;
				}
			});
			this._relay = relay;
		}
		return this._relay;
	}

	private _track(socket: Socket, token?: string): void {
		this._sockets.add(socket);
		let byToken: Set<Socket> | undefined;
		if (token !== undefined) {
			byToken = this._tokenSockets.get(token);
			if (!byToken) {
				byToken = new Set();
				this._tokenSockets.set(token, byToken);
			}
			byToken.add(socket);
		}
		socket.on('close', () => {
			this._sockets.delete(socket);
			byToken?.delete(socket);
		});
	}

	private _relayConnection(client: Socket, upstreamPort: number): void {
		this._track(client);
		client.on('error', () => client.destroy());
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf('\r\n\r\n');
			if (end < 0) {
				if (buffered.length > MAX_HANDSHAKE_BYTES) {
					client.destroy();
				}
				return;
			}
			// 最初の 1 要求だけを読む。続き（あれば）は上流が 101 で切り替えるまで渡さない
			client.removeListener('data', onData);
			client.pause();
			const rewritten = paradisRewriteDevToolsHandshake(buffered.subarray(0, end).toString('latin1'), upstreamPort, this._tokens);
			if (rewritten === undefined) {
				client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
				return;
			}
			this._track(client, rewritten.token);
			const pending = buffered.subarray(end + 4);
			const upstream = connect(upstreamPort, '127.0.0.1', () => upstream.write(rewritten.request));
			this._track(upstream, rewritten.token);
			upstream.on('error', () => upstream.destroy());
			upstream.on('close', () => client.destroy());
			client.on('close', () => upstream.destroy());
			let answer = Buffer.alloc(0);
			const onAnswer = (chunk: Buffer) => {
				answer = Buffer.concat([answer, chunk]);
				const answerEnd = answer.indexOf('\r\n\r\n');
				if (answerEnd < 0) {
					if (answer.length > MAX_HANDSHAKE_BYTES) {
						upstream.destroy();
					}
					return;
				}
				upstream.removeListener('data', onAnswer);
				if (!/^HTTP\/1\.1 101 /.test(answer.subarray(0, answerEnd).toString('latin1'))) {
					// 切り替わらなかった: 答えだけ返して閉じる（同じ接続で次の要求を送らせない）
					client.end(answer);
					upstream.destroy();
					return;
				}
				client.write(answer);
				if (pending.length > 0) {
					upstream.write(pending);
				}
				client.pipe(upstream);
				upstream.pipe(client);
				client.resume();
			};
			upstream.on('data', onAnswer);
		};
		client.on('data', onData);
	}
}
