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

/** MCP `tools/list` が返すツール記述子（未知フィールドはそのまま透過する）。 */
export interface IParadisProxiedTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	readonly [key: string]: unknown;
}

interface IPendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

interface IChildEntry {
	readonly child: ChildProcessWithoutNullStreams;
	/** initialize ハンドシェイク完了（失敗時はreject）。spawn直後に一度だけ代入される。 */
	ready: Promise<void>;
	readonly pending: Map<number, IPendingRequest>;
	nextId: number;
	stdoutBuffer: string;
	/** 診断用に保持する直近のstderr出力（エラーメッセージに添える）。 */
	stderrTail: string;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	killed: boolean;
}

/**
 * ペイントークン毎の chrome-devtools-mcp 子プロセスを管理し、tools/list・tools/call を
 * 転送するプロキシ。`ParadisAgentBrowserService` が所有する。
 */
export class ParadisDevtoolsMcpProxy extends Disposable {

	private readonly _children = new Map<string, IChildEntry>();
	/**
	 * ツール一覧のキャッシュ（除外前の生リスト）。同じvendoredバイナリ＋同じフラグで起動する
	 * ため全ペインで同一。一度取得したらサービス生存中は再取得しない。
	 */
	private _toolsCache: IParadisProxiedTool[] | undefined;

