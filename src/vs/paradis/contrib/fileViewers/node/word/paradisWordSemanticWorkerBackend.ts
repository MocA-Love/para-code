/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word 解析の worker を必要なときだけ起動して使い回す。しばらく依頼が無ければ終了させてメモリを返す。
//
// 守り（shared process 本体を巻き込まないため）:
// - worker のヒープに上限を付ける（Office の worker と同じ 384 MiB）。上限を超えた文書は worker だけが落ちる
// - 依頼ごとに締め切りを設け、過ぎたら worker を止めてその依頼を失敗にする
// - 解析の途中で worker が落ちたら、その依頼は失敗として返す。shared process の中で解析し直さない
//   （同じ文書で本体ごと落ちるのを防ぐ）。待っていただけの依頼は、新しい worker で頼み直す
// - shared process の中で解析するのは、worker が起動直後の合図（ready）を一度も送れなかったとき、
//   つまり入口のファイルを読み込めないときだけ

import { Worker } from 'worker_threads';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IParadisWordAnalysisResult, IParadisWordComparisonResult, ParadisWordSemanticFailureCode } from '../../common/word/paradisWordSemanticSummary.js';
import type { IParadisWordSemanticBackend } from './paradisWordSemanticChannel.js';
import type { ParadisWordSemanticWorkerMessage, ParadisWordSemanticWorkerRequest } from './paradisWordSemanticWorkerProtocol.js';

/** 依頼が途絶えてから worker を終了させるまでの時間。 */
export const PARADIS_WORD_SEMANTIC_WORKER_IDLE_MS = 60_000;
/** worker が起動の合図を送るまでの待ち時間。過ぎたら入口を読み込めないものとして扱う。 */
export const PARADIS_WORD_SEMANTIC_WORKER_READY_MS = 15_000;
/** 依頼ごとの締め切り。解析・比較の内側の締め切り（60 秒）より少し長くし、内側で止まらなかったときだけ効かせる。 */
export const PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS = 75_000;
export const PARADIS_WORD_SEMANTIC_COMPARE_DEADLINE_MS = 90_000;
/** worker のヒープの上限。Office の worker（paradisOfficeWorkerHost.ts）と同じ値。 */
export const PARADIS_WORD_SEMANTIC_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 });

