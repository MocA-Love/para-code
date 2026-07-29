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
/** 起動直後、`DevToolsActivePort` がまだ書かれていない場合に待つ上限。 */
const PORT_FILE_RETRY_TIMEOUT_MS = 5_000;

/**
 * `/json/version` の応答が本当にこのアプリの Chromium かを確かめる。
 *
 * `DevToolsActivePort` が2つ目のプロセスに上書きされている状況では、そのポートを無関係な
 * ローカル Chromium が握っていることがある。応答が返ったというだけで固定してしまうと、
 * 他人のブラウザをエージェントへ繋いだまま貼り付いてしまう。
 *
 * 応答の `Browser` は実測で `Chrome/<process.versions.chrome と同じ版>`（Electron 42.6.0 で確認）
 * なので完全一致で見る。メジャーだけ見ると、同じ Chromium を積んだ別アプリや**もう1つの Para Code
 * 自身**が素通りしてしまう。バージョン文字列が読み取れない相手（将来の形式変更）は判定を保留して通す。
 */
function isOwnChromium(value: unknown, chromeVersion: string | undefined): boolean {
	if (!chromeVersion || !value || typeof value !== 'object') {
		return true;
	}
	const browser = (value as { Browser?: unknown }).Browser;
	if (typeof browser !== 'string' || !browser.startsWith('Chrome/')) {
		return true;
	}
	return browser.slice('Chrome/'.length) === chromeVersion;
}

type ParadisCdpFetchResponse = Pick<Response, 'ok' | 'status'> & Partial<Pick<Response, 'body' | 'arrayBuffer'>>;