	constructor(
		/** para-browser 側の静的ツール名。子プロセス側と衝突した場合は子プロセス側を隠す。 */
		private readonly reservedToolNames: ReadonlySet<string>,
		private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * 転送対象のツール一覧（除外・衝突フィルタ適用済み）を返す。
	 * 子プロセスの起動や応答に失敗した場合はthrowする（呼び出し側で縮退させる）。
	 */
	async listTools(token: string, wsEndpoint: string): Promise<IParadisProxiedTool[]> {
		if (!this._toolsCache) {
			const entry = this._ensureChild(token, wsEndpoint);
			await entry.ready;
			const result = await this._request(entry, 'tools/list', {}) as { tools?: IParadisProxiedTool[] } | undefined;
			if (!Array.isArray(result?.tools)) {
				throw new Error('chrome-devtools-mcp returned an unexpected tools/list response');
			}
			this._toolsCache = result.tools;
		}
		return this._toolsCache.filter(tool => !EXCLUDED_TOOLS.has(tool.name) && !this.reservedToolNames.has(tool.name));
	}

	/**
	 * `name` が転送対象のツールかどうかを返す（子プロセスが起動できない場合は false）。
	 */
	async isProxiedTool(token: string, wsEndpoint: string, name: string): Promise<boolean> {
		try {
			return (await this.listTools(token, wsEndpoint)).some(tool => tool.name === name);
		} catch (error) {
			this.logService.warn('[ParadisDevtoolsProxy] tools/list failed while resolving a tool name', error);
			return false;
		}
	}

	/**
	 * ツール呼び出しを子プロセスへ転送する。`name` が転送対象でなければ `undefined` を返す
	 * （未知ツールのJSON-RPCエラー化は呼び出し側の責務）。転送対象で実行に失敗した場合は
	 * MCPツールエラー（`isError: true` のcontent）を返し、プロトコルエラーにはしない。
	 */
	async tryCallTool(token: string, wsEndpoint: string, name: string, args: unknown): Promise<unknown | undefined> {
		let known: boolean;
		try {
			known = (await this.listTools(token, wsEndpoint)).some(tool => tool.name === name);
		} catch (error) {
			// 一覧すら取れない＝子プロセスが起動できない。para側ツールの解決を妨げないよう
			// 「知らないツール」として扱う（呼び出し側が -32602 を返す）。
			this.logService.warn('[ParadisDevtoolsProxy] tools/list failed while resolving a tool call', error);
			return undefined;
		}
		if (!known) {
			return undefined;
		}
		try {
			const entry = this._ensureChild(token, wsEndpoint);
			await entry.ready;
			const result = await this._request(entry, 'tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
			// undefined は呼び出し側で「未知ツール」を意味するため、成功時は必ずオブジェクトを返す
			return result ?? { content: [] };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: 'text', text: `chrome-devtools tool "${name}" failed: ${message}` }],
				isError: true,
			};
		}
	}

	/** ペイン破棄時のクリーンアップ（`_retirePaneToken` から呼ばれる）。 */
	retire(token: string): void {
		const entry = this._children.get(token);
		if (entry) {
			this._killChild(token, entry, 'pane retired');
		}
	}

	override dispose(): void {
		for (const [token, entry] of [...this._children]) {
			this._killChild(token, entry, 'service disposed');
		}
		super.dispose();
	}

	// --- 子プロセス管理 ---

	private _ensureChild(token: string, wsEndpoint: string): IChildEntry {
		const existing = this._children.get(token);
		if (existing && !existing.killed) {
			this._resetIdleTimer(token, existing);
			return existing;
		}

		const entryPath = FileAccess.asFileUri(DEVTOOLS_MCP_ENTRY).fsPath;
		this.logService.debug(`[ParadisDevtoolsProxy] Spawning chrome-devtools-mcp for pane ${token} (${wsEndpoint})`);
		const child = spawn(process.execPath, [
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
			ready: Promise.resolve(),
			pending: new Map(),
			nextId: 1,
			stdoutBuffer: '',
			stderrTail: '',
			idleTimer: undefined,
			killed: false,
		};

		child.stdout.on('data', (chunk: Buffer) => this._onStdout(entry, chunk));
		child.stderr.on('data', (chunk: Buffer) => {
			entry.stderrTail = (entry.stderrTail + chunk.toString('utf8')).slice(-2000);
		});
		child.on('error', (error: Error) => {
			this.logService.warn(`[ParadisDevtoolsProxy] chrome-devtools-mcp process error for pane ${token}`, error);
			this._cleanupEntry(token, entry, `process error: ${error.message}`);
		});
		child.on('exit', (code, signal) => {
			if (!entry.killed) {
				this.logService.debug(`[ParadisDevtoolsProxy] chrome-devtools-mcp for pane ${token} exited (code=${code}, signal=${signal})`);
			}
			this._cleanupEntry(token, entry, `process exited (code=${code}, signal=${signal})`);
		});

		// initialize ハンドシェイク（応答確認後に initialized 通知を送る）
		entry.ready = this._request(entry, 'initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'para-code-agent-browser', version: '1.0.0' },
		}).then(() => {
			this._send(entry, { jsonrpc: '2.0', method: 'notifications/initialized' });
		});
		// ready の失敗は _request 側で pending 経由でも観測されるため、未処理拒否だけ握りつぶす
		entry.ready.catch(() => { });

		this._children.set(token, entry);
		this._resetIdleTimer(token, entry);
		return entry;
	}

	private _onStdout(entry: IChildEntry, chunk: Buffer): void {
		entry.stdoutBuffer += chunk.toString('utf8');
		let newlineIndex: number;
		while ((newlineIndex = entry.stdoutBuffer.indexOf('\n')) >= 0) {
			const line = entry.stdoutBuffer.slice(0, newlineIndex).trim();
			entry.stdoutBuffer = entry.stdoutBuffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			let message: { id?: number | string | null; method?: string; result?: unknown; error?: { message?: string; code?: number } };
			try {
				message = JSON.parse(line);
			} catch {
				this.logService.trace(`[ParadisDevtoolsProxy] Ignoring non-JSON stdout line: ${line.slice(0, 200)}`);
				continue;
			}
			if (message.method !== undefined && message.id !== undefined && message.id !== null) {
				// サーバー→クライアント要求（roots/list等）。roots機能は提供しないため空応答/未実装で返す
				const response = message.method === 'roots/list'
					? { jsonrpc: '2.0', id: message.id, result: { roots: [] } }
					: message.method === 'ping'
						? { jsonrpc: '2.0', id: message.id, result: {} }
						: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
				this._send(entry, response);
				continue;
			}
			if (message.method !== undefined) {
				// 通知（logging等）は読み捨てる
				continue;
			}
			const pending = typeof message.id === 'number' ? entry.pending.get(message.id) : undefined;
			if (!pending) {
				continue;
			}
			entry.pending.delete(message.id as number);
			clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code}`));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	private _request(entry: IChildEntry, method: string, params: unknown, timeoutMs: number = HANDSHAKE_TIMEOUT_MS): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			if (entry.killed) {
				reject(new Error('chrome-devtools-mcp process is not running'));
				return;
			}
			const id = entry.nextId++;
			const timer = setTimeout(() => {
				entry.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms${entry.stderrTail ? ` (stderr: ${entry.stderrTail.slice(-300)})` : ''}`));
			}, timeoutMs);
			entry.pending.set(id, { resolve, reject, timer });
			this._send(entry, { jsonrpc: '2.0', id, method, params });
		});
	}

	private _send(entry: IChildEntry, message: unknown): void {
		if (entry.killed) {
			return;
		}
		try {
			entry.child.stdin.write(JSON.stringify(message) + '\n');
		} catch (error) {
			this.logService.warn('[ParadisDevtoolsProxy] Failed to write to chrome-devtools-mcp stdin', error);
		}
	}

	private _resetIdleTimer(token: string, entry: IChildEntry): void {
		if (entry.idleTimer !== undefined) {
			clearTimeout(entry.idleTimer);
		}
		entry.idleTimer = setTimeout(() => {
			this.logService.debug(`[ParadisDevtoolsProxy] Killing idle chrome-devtools-mcp for pane ${token}`);
			this._killChild(token, entry, 'idle timeout');
		}, IDLE_KILL_MS);
	}

	private _killChild(token: string, entry: IChildEntry, reason: string): void {
		this._cleanupEntry(token, entry, reason);
		try {
			entry.child.kill();
		} catch {
			// 既に終了している場合は無視
		}
	}

	private _cleanupEntry(token: string, entry: IChildEntry, reason: string): void {
		entry.killed = true;
		if (entry.idleTimer !== undefined) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		for (const pending of entry.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`chrome-devtools-mcp terminated: ${reason}`));
		}
		entry.pending.clear();
		if (this._children.get(token) === entry) {
			this._children.delete(token);
		}
	}
}