/** worker_threads の Worker のうち、ここで使う部分。テストでは偽物を渡す。 */
export interface IParadisWordSemanticWorker {
	postMessage(message: ParadisWordSemanticWorkerRequest, transfer?: readonly ArrayBuffer[]): void;
	on(event: 'message', listener: (message: ParadisWordSemanticWorkerMessage) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
	terminate(): Promise<number>;
}

export interface IParadisWordSemanticWorkerTimers {
	setTimeout(handler: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}

type Result = IParadisWordAnalysisResult | IParadisWordComparisonResult;

interface IPending {
	readonly id: number;
	/** worker へ送る。送るたびにバイト列を写すので、頼み直しにも使える。 */
	readonly send: (worker: IParadisWordSemanticWorker, id: number) => void;
	readonly runInProcess: () => Promise<Result>;
	readonly deadlineMs: number;
	readonly resolve: (value: Result) => void;
	readonly token: CancellationToken;
	deadline?: unknown;
	cancellation?: { dispose(): void };
}

interface WorkerState {
	readonly worker: IParadisWordSemanticWorker;
	ready: boolean;
	readyTimer?: unknown;
}

function ownedCopy(bytes: Uint8Array): Uint8Array {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function failure(code: ParadisWordSemanticFailureCode): IParadisWordAnalysisResult {
	return { ok: false, code };
}

const defaultTimers: IParadisWordSemanticWorkerTimers = {
	setTimeout: (handler, delay) => setTimeout(handler, delay),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ParadisWordSemanticWorkerBackend extends Disposable implements IParadisWordSemanticBackend {

	private state: WorkerState | undefined;
	private workerUnavailable = false;
	/** 送った順。worker は 1 件ずつ処理するので、先頭が「いま解析中」の依頼。 */
	private readonly pending: IPending[] = [];
	private nextId = 1;
	private idleTimer: unknown;

	constructor(
		private readonly createWorker: () => IParadisWordSemanticWorker,
		private readonly fallback: () => Promise<IParadisWordSemanticBackend>,
		private readonly idleMs = PARADIS_WORD_SEMANTIC_WORKER_IDLE_MS,
		private readonly timers: IParadisWordSemanticWorkerTimers = defaultTimers,
	) {
		super();
	}

	/** 本物の worker_threads の Worker を作る関数。`workerPath` は worker 入口の .js の絶対パス。 */
	static workerFactory(workerPath: string): () => IParadisWordSemanticWorker {
		return () => new Worker(workerPath, { resourceLimits: PARADIS_WORD_SEMANTIC_WORKER_RESOURCE_LIMITS }) as unknown as IParadisWordSemanticWorker;
	}

	analyze(bytes: Uint8Array, token: CancellationToken): Promise<IParadisWordAnalysisResult> {
		return this.request(
			(worker, id) => {
				const copy = ownedCopy(bytes);
				worker.postMessage({ id, op: 'analyze', bytes: copy }, [copy.buffer as ArrayBuffer]);
			},
			async () => (await this.fallback()).analyze(bytes, token),
			PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS,
			token,
		) as Promise<IParadisWordAnalysisResult>;
	}

	compare(original: Uint8Array, modified: Uint8Array, token: CancellationToken): Promise<IParadisWordComparisonResult> {
		return this.request(
			(worker, id) => {
				const left = ownedCopy(original);
				const right = ownedCopy(modified);
				worker.postMessage({ id, op: 'compare', original: left, modified: right }, [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer]);
			},
			async () => (await this.fallback()).compare(original, modified, token),
			PARADIS_WORD_SEMANTIC_COMPARE_DEADLINE_MS,
			token,
		) as Promise<IParadisWordComparisonResult>;
	}

	get running(): boolean {
		return this.state !== undefined;
	}

	override dispose(): void {
		this.clearIdleTimer();
		const pending = this.pending.splice(0);
		for (const request of pending) {
			this.settle(request, failure('cancelled'));
		}
		this.stopWorker();
		super.dispose();
	}

	private request(send: IPending['send'], runInProcess: IPending['runInProcess'], deadlineMs: number, token: CancellationToken): Promise<Result> {
		if (this._store.isDisposed || token.isCancellationRequested) {
			return Promise.resolve(failure('cancelled'));
		}
		if (this.workerUnavailable) {
			return runInProcess();
		}
		this.clearIdleTimer();
		return new Promise<Result>(resolve => {
			const request: IPending = { id: this.nextId++, send, runInProcess, deadlineMs, resolve, token };
			request.cancellation = token.onCancellationRequested(() => {
				try {
					this.state?.worker.postMessage({ id: request.id, op: 'cancel' });
				} catch {
					// worker が既に止まっていれば、待ちは exit の処理で畳まれる。
				}
			});
			this.pending.push(request);
			this.dispatch(request);
		});
	}

	/** worker へ送り、締め切りを張る。worker がまだ無ければ起動する。 */
	private dispatch(request: IPending): void {
		const state = this.ensureWorker();
		if (!state) {
			this.removePending(request);
			this.settleWith(request, request.runInProcess());
			return;
		}
		try {
			request.send(state.worker, request.id);
		} catch {
			this.removePending(request);
			this.settle(request, failure('failed'));
			this.scheduleIdle();
			return;
		}
		if (request.deadline === undefined) {
			request.deadline = this.timers.setTimeout(() => this.expire(request), request.deadlineMs);
		}
	}

	private ensureWorker(): WorkerState | undefined {
		if (this.state) {
			return this.state;
		}
		let worker: IParadisWordSemanticWorker;
		try {
			worker = this.createWorker();
		} catch {
			this.workerUnavailable = true;
			return undefined;
		}
		const state: WorkerState = { worker, ready: false };
		this.state = state;
		state.readyTimer = this.timers.setTimeout(() => this.lost(state, 'notReady'), PARADIS_WORD_SEMANTIC_WORKER_READY_MS);
		worker.on('message', message => {
			if (this.state !== state) {
				return;
			}
			if (message.kind === 'ready') {
				state.ready = true;
				this.timers.clearTimeout(state.readyTimer);
				return;
			}
			const index = this.pending.findIndex(request => request.id === message.id);
			if (index < 0) {
				return;
			}
			const [request] = this.pending.splice(index, 1);
			this.settle(request, message.result);
			this.scheduleIdle();
		});
		const onLost = () => this.lost(state, state.ready ? 'crashed' : 'notReady');
		worker.on('error', onLost);
		worker.on('exit', onLost);
		return state;
	}

	/**
	 * worker が無くなった。起動の合図の前なら入口を読み込めていないので、以後は shared process の中で解析する
	 * （まだ一度も解析していないので、同じ入力で本体が落ちる心配は無い）。合図の後なら、解析中だった依頼は
	 * 失敗にし、待っていただけの依頼は新しい worker で頼み直す。
	 */
	private lost(state: WorkerState, reason: 'notReady' | 'crashed'): void {
		if (this.state !== state) {
			return;
		}
		this.timers.clearTimeout(state.readyTimer);
		this.state = undefined;
		void state.worker.terminate().catch(() => undefined);
		const pending = this.pending.splice(0);
		if (reason === 'notReady') {
			this.workerUnavailable = true;
			for (const request of pending) {
				this.clearDeadline(request);
				this.settleWith(request, request.runInProcess());
			}
			return;
		}
		const [running, ...waiting] = pending;
		if (running) {
			this.settle(running, failure('limitExceeded'));
		}
		this.redispatch(waiting);
	}

	/** 締め切りを過ぎた。worker を止めてその依頼を失敗にし、ほかの依頼は新しい worker で頼み直す。 */
	private expire(request: IPending): void {
		request.deadline = undefined;
		if (!this.pending.includes(request)) {
			return;
		}
		const state = this.state;
		this.state = undefined;
		if (state) {
			this.timers.clearTimeout(state.readyTimer);
			void state.worker.terminate().catch(() => undefined);
		}
		const waiting = this.pending.splice(0).filter(other => other !== request);
		this.settle(request, failure('limitExceeded'));
		this.redispatch(waiting);
	}

	private redispatch(requests: readonly IPending[]): void {
		for (const request of requests) {
			if (request.token.isCancellationRequested) {
				this.settle(request, failure('cancelled'));
				continue;
			}
			this.clearDeadline(request);
			this.pending.push(request);
			this.dispatch(request);
		}
		this.scheduleIdle();
	}

	private settleWith(request: IPending, result: Promise<Result>): void {
		result.then(value => this.settle(request, value), () => this.settle(request, failure('failed')));
	}

	private settle(request: IPending, value: Result): void {
		this.clearDeadline(request);
		request.cancellation?.dispose();
		request.resolve(value);
	}

	private clearDeadline(request: IPending): void {
		if (request.deadline !== undefined) {
			this.timers.clearTimeout(request.deadline);
			request.deadline = undefined;
		}
	}

	private removePending(request: IPending): void {
		const index = this.pending.indexOf(request);
		if (index >= 0) {
			this.pending.splice(index, 1);
		}
	}

	private stopWorker(): void {
		const state = this.state;
		this.state = undefined;
		if (state) {
			this.timers.clearTimeout(state.readyTimer);
			void state.worker.terminate().catch(() => undefined);
		}
	}

	private scheduleIdle(): void {
		this.clearIdleTimer();
		if (this.pending.length > 0 || !this.state) {
			return;
		}
		this.idleTimer = this.timers.setTimeout(() => {
			this.idleTimer = undefined;
			if (this.pending.length === 0) {
				this.stopWorker();
			}
		}, this.idleMs);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== undefined) {
			this.timers.clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}
