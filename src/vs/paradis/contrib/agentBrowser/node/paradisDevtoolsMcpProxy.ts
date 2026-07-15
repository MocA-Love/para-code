/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCPサーバーに chrome-devtools-mcp のツール群をプロキシ合流させるための
// 子プロセス管理＋最小stdio MCPクライアント。
//
// 設計（背景は media/chrome-devtools-mcp/README.md も参照）:
//   - vendored chrome-devtools-mcp をペイントークン毎に1子プロセスとして遅延spawnする
//     （ELECTRON_RUN_AS_NODE=1 + process.execPath。Electron同梱NodeはESM/Node20+要件を満たす）
//   - CDPゲートウェイへの接続は `--wsEndpoint=ws://127.0.0.1:<port>/cdp/devtools/browser/<id>?pane=<token>`
//     で行う。`?pane=` クエリは _resolveToken の最優先経路なので、lsof/psによるピアPID推定に
//     一切依存せず全OSで決定的にペインへ紐付く（puppeteerがwsEndpointのクエリを保持することは実測確認済み。
//     --browserUrl だと puppeteer がパス・クエリを落とすため使わない）。保険として env にもトークンを注入する
//   - chrome-devtools-mcp はブラウザ接続を初回 tools/call まで遅延するため、子プロセス自体の
//     spawn は安価（tools/list はブラウザ未接続でも成功する）
//   - CDPゲートウェイが非対応のツール（new_page / close_page / resize_page）は一覧から除外する
//   - アイドル一定時間で子プロセスをkillし、次の呼び出しで透過的に再spawnする

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

/** vendored chrome-devtools-mcp のstdioエントリ（同梱物。更新手順は同フォルダのREADME.md）。 */
const DEVTOOLS_MCP_ENTRY = 'vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js';

/**
 * CDPゲートウェイでは動作しないため一覧から除外するツール。
 * ゲートウェイは「ペインに共有された1ページ」のみを見せる設計で、ページの開閉・リサイズは
 * Para Code UI側の責務（理由はサービス側の CDP_LIMITATIONS_NOTE と同じ）。
 */
const EXCLUDED_TOOLS = new Set(['new_page', 'close_page', 'resize_page']);

/** initialize / tools/list 応答の待ち時間上限。 */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** tools/call の待ち時間上限（performance trace / lighthouse は分単位かかりうる）。 */
const CALL_TIMEOUT_MS = 300_000;
/** この時間ツール呼び出しが無ければ子プロセスをkillする（次の呼び出しで再spawn）。 */
const IDLE_KILL_MS = 30 * 60_000;
/** 改行されない子プロセスstdoutを保持できる最大byte数。 */
const MAX_STDOUT_BUFFER_BYTES = 4 * 1024 * 1024;
/** 1子プロセスで同時に待機できるJSON-RPC要求数。 */
const MAX_PENDING_REQUESTS = 256;
/** 1子プロセスのstdinに滞留できる最大byte数。 */
const MAX_STDIN_QUEUED_BYTES = 1024 * 1024;
/** サービス全体で同時に保持できる子プロセス数。 */
const MAX_CHILDREN = 32;
/** generation高水位を保持できるtoken数。 */
const MAX_GENERATION_HIGH_WATERMARKS = 4096;
/** SIGTERMを無視する子プロセスを強制終了するまでの猶予。 */
const KILL_GRACE_TIMEOUT_MS = 5_000;
const RESOURCE_LIMIT_ERROR_MESSAGE = 'PARA_BROWSER_RETRYABLE: embedded DevTools bridge resource limit reached; retry';
const TERMINATED_ERROR_MESSAGE = 'PARA_BROWSER_RETRYABLE: embedded DevTools bridge terminated; retry';

/** MCP `tools/list` が返すツール記述子（未知フィールドはそのまま透過する）。 */
export interface IParadisProxiedTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	readonly [key: string]: unknown;
}

/** 子プロセス生成と待機時間をテスト・実行環境ごとに差し替えるための設定。 */
export interface IParadisDevtoolsMcpProxyOptions {
	readonly spawnChild?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;
	readonly handshakeTimeoutMs?: number;
	readonly callTimeoutMs?: number;
	readonly maxStdoutBufferBytes?: number;
	readonly maxPendingRequests?: number;
	readonly maxStdinQueuedBytes?: number;
	readonly maxChildren?: number;
	readonly maxGenerationHighWatermarks?: number;
	readonly killGraceTimeoutMs?: number;
}

