/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word 解析の worker を必要なときだけ起動して使い回す。しばらく依頼が無ければ終了させてメモリを返す。
// worker を起動できない（入口のファイルが無い等）・途中で落ちたときは、shared process の中で解析し直す
// （表示には関係しない処理なので、遅くなっても結果を返すほうを選ぶ）。

import { Worker } from 'worker_threads';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IParadisWordAnalysisResult, IParadisWordComparisonResult } from '../../common/word/paradisWordSemanticSummary.js';
import type { IParadisWordSemanticBackend } from './paradisWordSemanticChannel.js';
import type { ParadisWordSemanticWorkerReply, ParadisWordSemanticWorkerRequest } from './paradisWordSemanticWorkerProtocol.js';

/** 依頼が途絶えてから worker を終了させるまでの時間。 */
export const PARADIS_WORD_SEMANTIC_WORKER_IDLE_MS = 60_000;

/** worker_threads の Worker のうち、ここで使う部分。テストでは偽物を渡す。 */
export interface IParadisWordSemanticWorker {
	postMessage(message: ParadisWordSemanticWorkerRequest, transfer?: readonly ArrayBuffer[]): void;
	on(event: 'message', listener: (reply: ParadisWordSemanticWorkerReply) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
	terminate(): Promise<number>;
}

interface IPending {
	readonly resolve: (value: IParadisWordAnalysisResult | IParadisWordComparisonResult) => void;
	readonly fail: () => void;
}

const cancelled: IParadisWordAnalysisResult = Object.freeze({ ok: false, code: 'cancelled' });

function ownedCopy(bytes: Uint8Array): Uint8Array {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export class ParadisWordSemanticWorkerBackend extends Disposable implements IParadisWordSemanticBackend {

	private worker: IParadisWordSemanticWorker | undefined;
	private workerUnavailable = false;
	private readonly pending = new Map<number, IPending>();
	private nextId = 1;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly createWorker: () => IParadisWordSemanticWorker,
		private readonly fallback: () => Promise<IParadisWordSemanticBackend>,
		private readonly idleMs = PARADIS_WORD_SEMANTIC_WORKER_IDLE_MS,
	) {
		super();
	}

	/** 本物の worker_threads の Worker を作る関数。`workerPath` は worker 入口の .js の絶対パス。 */
	static workerFactory(workerPath: string): () => IParadisWordSemanticWorker {
		return () => new Worker(workerPath) as unknown as IParadisWordSemanticWorker;
	}

	analyze(bytes: Uint8Array, token: CancellationToken): Promise<IParadisWordAnalysisResult> {
		const copy = ownedCopy(bytes);
		return this.request<IParadisWordAnalysisResult>(id => ({ id, op: 'analyze', bytes: copy }), [copy.buffer as ArrayBuffer], token,
			async () => (await this.fallback()).analyze(bytes, token));
	}

	compare(original: Uint8Array, modified: Uint8Array, token: CancellationToken): Promise<IParadisWordComparisonResult> {
		const left = ownedCopy(original);
		const right = ownedCopy(modified);
		return this.request<IParadisWordComparisonResult>(id => ({ id, op: 'compare', original: left, modified: right }), [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer], token,
			async () => (await this.fallback()).compare(original, modified, token));
	}

	get running(): boolean {
		return this.worker !== undefined;
	}

	override dispose(): void {
		this.clearIdleTimer();
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const value of pending) {
			value.resolve({ ok: false, code: 'cancelled' });
		}
		this.stop();
		super.dispose();
	}

	private request<T extends IParadisWordAnalysisResult | IParadisWordComparisonResult>(
		build: (id: number) => ParadisWordSemanticWorkerRequest, transfer: readonly ArrayBuffer[], token: CancellationToken, runFallback: () => Promise<T>,
	): Promise<T> {
		if (this._store.isDisposed || token.isCancellationRequested) {
			return Promise.resolve(cancelled as T);
		}
		const worker = this.workerUnavailable ? undefined : this.ensureWorker();
		if (!worker) {
			return runFallback();
		}
		this.clearIdleTimer();
		const id = this.nextId++;
		return new Promise<T>(resolve => {
			const cancellation = token.onCancellationRequested(() => {
				try {
					worker.postMessage({ id, op: 'cancel' });
				} catch {
					// worker が既に止まっていれば、待ちは exit の処理で畳まれる。
				}
			});
			this.pending.set(id, {
				resolve: value => { cancellation.dispose(); resolve(value as T); },
				fail: () => { cancellation.dispose(); resolve(runFallback()); },
			});
			try {
				worker.postMessage(build(id), transfer);
			} catch {
				this.pending.get(id)?.fail();
				this.pending.delete(id);
				this.scheduleIdle();
			}
		});
	}

	private ensureWorker(): IParadisWordSemanticWorker | undefined {
		if (this.worker) {
			return this.worker;
		}
		let worker: IParadisWordSemanticWorker;
		try {
			worker = this.createWorker();
		} catch {
			this.workerUnavailable = true;
			return undefined;
		}
		this.worker = worker;
		let answered = false;
		worker.on('message', reply => {
			answered = true;
			const pending = this.pending.get(reply.id);
			if (!pending) {
				return;
			}
			this.pending.delete(reply.id);
			pending.resolve(reply.result);
			this.scheduleIdle();
		});
		const lost = () => {
			if (this.worker !== worker) {
				return;
			}
			// 一度も答えずに落ちた worker は、入口を読み込めていない。以後は shared process の中で解析する。
			if (!answered) {
				this.workerUnavailable = true;
			}
			this.worker = undefined;
			this.failAll();
		};
		worker.on('error', lost);
		worker.on('exit', lost);
		return worker;
	}

	private stop(): void {
		const worker = this.worker;
		this.worker = undefined;
		this.failAll();
		void worker?.terminate().catch(() => undefined);
	}

	private failAll(): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const value of pending) {
			value.fail();
		}
	}

	private scheduleIdle(): void {
		this.clearIdleTimer();
		if (this.pending.size > 0 || !this.worker) {
			return;
		}
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.pending.size === 0) {
				this.stop();
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
