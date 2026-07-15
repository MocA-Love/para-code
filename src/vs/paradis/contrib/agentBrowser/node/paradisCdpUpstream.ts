/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code（Electron）本体のremote-debuggingエンドポイント（上流CDP）の発見と参照。
// electron-mainが `--remote-debugging-port=0` で起動すると、Chromiumが
// `<userDataDir>/DevToolsActivePort` に実際のポート番号を書き出す（1行目）。
// shared processはそのファイルを読んで上流ポートを解決する（動的割当なので
// 複数インスタンス起動時のポート衝突が起きない）。
//
// 【重要】この生ポートはフィルタ無しで全webContents（ワークベンチウィンドウ含む）に
// 触れられる。Chromiumは remote-debugging を 127.0.0.1 にのみバインドするが、
// 詳細な扱いは NOTES.md の「CDPゲートウェイとリモートデバッグ」を参照。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
const UPSTREAM_FETCH_TIMEOUT_MS = 5_000;
const MAX_DEVTOOLS_PORT_FILE_BYTES = 128;
const MAX_UPSTREAM_JSON_BYTES = 8 * 1024 * 1024;

type ParadisCdpFetchResponse = Pick<Response, 'ok' | 'status'> & Partial<Pick<Response, 'body' | 'arrayBuffer'>>;

export interface IParadisCdpUpstreamOptions {
	readonly openFile?: typeof fs.open;
	readonly fetch?: (url: string, init?: RequestInit) => Promise<ParadisCdpFetchResponse>;
	readonly fetchTimeoutMs?: number;
}

export interface IParadisCdpUpstreamJsonResult<T> {
	/** Parsed JSON returned by the upstream endpoint. */
	readonly value: T;
	/** Exact port used by the successful request that produced {@link value}. */
	readonly port: number;
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 上流（Electron本体）のCDPエンドポイント解決器。
 * ポートはアプリ起動中は不変なので、一度読めたらキャッシュする。
 */
export class ParadisCdpUpstream {

	private _cachedPort: number | undefined;
	private readonly openFileImpl: typeof fs.open;
	private readonly fetchImpl: NonNullable<IParadisCdpUpstreamOptions['fetch']>;
	private readonly fetchTimeoutMs: number;

	constructor(
		private readonly userDataPath: string,
		private readonly logService: ILogService,
		options: IParadisCdpUpstreamOptions = {},
	) {
		this.openFileImpl = options.openFile ?? fs.open;
		this.fetchImpl = options.fetch ?? fetch;
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? UPSTREAM_FETCH_TIMEOUT_MS;
	}

	/**
	 * `DevToolsActivePort` ファイルから上流CDPポートを解決する。
	 * ファイルがまだ書かれていない起動直後に備えて短いリトライを行う。
	 */
	async resolvePort(timeoutMs = 5000): Promise<number | undefined> {
		if (this._cachedPort !== undefined) {
			return this._cachedPort;
		}
		const deadline = Date.now() + timeoutMs;
		for (; ;) {
			const port = await this._readPortFile();
			if (port !== undefined) {
				this._cachedPort = port;
				this._infoNonThrowing('[ParadisCdpGateway] Upstream CDP port resolved');
				return port;
			}
			if (Date.now() >= deadline) {
				this._warnNonThrowing('[ParadisCdpGateway] Upstream CDP endpoint is unavailable');
				return undefined;
			}
			await delay(100);
		}
	}

	/**
	 * 上流の `/json/*` エンドポイントを取得する。
	 *
	 * ポート更新リトライ後に成功したJSONと、その成功attemptが実際に使ったポートを
	 * 同じ結果として返す。呼び出し側が古いresolvePort結果と新しいJSONを誤って
	 * 組み合わせないためのauthority境界でもある。
	 */
	async fetchJsonWithPort<T = unknown>(path: string): Promise<IParadisCdpUpstreamJsonResult<T>> {
		if (!/^\/json(?:\/|$)[a-z]*$/i.test(path) || path.length > 64) {
			throw new Error('Invalid upstream CDP JSON path');
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const port = await this.resolvePort();
				if (!port) {
					throw new Error('Upstream Chromium CDP port not available');
				}
				const res = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
					signal: AbortSignal.timeout(this.fetchTimeoutMs),
				});
				if (!res.ok) {
					throw new Error(`Upstream CDP returned ${res.status} for ${path}`);
				}
				const value = await this._readBoundedJson(res) as T;
				return { value, port };
			} catch (error) {
				this._cachedPort = undefined;
				if (attempt === 1) {
					throw new Error('Upstream CDP fetch failed after port refresh', { cause: error });
				}
			}
		}
		throw new Error('Upstream CDP fetch failed after port refresh');
	}

	/** 上流の `/json/*` エンドポイントを取得してJSONだけを返す。 */
	async fetchJson<T = unknown>(path: string): Promise<T> {
		return (await this.fetchJsonWithPort<T>(path)).value;
	}

	private async _readPortFile(): Promise<number | undefined> {
		let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
		try {
			handle = await this.openFileImpl(join(this.userDataPath, DEVTOOLS_PORT_FILE), 'r');
			const buffer = Buffer.allocUnsafe(MAX_DEVTOOLS_PORT_FILE_BYTES + 1);
			let bytesRead = 0;
			while (bytesRead < buffer.byteLength) {
				const requested = buffer.byteLength - bytesRead;
				const read = await handle.read(buffer, bytesRead, requested, bytesRead);
				if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > requested) {
					return undefined;
				}
				if (read.bytesRead === 0) {
					break;
				}
				bytesRead += read.bytesRead;
			}
			if (bytesRead > MAX_DEVTOOLS_PORT_FILE_BYTES) {
				return undefined;
			}
			const contents = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
			const firstLine = contents.split(/\r?\n/, 1)[0];
			if (!firstLine || !/^[1-9][0-9]{0,4}$/.test(firstLine)) {
				return undefined;
			}
			const port = Number(firstLine);
			return Number.isSafeInteger(port) && port <= 65_535 ? port : undefined;
		} catch {
			return undefined;
		} finally {
			try { await handle?.close(); } catch { /* port discovery remains best-effort */ }
		}
	}

	private async _readBoundedJson(response: ParadisCdpFetchResponse): Promise<unknown> {
		const chunks: Uint8Array[] = [];
		let total = 0;
		if (response.body) {
			const reader = response.body.getReader();
			try {
				for (; ;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					total += value.byteLength;
					if (total > MAX_UPSTREAM_JSON_BYTES) {
						await reader.cancel();
						throw new Error('Upstream CDP JSON response exceeds the byte limit');
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
		} else if (response.arrayBuffer) {
			const value = new Uint8Array(await response.arrayBuffer());
			total = value.byteLength;
			if (total > MAX_UPSTREAM_JSON_BYTES) {
				throw new Error('Upstream CDP JSON response exceeds the byte limit');
			}
			chunks.push(value);
		} else {
			throw new Error('Upstream CDP JSON response has no readable body');
		}
		const combined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
		return JSON.parse(text) as unknown;
	}

	private _infoNonThrowing(message: string): void {
		try { this.logService.info(message); } catch { /* diagnostics are best-effort */ }
	}

	private _warnNonThrowing(message: string): void {
		try { this.logService.warn(message); } catch { /* diagnostics are best-effort */ }
	}
}