interface IPendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface IChildEntry {
	readonly child: ChildProcessWithoutNullStreams;
	readonly generation: number;
	readonly wsEndpoint: string;
	readonly tokenFingerprint: string;
	/** initialize ハンドシェイク完了（失敗時はreject）。spawn直後に一度だけ代入される。 */
	ready: Promise<void>;
	readonly pending: Map<number, IPendingRequest>;
	nextId: number;
	stdoutBuffer: Buffer;
	stdoutBufferLength: number;
	stdinBackpressured: boolean;
	stdinDrainListener: (() => void) | undefined;
	stdoutDataListener: ((chunk: Buffer) => void) | undefined;
	processErrorListener: ((error: Error) => void) | undefined;
	processExitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
	processCloseListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
	killTimer: ReturnType<typeof setTimeout> | undefined;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	killed: boolean;
}

class StaleParadisDevtoolsGenerationError extends Error {
	constructor() {
		super('PARA_BROWSER_RETRYABLE: stale browser binding generation');
	}
}

class ParadisDevtoolsResourceLimitError extends Error {
	constructor() {
		super(RESOURCE_LIMIT_ERROR_MESSAGE);
	}
}

class ParadisDevtoolsUnavailableError extends Error {
	constructor() {
		super(TERMINATED_ERROR_MESSAGE);
	}
}

/**
 * ペイントークン毎の chrome-devtools-mcp 子プロセスを管理し、tools/list・tools/call を
 * 転送するプロキシ。`ParadisAgentBrowserService` が所有する。
 */
export class ParadisDevtoolsMcpProxy extends Disposable {

	private readonly _children = new Map<string, IChildEntry>();
	/** kill要求済みでも実process exit/errorを観測するまではslotを占有する。 */
	private readonly _childSlots = new Set<IChildEntry>();
	private readonly _generationHighWatermarks = new Map<string, number>();
	private _disposed = false;
	/**
	 * ツール一覧のキャッシュ（除外前の生リスト）。同じvendoredバイナリ＋同じフラグで起動する
	 * ため全ペインで同一。一度取得したらサービス生存中は再取得しない。
	 */
	private _toolsCache: readonly IParadisProxiedTool[] | undefined;

	constructor(
		/** para-browser 側の静的ツール名。子プロセス側と衝突した場合は子プロセス側を隠す。 */
		private readonly reservedToolNames: ReadonlySet<string>,
		private readonly logService: ILogService,
		private readonly options: IParadisDevtoolsMcpProxyOptions = {},
	) {
		super();
	}

	/**
	 * 転送対象のツール一覧（除外・衝突フィルタ適用済み）を返す。
	 * 子プロセスの起動や応答に失敗した場合はthrowする（呼び出し側で縮退させる）。
	 */
	async listTools(token: string, generation: number, wsEndpoint: string, signal?: AbortSignal): Promise<IParadisProxiedTool[]> {
		return this._listTools(token, generation, wsEndpoint, signal);
	}

	private async _listTools(token: string, generation: number, wsEndpoint: string, signal?: AbortSignal): Promise<IParadisProxiedTool[]> {
		this._throwIfDisposed();
		this._observeGeneration(token, generation);
		if (!this._toolsCache) {
			const entry = this._ensureChild(token, generation, wsEndpoint);
			await this._awaitReady(token, entry, signal);
			this._throwIfDisposed();
			const result = await this._request(token, entry, 'tools/list', {}, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS, signal) as { tools?: unknown } | undefined;
			this._throwIfDisposed();
			if (!Array.isArray(result?.tools) || !result.tools.every(tool => this._isProxiedTool(tool))) {
				throw new Error('chrome-devtools-mcp returned an unexpected tools/list response');
			}
			this._toolsCache = Object.freeze(result.tools.map(tool => this._deepFreeze(tool)));
		}
		return this._toolsCache.filter(tool => !EXCLUDED_TOOLS.has(tool.name) && !this.reservedToolNames.has(tool.name));
	}

