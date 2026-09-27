/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `CODEX_HOME=<ホーム> codex app-server`（stdio、改行区切り JSON-RPC）と短く話す最小のクライアント。
//
// limitsMonitor（使用量の取得、shared process と REH）と codexAccounts（リセットクレジットの読み取りと
// 消費）が共有する。認証の更新・auth.json の書き戻しは codex 自身に任せる（このプロセスは
// auth.json を書かない）。
//
// 投げるエラーの文言は limitsMonitor の Sentry 用の分類（classifyCodexRpcFailure）が前提にしている。
// 変えるときはそちらのテストも合わせること。

import * as cp from 'child_process';
import { timeout } from '../../base/common/async.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ILogService } from '../../platform/log/common/log.js';
import { paradisWrapWindowsScriptShim } from '../common/paradisWindowsScriptShim.js';
import { paradisKillChildProcessTree } from './paradisKillChildProcess.js';

/** app-server が返したエラー。message は app-server の文言（パス・トークンは含まない）。 */
export class ParadisCodexRpcError extends Error {
	constructor(message: string, readonly code: number | undefined) {
		super(message);
	}
}

/** 認証が無い・切れているときの app-server の文言か（再ログインでしか直らない）。 */
export function paradisIsCodexAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return /authentication required|unauthorized|forbidden|re-?login|token (?:has )?expired|expired token/i.test(message);
}

export interface IParadisCodexAppServerRpc {
	request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
	dispose(): void;
}

export type ParadisCodexAppServerRpcFactory = (command: string, env: NodeJS.ProcessEnv, logService: ILogService, clientName?: string) => Promise<IParadisCodexAppServerRpc>;

const INITIALIZE_TIMEOUT_MS = 15_000;

/**
 * app-server を起動して `initialize` / `initialized` まで済ませたセッションを返す。
 * 呼び出し側は使い終わったら必ず dispose する（子プロセスを残さない）。
 */
export const paradisStartCodexAppServerRpc: ParadisCodexAppServerRpcFactory = async (command, env, logService, clientName = 'para-code') => {
	const session = new ParadisCodexAppServerRpcSession(command, env, logService);
	try {
		await session.request('initialize', { clientInfo: { name: clientName, version: '1.0.0' } }, INITIALIZE_TIMEOUT_MS);
		session.notify('initialized');
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
};

class ParadisCodexAppServerRpcSession extends Disposable implements IParadisCodexAppServerRpc {

	private readonly child: cp.ChildProcess;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	constructor(command: string, env: NodeJS.ProcessEnv, private readonly logService: ILogService) {
		super();
		// `-a never`: 読み取りと消費しか呼ばないので承認は起きない。limitsMonitor と同じ理由で
		// `untrusted` は使わない（codex 0.149 以降は受け付けない）。
		const args = ['-s', 'read-only', '-a', 'never', 'app-server'];
		const shimInvocation = process.platform === 'win32' ? paradisWrapWindowsScriptShim(command, args) : undefined;
		this.child = cp.spawn(shimInvocation?.file ?? command, shimInvocation?.args ?? args, {
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			windowsVerbatimArguments: shimInvocation !== undefined,
		});
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
				pending.reject(new ParadisCodexRpcError(message.error.message ?? 'codex app-server request failed', message.error.code));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
		const result = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
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
