/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `CODEX_HOME=<ホーム> codex app-server`（stdio、改行区切り JSON-RPC）と短く話す最小のクライアント。
//
// limitsMonitor（使用量の取得、shared process と REH）、codexAccounts（リセットクレジットの読み取りと
// 消費）、agentHookTrust（`hooks/list` → `config/batchWrite`）、agentModelCatalog（`model/list`）が
// 共有する。認証の更新・auth.json の書き戻しは codex 自身に任せる（このプロセスは auth.json を書かない）。
//
// どれも `-s read-only -a never` で起こす。hook の信頼の `config/batchWrite`（CODEX_HOME/config.toml
// への書き込み）は app-server 自身が書くので、サンドボックスは効かない（codex 0.155.1 を一時の HOME と
// CODEX_HOME で動かし、読み取り専用でも書けることを 2026-09-27 に確かめた）。
//
// 投げるエラーの文言は limitsMonitor の Sentry 用の分類（classifyCodexRpcFailure）が前提にしている。
// 変えるときはそちらのテストも合わせること。

import * as cp from 'child_process';
import { timeout } from '../../base/common/async.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ILogService } from '../../platform/log/common/log.js';
import { paradisSpawnAgentCli } from './paradisAgentCli.js';
import { paradisKillChildProcessTree } from './paradisKillChildProcess.js';

/** app-server が返したエラー。message は app-server の文言（パス・トークンは含まない）。 */
export class ParadisCodexRpcError extends Error {
	constructor(message: string, readonly code: number | undefined) {
		super(message);
	}
}

/** Codex が「そのメソッドは無い」と答えた（古い CLI など）。message は app-server の文言のまま。 */
export class ParadisCodexRpcMethodNotFoundError extends ParadisCodexRpcError {
	constructor(message: string, code: number | undefined, readonly method: string) {
		super(message, code);
	}
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** 認証が無い・切れているときの app-server の文言か（再ログインでしか直らない）。 */
export function paradisIsCodexAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return /authentication required|unauthorized|forbidden|re-?login|token (?:has )?expired|expired token/i.test(message);
}

export interface IParadisCodexAppServerRpc {
	/** @param timeoutMs 省略時は 20 秒。 */
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	dispose(): void;
}

/** 起動の細かい指定。どれも省略できる。 */
export interface IParadisCodexAppServerRpcOptions {
	/** 対象の CODEX_HOME（絶対パス）。指定すると env の CODEX_HOME を上書きする。 */
	readonly codexHome?: string;
	/** app-server の作業ディレクトリ。 */
	readonly cwd?: string;
	/** initialize の clientInfo.title。 */
	readonly clientTitle?: string;
}

export type ParadisCodexAppServerRpcFactory = (command: string, env: NodeJS.ProcessEnv, logService: ILogService, clientName?: string, options?: IParadisCodexAppServerRpcOptions) => Promise<IParadisCodexAppServerRpc>;

const INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * app-server を起動して `initialize` / `initialized` まで済ませたセッションを返す。
 * 呼び出し側は使い終わったら必ず dispose する（子プロセスを残さない）。
 */
export const paradisStartCodexAppServerRpc: ParadisCodexAppServerRpcFactory = async (command, env, logService, clientName = 'para-code', options = {}) => {
	const session = new ParadisCodexAppServerRpcSession(command, options.codexHome !== undefined ? { ...env, CODEX_HOME: options.codexHome } : env, options.cwd, logService);
	try {
		const clientInfo = { name: clientName, ...(options.clientTitle !== undefined ? { title: options.clientTitle } : {}), version: '1.0.0' };
		await session.request('initialize', { clientInfo }, INITIALIZE_TIMEOUT_MS);
		session.notify('initialized');
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
};

class ParadisCodexAppServerRpcSession extends Disposable implements IParadisCodexAppServerRpc {

	private readonly child: cp.ChildProcessWithoutNullStreams;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, { readonly method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	constructor(command: string, env: NodeJS.ProcessEnv, cwd: string | undefined, private readonly logService: ILogService) {
		super();
		// `-a never`: 読み取り・消費・設定の書き込みしか呼ばないので承認は起きない。limitsMonitor と
		// 同じ理由で `untrusted` は使わない（codex 0.149 以降は受け付けない）。
		// Windows の .cmd シムは paradisSpawnAgentCli が cmd.exe で包む。
		this.child = paradisSpawnAgentCli(command, ['-s', 'read-only', '-a', 'never', 'app-server'], { env, cwd });
		this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
		this.child.stderr?.on('data', (chunk: Buffer) => {
			this.logService.trace(`[ParadisCodexAppServer] codex app-server stderr: ${chunk.toString('utf8').trim()}`);
		});
		this.child.on('exit', (code, signal) => {
			// 終了コードとシグナルは Sentry へ載せる（limitsMonitor）。文言には含めたまま。
			const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
			Object.assign(error, { exitCode: code, exitSignal: signal });
			this.failAll(error);
		});
		this.child.on('error', error => this.failAll(new Error(`failed to launch codex app-server: ${error.message}`)));
		// stdin が閉じた後の書き込みで EPIPE が未処理例外にならないようにする。
		this.child.stdin?.on('error', error => this.failAll(new Error(`codex app-server stdin failed: ${error.message}`)));
		this._register({ dispose: () => this.terminate() });
	}

	private onStdout(chunk: Buffer): void {
		this.buffer += chunk.toString('utf8');
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			let message: { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof message.id !== 'number') {
				continue; // 通知は使わない
			}
			const pending = this.pending.get(message.id);
			if (!pending) {
				continue;
			}
			this.pending.delete(message.id);
			if (message.error) {
				const text = message.error.message ?? 'codex app-server request failed';
				// 知らないメソッドには -32601 のほか、-32600 の「unknown variant」で答える（codex 0.155.1 で確認）。
				pending.reject(message.error.code === JSON_RPC_METHOD_NOT_FOUND || /method not found|unknown variant/i.test(text)
					? new ParadisCodexRpcMethodNotFoundError(text, message.error.code, pending.method)
					: new ParadisCodexRpcError(text, message.error.code));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	async request(method: string, params: unknown, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
		const result = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
		});
		this.child.stdin?.write(payload + '\n');
		const timer = timeout(timeoutMs);
		try {
			return await Promise.race([
				result,
				timer.then(() => {
					if (this.pending.delete(id)) {
						this.terminate();
					}
					throw new Error(`codex app-server request '${method}' timed out`);
				}),
			]);
		} finally {
			// 応答が先に来たらタイマーを止める（プロセスの終了を待たせない）。
			timer.cancel();
		}
	}

	notify(method: string): void {
		this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	private terminate(): void {
		paradisKillChildProcessTree(this.child, error => this.logService.trace(`[ParadisCodexAppServer] failed to stop codex app-server: ${error}`));
	}
}