	/**
	 * `name` が転送対象のツールかどうかを返す（子プロセスが起動できない場合は false）。
	 */
	async isProxiedTool(token: string, generation: number, wsEndpoint: string, name: string, signal?: AbortSignal): Promise<boolean> {
		try {
			return (await this.listTools(token, generation, wsEndpoint, signal)).some(tool => tool.name === name);
		} catch {
			this._warn(`[ParadisDevtoolsProxy] tools/list failed while resolving a tool name for pane ${this._tokenFingerprint(token)}`);
			return false;
		}
	}

	/**
	 * ツール呼び出しを子プロセスへ転送する。`name` が転送対象でなければ `undefined` を返す
	 * （未知ツールのJSON-RPCエラー化は呼び出し側の責務）。転送対象で実行に失敗した場合は
	 * MCPツールエラー（`isError: true` のcontent）を返し、プロトコルエラーにはしない。
	 */
	async tryCallTool(token: string, generation: number, wsEndpoint: string, name: string, args: unknown, signal?: AbortSignal): Promise<unknown | undefined> {
		let known: boolean;
		try {
			known = (await this._listTools(token, generation, wsEndpoint, signal)).some(tool => tool.name === name);
		} catch (error) {
			if (signal?.aborted || error instanceof StaleParadisDevtoolsGenerationError || error instanceof ParadisDevtoolsResourceLimitError || error instanceof ParadisDevtoolsUnavailableError) {
				return this._toolCallError(name, error);
			}
			// 一覧すら取れない＝子プロセスが起動できない。para側ツールの解決を妨げないよう
			// 「知らないツール」として扱う（呼び出し側が -32602 を返す）。
			this._warn(`[ParadisDevtoolsProxy] tools/list failed while resolving a tool call for pane ${this._tokenFingerprint(token)}`);
			return undefined;
		}
		if (!known) {
			return undefined;
		}
		try {
			const entry = this._ensureChild(token, generation, wsEndpoint);
			await this._awaitReady(token, entry, signal);
			const result = await this._request(token, entry, 'tools/call', { name, arguments: args ?? {} }, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS, signal);
			// undefined は呼び出し側で「未知ツール」を意味するため、成功時は必ずオブジェクトを返す
			return result ?? { content: [] };
		} catch (error) {
			return this._toolCallError(name, error);
		}
	}

	/** 新しいbinding generationを記録し、それより古い子プロセスを退役させる。 */
	retire(token: string, generation: number): void {
		if (this._disposed) {
			return;
		}
		const highWatermark = this._generationHighWatermarks.get(token);
		if (highWatermark !== undefined && generation < highWatermark) {
			return;
		}
		if (highWatermark === undefined || generation > highWatermark) {
			if (highWatermark === undefined && this._generationHighWatermarks.size >= this._limit(this.options.maxGenerationHighWatermarks, MAX_GENERATION_HIGH_WATERMARKS)) {
				return;
			}
			this._generationHighWatermarks.set(token, generation);
		}
		const entry = this._children.get(token);
		if (entry && entry.generation < generation) {
			this._killChild(token, entry, 'pane retired');
		}
	}