export interface IParadisCdpUpstreamOptions {
	readonly openFile?: typeof fs.open;
	readonly fetch?: (url: string, init?: RequestInit) => Promise<ParadisCdpFetchResponse>;
	readonly fetchTimeoutMs?: number;
	/**
	 * 相手が自分の Chromium かを見分けるための版。既定は動作中のもの。
	 * テストは素の Node で走り `process.versions.chrome` を持たないため、明示できるようにしてある。
	 */
	readonly chromeVersion?: string;
	/**
	 * electron-main が起動直後に確定させた上流ポートを返す。
	 *
	 * `DevToolsActivePort` が起動より前に他インスタンスへ上書きされていた場合、こちらには
	 * 実績ポートが無く、ファイルには死んだ番号しか無い＝自力では絶対に戻れない。main は
	 * そのファイルを書いた本人なので、上書きより先に読んだ正しい値を持っている。
	 * 未接続・未確定なら undefined を返すこと（そのときは従来どおりファイルへ落ちる）。
	 */
	readonly resolveMainPort?: () => Promise<number | undefined>;
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
 * `<userDataPath>/DevToolsActivePort` の1行目を読む。読めない・形が違う場合は undefined。
 *
 * 中身は信用できない（下のクラスの注記を参照）ので、**この関数の戻り値は「候補」でしかない**。
 * electron-main 側（`paradisCdpUpstreamPortPin.ts`）と shared process 側で同じ読み方をするため、
 * クラスから切り出してある。
 */
export async function paradisReadDevToolsActivePort(userDataPath: string, openFile: typeof fs.open = fs.open): Promise<number | undefined> {
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		handle = await openFile(join(userDataPath, DEVTOOLS_PORT_FILE), 'r');
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

/**
 * 上流（Electron本体）のCDPエンドポイント解決器。
 *
 * **`DevToolsActivePort` は当てにならない**。Chromium はこのファイルを user-data-dir に書くが、
 * 2つ目の Para Code プロセス（macOS の `open -n`、Dock からの二重起動、自動アップデート適用時など）が
 * 起動すると、シングルインスタンスロックに気づいて終了する前に**自分のポートで上書きしてしまう**。
 * 残るのは誰も listen していないポート番号で、以降このゲートウェイは何度読み直しても死んだポートに
 * 繋ぎに行き、ブラウザ共有が恒久的に壊れる（2026-07-29 に実際に発生）。
 *
 * そのためポートは「ファイルに書いてあるもの」ではなく「実際に応答が返ったもの」を正とする。
 * 一度でも通ったポートは覚えておき、ファイルが嘘になっても自力で戻れるようにする。
 */
export class ParadisCdpUpstream {

	/**
	 * 直近の取得で使えたポート。次の取得はここから試す。
	 * 常に `_lastKnownGoodPort` と同値か `undefined`（＝直近で失敗した印）。
	 */
	private _cachedPort: number | undefined;
	/**
	 * 一度でも実際に応答が返ったポート。`DevToolsActivePort` が上書きされて嘘になっても、
	 * ここに戻ることで自己修復する。アプリが生きている限りポートは変わらないので使い回せる。
	 */
	private _lastKnownGoodPort: number | undefined;
	private readonly openFileImpl: typeof fs.open;
	private readonly fetchImpl: NonNullable<IParadisCdpUpstreamOptions['fetch']>;
	private readonly fetchTimeoutMs: number;
	private readonly chromeVersion: string | undefined;
	private readonly resolveMainPort: (() => Promise<number | undefined>) | undefined;

	constructor(
		private readonly userDataPath: string,
		private readonly logService: ILogService,
		options: IParadisCdpUpstreamOptions = {},
	) {
		this.openFileImpl = options.openFile ?? fs.open;
		this.fetchImpl = options.fetch ?? fetch;
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? UPSTREAM_FETCH_TIMEOUT_MS;
		this.chromeVersion = options.chromeVersion ?? process.versions.chrome;
		this.resolveMainPort = options.resolveMainPort;
	}

	/** electron-main の確定値。問い合わせられない場合は undefined（呼び出し側はファイルへ落ちる）。 */
	private async _readMainPort(): Promise<number | undefined> {
		if (this.resolveMainPort === undefined) {
			return undefined;
		}
		try {
			const port = await this.resolveMainPort();
			return typeof port === 'number' && Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 上流CDPポートを1つ返す。応答を確かめない用途（WebSocket を直接張るなど）向け。
	 *
	 * 実際に応答が返った実績のあるポートを最優先する。shared process はアプリと同じ寿命なので、
	 * このプロセスが生きている間はアプリのポートも変わらない＝実績ポートは必ず今も正しい。
	 * `DevToolsActivePort` は2つ目のプロセスに上書きされて嘘になりうるので、実績が無いときだけ読む。
	 * ファイルがまだ書かれていない起動直後に備えて短いリトライを行う。
	 */
	async resolvePort(timeoutMs = 5000): Promise<number | undefined> {
		const verified = this._cachedPort ?? this._lastKnownGoodPort;
		if (verified !== undefined) {
			return verified;
		}
		const fromMain = await this._readMainPort();
		if (fromMain !== undefined) {
			this._infoNonThrowing('[ParadisCdpGateway] Upstream CDP port resolved by the main process');
			return fromMain;
		}
		const port = await this._readPortFileWithRetry(timeoutMs);
		if (port !== undefined) {
			// 「読めた」だけで、その先に繋がるかはまだ誰も確かめていない。
			this._infoNonThrowing('[ParadisCdpGateway] Upstream CDP port read from DevToolsActivePort');
			return port;
		}
		this._warnNonThrowing('[ParadisCdpGateway] Upstream CDP endpoint is unavailable');
		return undefined;
	}

	/**
	 * 上流の `/json/*` エンドポイントを取得する。
	 *
	 * 成功したJSONと、その成功attemptが実際に使ったポートを同じ結果として返す。呼び出し側が
	 * 古いresolvePort結果と新しいJSONを誤って組み合わせないためのauthority境界でもある。
	 *
	 * 候補は「直近で使えたポート → 実績のあるポート → `DevToolsActivePort`」の順で、**遅延評価**する
	 * （通常は1つ目で終わるので、ファイルI/Oも追加の接続も発生しない）。ファイルを最後に置くのは、
	 * 2つ目の Para Code プロセスに上書きされて嘘になりうる唯一の情報源だから。
	 *
	 * 死んだポートは通常その場で接続を拒否されるが、**別のプロセスが後からそのポートを掴んで
	 * 無応答**だと候補ごとに `fetchTimeoutMs` を使い切る。候補は最大2つ（実績と、ファイル）なので
	 * 最悪待ち時間はその2倍。呼び出し側のサーバーは 30 秒で切るので、その内側に収まる。
	 */
	async fetchJsonWithPort<T = unknown>(path: string): Promise<IParadisCdpUpstreamJsonResult<T>> {
		if (!/^\/json(?:\/|$)[a-z]*$/i.test(path) || path.length > 64) {
			throw new Error('Invalid upstream CDP JSON path');
		}
		const tried: number[] = [];
		let lastError: unknown;
		const attempt = async (port: number | undefined): Promise<IParadisCdpUpstreamJsonResult<T> | undefined> => {
			if (port === undefined || tried.includes(port)) {
				return undefined;
			}
			tried.push(port);
			try {
				const res = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
					signal: AbortSignal.timeout(this.fetchTimeoutMs),
				});
				if (!res.ok) {
					throw new Error(`Upstream CDP returned ${res.status} for ${path}`);
				}
				const value = await this._readBoundedJson(res) as T;
				if (path.toLowerCase() === '/json/version') {
					this._assertOwnChromium(port, value);
				} else if (port !== this._lastKnownGoodPort) {
					// まだ身元を確かめていないポート。`/json/list` などの応答からは相手が誰か分からないので、
					// ここで一度だけ確かめる。確かめずに固定すると、他人のブラウザのターゲット一覧を
					// クライアントへ返したうえ、そのポートに貼り付いてしまう。
					this._assertOwnChromium(port, await this._fetchRaw(port, '/json/version'));
				}
				this._cachedPort = port;
				this._lastKnownGoodPort = port;
				return { value: value as T, port };
			} catch (error) {
				lastError = error;
				if (this._cachedPort === port) {
					this._cachedPort = undefined;
				}
				return undefined;
			}
		};

		const verified = await attempt(this._cachedPort) ?? await attempt(this._lastKnownGoodPort);
		if (verified) {
			return verified;
		}
		// 実績が無い＝冷スタート。ここで初めて main に聞く（main は `DevToolsActivePort` を
		// 書いた本人のプロセスで、上書きより先に読んだ値を持っている）。ファイルより先に置くのは、
		// ファイルだけが上書きで嘘になりうる情報源だから。
		const fromMain = await attempt(await this._readMainPort());
		if (fromMain) {
			return fromMain;
		}
		// それも駄目ならファイルを読む。起動直後はまだ書かれていないことがあるので、
		// 何も試せていない場合に限って短くリトライする。
		const fromFile = await attempt(tried.length === 0
			? await this._readPortFileWithRetry(PORT_FILE_RETRY_TIMEOUT_MS)
			: await this._readPortFile());
		if (fromFile) {
			return fromFile;
		}
		if (tried.length === 0) {
			throw new Error('Upstream Chromium CDP port not available');
		}
		// 試したポートを添える。これが無いと、ログには「全部だめだった」としか残らず、
		// 次に同じ障害が起きたときにまた lsof から始めることになる。
		throw new Error(`Upstream CDP fetch failed on every known port (${tried.join(', ')})`, { cause: lastError });
	}

	/** 上流の `/json/*` エンドポイントを取得してJSONだけを返す。 */
	async fetchJson<T = unknown>(path: string): Promise<T> {
		return (await this.fetchJsonWithPort<T>(path)).value;
	}

	/** 身元が違えば例外にし、覚えていた実績も取り消す（誤って固定したまま居座らせない）。 */
	private _assertOwnChromium(port: number, version: unknown): void {
		if (isOwnChromium(version, this.chromeVersion)) {
			return;
		}
		if (this._lastKnownGoodPort === port) {
			this._lastKnownGoodPort = undefined;
		}
		throw new Error('Upstream CDP endpoint belongs to another browser');
	}

	/** 身元確認用の素の取得。候補選びには関与しない（再帰させない）。 */
	private async _fetchRaw(port: number, path: string): Promise<unknown> {
		const res = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
			signal: AbortSignal.timeout(this.fetchTimeoutMs),
		});
		if (!res.ok) {
			throw new Error(`Upstream CDP returned ${res.status} for ${path}`);
		}
		return this._readBoundedJson(res);
	}

	/** `DevToolsActivePort` を読む。まだ書かれていない起動直後に備えて短くリトライする。 */
	private async _readPortFileWithRetry(timeoutMs: number): Promise<number | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (; ;) {
			const port = await this._readPortFile();
			if (port !== undefined || Date.now() >= deadline) {
				return port;
			}
			await delay(100);
		}
	}

	private _readPortFile(): Promise<number | undefined> {
		return paradisReadDevToolsActivePort(this.userDataPath, this.openFileImpl);
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
