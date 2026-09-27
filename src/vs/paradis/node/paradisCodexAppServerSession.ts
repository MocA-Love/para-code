/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `codex app-server`（改行区切りの JSON-RPC over stdio）を1回分だけ起こす共通部品。
// hook の信頼付与（`hooks/list` → `config/batchWrite`）とモデル一覧（`model/list`）が使う。
//
// 起こすたびに initialize → initialized の握手を済ませてから呼び出し側へ渡し、終わったら
// 必ずプロセスツリーごと止める。どの CODEX_HOME に対して動かすかは env で決まる。

import * as cp from 'child_process';
import { IDisposable } from '../../base/common/lifecycle.js';
import { paradisSpawnAgentCli } from './paradisAgentCli.js';
import { paradisKillChildProcessTree } from './paradisKillChildProcess.js';

/** 呼び出し側から見た RPC の窓口（テストでは偽物に差し替える）。 */
export interface IParadisCodexRpc extends IDisposable {
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

/** Codex が「そのメソッドは無い」と答えた（古い CLI など）。 */
export class ParadisCodexRpcMethodNotFoundError extends Error {
	constructor(method: string, message: string) {
		super(`codex app-server does not support ${method}: ${message}`);
		this.name = 'ParadisCodexRpcMethodNotFoundError';
	}
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const STDERR_TAIL_MAX_CHARS = 4_000;

class ParadisCodexAppServerSession implements IParadisCodexRpc {

	private buffer = '';
	private nextId = 1;
	private stderrTail = '';
	private exited = false;
	private exitError: Error | undefined;
	private readonly pending = new Map<number, { readonly method: string; resolve(value: unknown): void; reject(error: Error): void }>();

	constructor(private readonly child: cp.ChildProcessWithoutNullStreams) {
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
		});
		child.stdin.on('error', error => this.failAll(error));
		child.on('error', error => this.failAll(new Error(`failed to launch codex app-server: ${error.message}`)));
		child.on('close', (code, signal) => {
			this.exited = true;
			this.failAll(new Error(`codex app-server exited (code=${code}, signal=${signal})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ''}`));
		});
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line.startsWith('{')) {
				continue;
			}
			let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof message.id !== 'number') {
				continue; // 通知とサーバーからの要求は使わない
			}
			const waiter = this.pending.get(message.id);
			if (!waiter) {
				continue;
			}
			this.pending.delete(message.id);
			if (message.error) {
				const text = typeof message.error.message === 'string' ? message.error.message : 'request failed';
				waiter.reject(message.error.code === JSON_RPC_METHOD_NOT_FOUND || /method not found|unknown variant/i.test(text)
					? new ParadisCodexRpcMethodNotFoundError(waiter.method, text)
					: new Error(`codex app-server ${waiter.method} failed: ${text}`));
			} else {
				waiter.resolve(message.result);
			}
		}
	}

	request(method: string, params: unknown, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (this.exited || this.exitError) {
			return Promise.reject(this.exitError ?? new Error('codex app-server already exited'));
		}
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: value => { clearTimeout(timer); resolve(value); },
				reject: error => { clearTimeout(timer); reject(error); },
			});
			this.child.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
		});
	}

	notify(method: string): void {
		if (!this.exited) {
			this.child.stdin.write(`${JSON.stringify({ method })}\n`);
		}
	}

	private failAll(error: Error): void {
		this.exitError ??= error;
		for (const waiter of this.pending.values()) {
			waiter.reject(error);
		}
		this.pending.clear();
	}

	dispose(): void {
		this.failAll(new Error('codex app-server session disposed'));
		paradisKillChildProcessTree(this.child);
	}
}

export interface IParadisOpenCodexAppServerOptions {
	/** 解決済みの codex 実行ファイル。 */
	readonly command: string;
	/** 子へ渡す環境変数。CODEX_HOME はここで上書きする。 */
	readonly env: NodeJS.ProcessEnv;
	/** 対象の CODEX_HOME（絶対パス）。 */
	readonly codexHome: string;
	/** initialize の clientInfo.name。 */
	readonly clientName: string;
	readonly cwd?: string;
}

/**
 * `codex app-server` を起こして握手まで済ませる。失敗したら子を止めてから例外にする。
 * 使い終わったら必ず dispose すること。
 */
export async function paradisOpenCodexAppServer(options: IParadisOpenCodexAppServerOptions): Promise<IParadisCodexRpc> {
	const child = paradisSpawnAgentCli(options.command, ['app-server'], {
		env: { ...options.env, CODEX_HOME: options.codexHome },
		cwd: options.cwd,
	});
	const session = new ParadisCodexAppServerSession(child);
	try {
		await session.request('initialize', { clientInfo: { name: options.clientName, title: 'Para Code', version: '1.0.0' } });
		session.notify('initialized');
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
}
