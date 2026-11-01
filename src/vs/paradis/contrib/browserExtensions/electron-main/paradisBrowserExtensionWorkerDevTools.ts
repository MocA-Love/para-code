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
// Electron 43.7.7 と 43.8.3 の Linux で、この経路（43.8.3 ではこのファイルそのもの）で worker の console と評価が使えることを
// 確かめた（2026-11-02）。

import * as electron from 'electron';
import type { BrowserWindow } from 'electron';
import { randomBytes } from 'crypto';
import { createServer, connect, Server, Socket } from 'net';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ParadisCdpUpstreamPortPin, readBoundedText } from '../../agentBrowser/electron-main/paradisCdpUpstreamPortPin.js';
import type { ParadisOpenWorkerDevToolsResult } from '../common/paradisBrowserExtensions.js';

/** DevTools の画面の Origin（Chromium の bundled frontend）。 */
const DEVTOOLS_ORIGIN = 'devtools://devtools';
/** 中継が読む、WebSocket の始まりの要求の大きさの上限。 */
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const FETCH_TIMEOUT_MS = 2_000;
const PORT_WAIT_MS = 5_000;

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
export function paradisRewriteDevToolsHandshake(head: string, upstreamPort: number, tokens: ReadonlyMap<string, string>): string | undefined {
	const lines = head.split('\r\n');
	const request = /^GET \/(?<token>[0-9a-f]{64})\/devtools\/page\/(?<target>[0-9A-Fa-f]{1,64}) HTTP\/1\.1$/.exec(lines[0]);
	if (!request?.groups) {
		return undefined;
	}
	const origins = lines.filter(line => /^origin:/i.test(line)).map(line => line.replace(/^origin:\s*/i, '').trim());
	if (origins.length !== 1 || origins[0] !== DEVTOOLS_ORIGIN || tokens.get(request.groups.token) !== request.groups.target) {
		return undefined;
	}
	const rest = lines.slice(1).filter(line => line.length > 0 && !/^(origin|host):/i.test(line));
	return [`GET /devtools/page/${request.groups.target} HTTP/1.1`, `Host: 127.0.0.1:${upstreamPort}`, ...rest].join('\r\n') + '\r\n\r\n';
}

export class ParadisBrowserExtensionWorkerDevTools implements IDisposable {

	private readonly _portPin = new ParadisCdpUpstreamPortPin();
	/** 開いている DevTools のウィンドウの token → target の id。 */
	private readonly _tokens = new Map<string, string>();
	/** 拡張機能の id → 開いている DevTools のウィンドウ（同じものは前に出す）。 */
	private readonly _windows = new Map<string, { readonly window: BrowserWindow; readonly target: string }>();
	private _relay: Promise<{ readonly server: Server; readonly port: number }> | undefined;
	private readonly _sockets = new Set<Socket>();
	private _disposed = false;

	// ポートは開くときに初めて確かめる（作るだけでは Electron とファイルに触らない）。確かめ方は ParadisCdpUpstreamPortPin と同じで、
	// DevToolsActivePort を 2 つ目の Para Code が上書きしていたら、このプロセスのものと確かめられず開かない
	constructor(private readonly _logService: { warn(message: string, ...args: unknown[]): void }) { }

	dispose(): void {
		this._disposed = true;
		for (const { window } of this._windows.values()) {
			if (!window.isDestroyed()) {
				window.close();
			}
		}
		this._windows.clear();
		this._tokens.clear();
		for (const socket of this._sockets) {
			socket.destroy();
		}
		void this._relay?.then(({ server }) => server.close(), () => undefined);
	}

	/** その拡張機能の worker の DevTools を開く。`wake` は止まっている worker を起こす（起こせなければ false）。 */
	async open(extensionId: string, title: string, wake: () => Promise<boolean>): Promise<ParadisOpenWorkerDevToolsResult> {
		const port = await this._portPin.resolveWithin(PORT_WAIT_MS);
		if (port === undefined) {
			return { ok: false, reason: 'noDebugPort' };
		}
		let target = await this._findTarget(port, extensionId);
		if (target === undefined) {
			if (!(await wake())) {
				return { ok: false, reason: 'notRunning' };
			}
			target = await this._findTarget(port, extensionId);
			if (target === undefined) {
				return { ok: false, reason: 'notRunning' };
			}
		}
		const existing = this._windows.get(extensionId);
		if (existing && !existing.window.isDestroyed() && existing.target === target) {
			existing.window.show();
			existing.window.focus();
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
			const window = new electron.BrowserWindow({ width: 1000, height: 700, title, autoHideMenuBar: true });
			this._windows.set(extensionId, { window, target });
			window.on('closed', () => {
				this._tokens.delete(token);
				if (this._windows.get(extensionId)?.window === window) {
					this._windows.delete(extensionId);
				}
			});
			// DevTools の画面がページの題名で上書きしないよう、最初の題名を保つ
			window.on('page-title-updated', event => event.preventDefault());
			await window.loadURL(`devtools://devtools/bundled/worker_app.html?ws=127.0.0.1:${relay.port}/${token}/devtools/page/${target}`);
			return { ok: true };
		} catch (error) {
			this._logService.warn('[paradis] could not open DevTools for a browser extension worker', error);
			return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
	}

	private async _findTarget(port: number, extensionId: string): Promise<string | undefined> {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			return response.ok ? paradisPickWorkerTarget(JSON.parse(await readBoundedText(response)), extensionId) : undefined;
		} catch {
			return undefined;
		}
	}

	private _ensureRelay(upstreamPort: number): Promise<{ readonly server: Server; readonly port: number }> {
		this._relay ??= new Promise((resolve, reject) => {
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
		this._relay.catch(() => this._relay = undefined);
		return this._relay;
	}

	private _relayConnection(client: Socket, upstreamPort: number): void {
		this._sockets.add(client);
		client.on('close', () => this._sockets.delete(client));
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
			client.removeListener('data', onData);
			const rewritten = paradisRewriteDevToolsHandshake(buffered.subarray(0, end).toString('latin1'), upstreamPort, this._tokens);
			if (rewritten === undefined) {
				client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
				return;
			}
			const upstream = connect(upstreamPort, '127.0.0.1', () => {
				upstream.write(rewritten);
				upstream.write(buffered.subarray(end + 4));
				client.pipe(upstream);
				upstream.pipe(client);
			});
			this._sockets.add(upstream);
			upstream.on('close', () => {
				this._sockets.delete(upstream);
				client.destroy();
			});
			upstream.on('error', () => upstream.destroy());
			client.on('close', () => upstream.destroy());
		};
		client.on('data', onData);
	}
}