	/** 当該tokenへのproxy呼び出しが無いことを呼び出し側が保証した後、高水位を破棄する。 */
	forget(token: string): void {
		if (this._disposed) {
			return;
		}
		const entry = this._children.get(token);
		if (entry) {
			this._killChild(token, entry, 'pane forgotten');
		}
		this._generationHighWatermarks.delete(token);
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const [token, entry] of [...this._children]) {
			this._killChild(token, entry, 'service disposed');
		}
		this._generationHighWatermarks.clear();
		this._toolsCache = undefined;
		super.dispose();
	}

	// --- 子プロセス管理 ---

	private _ensureChild(token: string, generation: number, wsEndpoint: string): IChildEntry {
		this._throwIfDisposed();
		this._observeGeneration(token, generation);
		const existing = this._children.get(token);
		const reusable = existing
			&& !existing.killed
			&& existing.generation === generation
			&& existing.wsEndpoint === wsEndpoint;
		if (reusable) {
			this._resetIdleTimer(token, existing);
			return existing;
		}
		if (existing) {
			this._killChild(token, existing, 'binding generation changed');
		}
		if (this._childSlots.size >= this._limit(this.options.maxChildren, MAX_CHILDREN)) {
			throw new ParadisDevtoolsResourceLimitError();
		}

		const entryPath = FileAccess.asFileUri(DEVTOOLS_MCP_ENTRY).fsPath;
		const tokenFingerprint = this._tokenFingerprint(token);
		this._debug(`[ParadisDevtoolsProxy] Spawning chrome-devtools-mcp for pane ${tokenFingerprint} generation=${generation}`);
		const spawnChild = this.options.spawnChild ?? ((command, args, options) => spawn(command, args, options));
		const child = spawnChild(process.execPath, [
			entryPath,
			`--wsEndpoint=${wsEndpoint}`,
			// テレメトリ送信（Google Clearcut / CrUX APIへのURL送信）は同梱コンポーネントとして無効化する
			'--usageStatistics=false',
			'--performanceCrux=false',
		], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
				// 保険: wsEndpointクエリが使えない経路に万一落ちても、macOS/Linuxではピアプロセスの
				// env読み取り（ゲートウェイの解決経路2）でペインへ紐付けられるようにしておく
				[PARADIS_PANE_TOKEN_ENV_VAR]: token,
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const entry: IChildEntry = {
			child,
			generation,
			wsEndpoint,
			tokenFingerprint,
			ready: Promise.resolve(),
			pending: new Map(),
			nextId: 1,
			stdoutBuffer: Buffer.alloc(0),
			stdoutBufferLength: 0,
			stdinBackpressured: false,
			stdinDrainListener: undefined,
			stdoutDataListener: undefined,
			processErrorListener: undefined,
			processExitListener: undefined,
			processCloseListener: undefined,
			killTimer: undefined,
			idleTimer: undefined,
			killed: false,
		};
		this._childSlots.add(entry);

		entry.stdoutDataListener = (chunk: Buffer) => this._onStdout(token, entry, chunk);
		child.stdout.on('data', entry.stdoutDataListener);
		// 子プロセスのstderrは秘密情報を含み得るため、内容を保持・表示せずdrainだけ行う。
		child.stderr.resume();
		entry.processErrorListener = (_error: Error) => {
			this._warn(`[ParadisDevtoolsProxy] chrome-devtools-mcp process error for pane ${tokenFingerprint} generation=${generation}`);
			this._killChild(token, entry, 'process error');
		};
		entry.processExitListener = (code, signal) => {
			if (!entry.killed) {
				this._debug(`[ParadisDevtoolsProxy] chrome-devtools-mcp for pane ${tokenFingerprint} generation=${generation} exited (code=${code}, signal=${signal})`);
			}
			this._cleanupEntry(token, entry, `process exited (code=${code}, signal=${signal})`);
			this._releaseChildSlot(entry);
		};
		entry.processCloseListener = (code, signal) => {
			this._cleanupEntry(token, entry, `process closed (code=${code}, signal=${signal})`);
			this._releaseChildSlot(entry);
		};
		child.on('error', entry.processErrorListener);
		child.on('exit', entry.processExitListener);
		child.on('close', entry.processCloseListener);
		this._children.set(token, entry);
		this._resetIdleTimer(token, entry);

		// initialize ハンドシェイク（応答確認後に initialized 通知を送る）
		entry.ready = this._request(token, entry, 'initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'para-code-agent-browser', version: '1.0.0' },
		}, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS).then(() => {
			if (!this._send(token, entry, { jsonrpc: '2.0', method: 'notifications/initialized' })) {
				this._killChild(token, entry, 'failed to send initialized notification', new ParadisDevtoolsResourceLimitError());
			}
		});
		// ready の失敗は _request 側で pending 経由でも観測されるため、未処理拒否だけ握りつぶす
		entry.ready.catch(() => { });

		return entry;
	}

	private _onStdout(token: string, entry: IChildEntry, chunk: Buffer): void {
		if (entry.killed) {
			return;
		}
		const maxBufferBytes = this._limit(this.options.maxStdoutBufferBytes, MAX_STDOUT_BUFFER_BYTES);
		let offset = 0;
		while (offset < chunk.byteLength) {
			const newlineIndex = chunk.indexOf(0x0A, offset);
			const segmentEnd = newlineIndex >= 0 ? newlineIndex + 1 : chunk.byteLength;
			const segment = chunk.subarray(offset, segmentEnd);
			const requiredBytes = entry.stdoutBufferLength + segment.byteLength;
			if (requiredBytes > maxBufferBytes) {
				entry.stdoutBuffer = Buffer.alloc(0);
				entry.stdoutBufferLength = 0;
				this._killChild(token, entry, 'stdout buffer resource limit reached', new ParadisDevtoolsResourceLimitError());
				return;
			}
			if (entry.stdoutBuffer.byteLength < requiredBytes) {
				const capacity = Math.min(maxBufferBytes, Math.max(requiredBytes, Math.max(1024, entry.stdoutBuffer.byteLength * 2)));
				const expanded = Buffer.allocUnsafe(capacity);
				entry.stdoutBuffer.copy(expanded, 0, 0, entry.stdoutBufferLength);
				entry.stdoutBuffer = expanded;
			}
			segment.copy(entry.stdoutBuffer, entry.stdoutBufferLength);
			entry.stdoutBufferLength = requiredBytes;
			offset = segmentEnd;
			if (newlineIndex < 0) {
				return;
			}
			const line = entry.stdoutBuffer.subarray(0, entry.stdoutBufferLength - 1).toString('utf8').trim();
			entry.stdoutBufferLength = 0;
			if (!line) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				this._trace(`[ParadisDevtoolsProxy] Ignoring non-JSON stdout line for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
				continue;
			}
			if (!this._isRecord(parsed)) {
				this._trace(`[ParadisDevtoolsProxy] Ignoring non-object stdout message for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
				continue;
			}
			const message = parsed;
			const method = message.method;
			if (method !== undefined && typeof method !== 'string') {
				this._trace(`[ParadisDevtoolsProxy] Ignoring malformed stdout message for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
				continue;
			}
			const hasRequestId = typeof message.id === 'number' || typeof message.id === 'string';
			if (typeof method === 'string' && hasRequestId) {
				// サーバー→クライアント要求（roots/list等）。roots機能は提供しないため空応答/未実装で返す
				const response = method === 'roots/list'
					? { jsonrpc: '2.0', id: message.id, result: { roots: [] } }
					: method === 'ping'
						? { jsonrpc: '2.0', id: message.id, result: {} }
						: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${method}` } };
				if (!this._send(token, entry, response)) {
					this._killChild(token, entry, 'failed to send child response', new ParadisDevtoolsResourceLimitError());
					return;
				}
				continue;
			}
			if (typeof method === 'string') {
				// 通知（logging等）は読み捨てる
				continue;
			}
			const pending = typeof message.id === 'number' ? entry.pending.get(message.id) : undefined;
			if (!pending) {
				continue;
			}
			const responseError = message.error;
			if (responseError !== undefined) {
				if (!this._isRecord(responseError)) {
					pending.reject(new ParadisDevtoolsUnavailableError());
					continue;
				}
				pending.reject(new ParadisDevtoolsUnavailableError());
			} else {
				pending.resolve(message.result);
			}
		}
	}

	private _request(token: string, entry: IChildEntry, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			if (entry.killed) {
				reject(new Error('chrome-devtools-mcp process is not running'));
				return;
			}
			if (entry.pending.size >= this._limit(this.options.maxPendingRequests, MAX_PENDING_REQUESTS) || entry.stdinBackpressured) {
				reject(new ParadisDevtoolsResourceLimitError());
				return;
			}
			const id = entry.nextId++;
			let settled = false;
			const cleanup = (): boolean => {
				if (settled) {
					return false;
				}
				settled = true;
				clearTimeout(timer);
				entry.pending.delete(id);
				signal?.removeEventListener('abort', onAbort);
				return true;
			};
			const resolveOnce = (value: unknown): void => {
				if (cleanup()) {
					resolve(value);
				}
			};
			const rejectOnce = (error: Error): void => {
				if (cleanup()) {
					reject(error);
				}
			};
			const failAndKill = (reason: string): void => {
				if (!cleanup()) {
					return;
				}
				reject(new Error(reason));
				this._killChild(token, entry, reason);
			};
			const onAbort = (): void => failAndKill(`${method} aborted by client`);
			const timer = setTimeout(() => failAndKill(`${method} timed out after ${timeoutMs}ms`), timeoutMs);
			entry.pending.set(id, { resolve: resolveOnce, reject: rejectOnce });
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			if (!this._send(token, entry, { jsonrpc: '2.0', id, method, params })) {
				rejectOnce(new ParadisDevtoolsResourceLimitError());
			}
		});
	}

	private _awaitReady(token: string, entry: IChildEntry, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			return entry.ready;
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener('abort', onAbort);
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			const onAbort = (): void => {
				finish(new Error('initialize aborted by client'));
				this._killChild(token, entry, 'initialize aborted by client');
			};
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			entry.ready.then(() => finish(), error => finish(error instanceof Error ? error : new Error(String(error))));
		});
	}

	private _send(token: string, entry: IChildEntry, message: unknown): boolean {
		if (entry.killed || entry.stdinBackpressured) {
			return false;
		}
		let payload: string;
		try {
			payload = JSON.stringify(message) + '\n';
		} catch {
			return false;
		}
		const maxQueuedBytes = this._limit(this.options.maxStdinQueuedBytes, MAX_STDIN_QUEUED_BYTES);
		const queuedBytes = Math.max(0, entry.child.stdin.writableLength);
		const payloadBytes = Buffer.byteLength(payload);
		if (queuedBytes > maxQueuedBytes) {
			this._killChild(token, entry, 'stdin queue resource limit exceeded', new ParadisDevtoolsResourceLimitError());
			return false;
		}
		if (payloadBytes > maxQueuedBytes - queuedBytes) {
			return false;
		}
		try {
			const acceptsMore = entry.child.stdin.write(payload);
			if (entry.child.stdin.writableLength > maxQueuedBytes) {
				this._killChild(token, entry, 'stdin queue resource limit exceeded', new ParadisDevtoolsResourceLimitError());
				return false;
			}
			if (!acceptsMore) {
				entry.stdinBackpressured = true;
				entry.stdinDrainListener = () => {
					entry.stdinDrainListener = undefined;
					if (!entry.killed) {
						entry.stdinBackpressured = false;
					}
				};
				entry.child.stdin.once('drain', entry.stdinDrainListener);
			}
			return true;
		} catch {
			this._warn(`[ParadisDevtoolsProxy] Failed to write to chrome-devtools-mcp stdin for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
			this._killChild(token, entry, 'stdin write failed', new ParadisDevtoolsResourceLimitError());
			return false;
		}
	}

	private _resetIdleTimer(token: string, entry: IChildEntry): void {
		if (entry.idleTimer !== undefined) {
			clearTimeout(entry.idleTimer);
		}
		entry.idleTimer = setTimeout(() => {
			this._debug(`[ParadisDevtoolsProxy] Killing idle chrome-devtools-mcp for pane ${entry.tokenFingerprint} generation=${entry.generation}`);
			this._killChild(token, entry, 'idle timeout');
		}, IDLE_KILL_MS);
	}

	private _killChild(token: string, entry: IChildEntry, reason: string, pendingError?: Error): void {
		if (entry.killed) {
			return;
		}
		this._cleanupEntry(token, entry, reason, pendingError);
		try {
			entry.child.kill();
		} catch {
			// 既に終了している場合は無視
		}
		if (this._childSlots.has(entry)) {
			entry.killTimer = setTimeout(() => {
				entry.killTimer = undefined;
				if (!this._childSlots.has(entry)) {
					return;
				}
				try {
					entry.child.kill('SIGKILL');
				} catch {
					// exit/close未確認ならslotは保守的に保持する
				}
			}, this._limit(this.options.killGraceTimeoutMs, KILL_GRACE_TIMEOUT_MS));
		}
	}

	private _cleanupEntry(token: string, entry: IChildEntry, _reason: string, pendingError: Error = new Error(TERMINATED_ERROR_MESSAGE)): void {
		if (entry.killed) {
			return;
		}
		entry.killed = true;
		if (entry.idleTimer !== undefined) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		if (entry.stdoutDataListener) {
			entry.child.stdout.removeListener('data', entry.stdoutDataListener);
			entry.stdoutDataListener = undefined;
		}
		if (entry.stdinDrainListener) {
			entry.child.stdin.removeListener('drain', entry.stdinDrainListener);
			entry.stdinDrainListener = undefined;
		}
		entry.stdinBackpressured = false;
		entry.stdoutBuffer = Buffer.alloc(0);
		entry.stdoutBufferLength = 0;
		if (this._children.get(token) === entry) {
			this._children.delete(token);
		}
		for (const pending of [...entry.pending.values()]) {
			try {
				pending.reject(pendingError);
			} catch {
				// cleanupは診断・consumer側の例外に左右されず最後まで行う
			}
		}
		entry.pending.clear();
		for (const stream of [entry.child.stdin, entry.child.stdout, entry.child.stderr]) {
			try {
				stream.destroy();
			} catch {
				// 既にclose済みなら無視
			}
		}
	}

	private _releaseChildSlot(entry: IChildEntry): void {
		if (!this._childSlots.delete(entry)) {
			return;
		}
		if (entry.killTimer !== undefined) {
			clearTimeout(entry.killTimer);
			entry.killTimer = undefined;
		}
		if (entry.processErrorListener) {
			entry.child.removeListener('error', entry.processErrorListener);
			entry.processErrorListener = undefined;
		}
		if (entry.processExitListener) {
			entry.child.removeListener('exit', entry.processExitListener);
			entry.processExitListener = undefined;
		}
		if (entry.processCloseListener) {
			entry.child.removeListener('close', entry.processCloseListener);
			entry.processCloseListener = undefined;
		}
	}

	private _limit(value: number | undefined, fallback: number): number {
		return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}

	private _throwIfDisposed(): void {
		if (this._disposed) {
			throw new ParadisDevtoolsUnavailableError();
		}
	}

	private _isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	private _isProxiedTool(value: unknown): value is IParadisProxiedTool {
		return this._isRecord(value) && typeof value.name === 'string';
	}

	private _deepFreeze<T>(root: T): T {
		if (typeof root !== 'object' || root === null) {
			return root;
		}
		const pending: object[] = [root];
		const visited = new Set<object>();
		while (pending.length > 0) {
			const value = pending.pop()!;
			if (visited.has(value)) {
				continue;
			}
			visited.add(value);
			for (const nested of Object.values(value)) {
				if (typeof nested === 'object' && nested !== null) {
					pending.push(nested);
				}
			}
			Object.freeze(value);
		}
		return root;
	}

	private _debug(message: string): void {
		try {
			this.logService.debug(message);
		} catch {
			// 診断失敗で子プロセス管理を中断しない
		}
	}

	private _trace(message: string): void {
		try {
			this.logService.trace(message);
		} catch {
			// 診断失敗で子プロセス管理を中断しない
		}
	}

	private _warn(message: string): void {
		try {
			this.logService.warn(message);
		} catch {
			// 診断失敗で子プロセス管理を中断しない
		}
	}

	private _tokenFingerprint(token: string): string {
		return createHash('sha256').update(token).digest('hex').slice(0, 12);
	}

	private _toolCallError(name: string, error: unknown): unknown {
		const message = error instanceof StaleParadisDevtoolsGenerationError || error instanceof ParadisDevtoolsResourceLimitError || error instanceof ParadisDevtoolsUnavailableError
			? error.message
			: TERMINATED_ERROR_MESSAGE;
		return {
			content: [{ type: 'text', text: `chrome-devtools tool "${name}" failed: ${message}` }],
			isError: true,
		};
	}

	private _observeGeneration(token: string, generation: number): void {
		const highWatermark = this._generationHighWatermarks.get(token);
		if (highWatermark !== undefined && generation < highWatermark) {
			throw new StaleParadisDevtoolsGenerationError();
		}
		if (highWatermark === undefined || generation > highWatermark) {
			if (highWatermark === undefined && this._childSlots.size >= this._limit(this.options.maxChildren, MAX_CHILDREN)) {
				return;
			}
			if (highWatermark === undefined && this._generationHighWatermarks.size >= this._limit(this.options.maxGenerationHighWatermarks, MAX_GENERATION_HIGH_WATERMARKS)) {
				throw new ParadisDevtoolsResourceLimitError();
			}
			this._generationHighWatermarks.set(token, generation);
			const entry = this._children.get(token);
			if (entry && entry.generation < generation) {
				this._killChild(token, entry, 'newer binding generation observed');
			}
		}
	}
}
