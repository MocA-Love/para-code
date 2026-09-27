/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話ログを読む worker を、必要なときだけ起動して使い回す。
//
// 使用量ダイアログやセッション履歴を開いている間だけ仕事があるので、しばらく依頼が無ければ終了させて
// メモリを返す。worker が落ちたら、待っている依頼をすべて失敗させ、次の依頼で起動し直す。

import { Worker } from 'worker_threads';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisActivityWorkerEnvelope, ParadisActivityWorkerReply, ParadisActivityWorkerRequest } from '../common/paradisAgentActivityWorkerProtocol.js';

/** 依頼が途絶えてから worker を終了させるまでの時間。 */
export const PARADIS_ACTIVITY_WORKER_IDLE_MS = 90_000;

/** worker_threads の Worker のうち、ここで使う部分。テストでは偽物を渡す。 */
export interface IParadisActivityWorker {
	postMessage(message: IParadisActivityWorkerEnvelope): void;
	on(event: 'message', listener: (reply: ParadisActivityWorkerReply) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
	terminate(): Promise<number>;
}

interface IPending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class ParadisAgentActivityWorkerHost extends Disposable {

	private worker: IParadisActivityWorker | undefined;
	private readonly pending = new Map<number, IPending>();
	private nextId = 1;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly createWorker: () => IParadisActivityWorker,
		private readonly idleMs = PARADIS_ACTIVITY_WORKER_IDLE_MS,
	) {
		super();
	}

	/** 本物の worker_threads の Worker を作る関数。`workerPath` は worker 入口の .js の絶対パス。 */
	static workerFactory(workerPath: string): () => IParadisActivityWorker {
		return () => new Worker(workerPath) as unknown as IParadisActivityWorker;
	}

	get running(): boolean {
		return this.worker !== undefined;
	}

	request<T>(request: ParadisActivityWorkerRequest): Promise<T> {
		if (this._store.isDisposed) {
			return Promise.reject(new Error('The agent activity worker has been disposed.'));
		}
		this.clearIdleTimer();
		const worker = this.ensureWorker();
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: value => resolve(value as T), reject });
			try {
				worker.postMessage({ id, request });
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
				this.scheduleIdle();
			}
		});
	}

	override dispose(): void {
		this.clearIdleTimer();
		this.stop(new Error('The agent activity worker has been disposed.'));
		super.dispose();
	}

	private ensureWorker(): IParadisActivityWorker {
		if (this.worker) {
			return this.worker;
		}
		const worker = this.createWorker();
		this.worker = worker;
		worker.on('message', reply => {
			const pending = this.pending.get(reply.id);
			if (!pending) {
				return;
			}
			this.pending.delete(reply.id);
			if (reply.ok) {
				pending.resolve(reply.value);
			} else {
				pending.reject(new Error(reply.error));
			}
			this.scheduleIdle();
		});
		worker.on('error', error => {
			if (this.worker === worker) {
				this.stop(error);
			}
		});
		worker.on('exit', code => {
			if (this.worker === worker) {
				this.worker = undefined;
				this.rejectAll(new Error(`The agent activity worker exited unexpectedly (code ${code}).`));
			}
		});
		return worker;
	}

	private stop(error: Error): void {
		const worker = this.worker;
		this.worker = undefined;
		this.rejectAll(error);
		void worker?.terminate().catch(() => undefined);
	}

	private rejectAll(error: Error): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) {
			entry.reject(error);
		}
	}

	private scheduleIdle(): void {
		if (this.pending.size > 0 || !this.worker) {
			return;
		}
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.pending.size === 0 && this.worker) {
				const worker = this.worker;
				this.worker = undefined;
				void worker.terminate().catch(() => undefined);
			}
		}, this.idleMs);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== undefined) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}
