/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office の詳しい解析を worker（別スレッド）で 1 件ずつ走らせる待ち行列。worker は必要なときだけ起動し、
// しばらく依頼が無ければ終了させてメモリを返す。作りは Word の worker（word/paradisWordSemanticWorkerBackend.ts）
// と同じで、待ち行列のバイト数の上限と、混み合ったときの `busy` を足してある。
//
// 守り（shared process 本体を巻き込まないため）:
// - worker のヒープに上限を付ける（呼び出し側が resourceLimits を渡す）。上限を超えた文書は worker だけが落ちる
// - worker へ送るのは 1 件ずつ。待っている依頼はこちらの待ち行列に置き、worker には送らない
// - 実行の締め切りは、先頭になって worker へ送った時点で張る。過ぎたら worker を止め、その依頼だけを失敗にする
// - 待ち行列には別の締め切りを設ける。過ぎたら worker は止めず、その依頼だけを `busy` で返す
// - 待ち行列の件数とバイト数に上限を付ける（待っている依頼は、それぞれ文書のバイト列を掴んでいるため）。
//   超えたら走らせずに `busy` で返す。呼び出し側は間を空けて頼み直せる
// - 取り消しのトークンが来たら、待っている依頼は外し、走っている依頼は worker へ取り消しを送る
// - worker が落ちたら、走っていた依頼は失敗として返す。shared process の中で解析し直すことはしない
// - メモリ不足で落ちた入力は SHA-256 で覚えておき（新しいものから 8 件）、同じ入力が来たら走らせずに返す。
//   覚えている入力が無い間は、ハッシュを求めない

import { createHash } from 'crypto';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/** 失敗の種類。`busy` は混み合っていて走らせなかった（頼み直せる）。 */
export type ParadisOfficeSemanticWorkerFailure = 'cancelled' | 'busy' | 'failed' | 'limitExceeded';

/** shared process → worker。`run` の中身は解析ごとに決める。 */
export type ParadisOfficeSemanticWorkerMessage<TRun> =
	| { readonly id: number; readonly op: 'run'; readonly request: TRun }
	| { readonly id: number; readonly op: 'cancel' };

/** worker → shared process。 */
export interface IParadisOfficeSemanticWorkerReply<TResult> {
	readonly kind: 'result';
	readonly id: number;
	readonly result: TResult;
}

/** worker_threads の Worker のうち、ここで使う部分。テストでは偽物を渡す。 */
export interface IParadisOfficeSemanticWorker<TRun, TResult> {
	postMessage(message: ParadisOfficeSemanticWorkerMessage<TRun>, transfer?: readonly ArrayBuffer[]): void;
	on(event: 'message', listener: (message: IParadisOfficeSemanticWorkerReply<TResult>) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
	terminate(): Promise<number>;
}

export interface IParadisOfficeSemanticWorkerTimers {
	setTimeout(handler: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface IParadisOfficeSemanticWorkerQueueOptions<TRun, TResult> {
	readonly createWorker: () => IParadisOfficeSemanticWorker<TRun, TResult>;
	/** 失敗の種類を、解析ごとの結果の形にする。 */
	readonly failure: (code: ParadisOfficeSemanticWorkerFailure) => TResult;
	/** 実行の締め切り。worker の中の締め切りが先に効くよう、それより長くする。 */
	readonly runDeadlineMs: number;
	/** 待ち行列で待てる時間。 */
	readonly queueDeadlineMs: number;
	/** 待ち行列に置ける依頼の数（走っている 1 件は数えない）。 */
	readonly queueLimit: number;
	/** 待ち行列に置ける依頼のバイト数の合計（走っている 1 件は数えない）。 */
	readonly queueByteLimit: number;
	/** 依頼が途絶えてから worker を終了させるまでの時間。 */
	readonly idleMs: number;
	readonly timers?: IParadisOfficeSemanticWorkerTimers;
}

/** 依頼ごとの指定。 */
export interface IParadisOfficeSemanticWorkerRunOptions {
	/** 実行の締め切り。無ければ待ち行列の既定値。 */
	readonly runDeadlineMs?: number;
	/**
	 * メモリ不足の記録の鍵にするバイト列（複数のときは並び順も鍵に含む）。渡さなければ記録も照合もしない。
	 */
	readonly memoryKeys?: readonly Uint8Array[];
}

/** 覚えておくメモリ不足の入力の数。 */
const OUT_OF_MEMORY_MEMORY = 8;

function memoryKey(inputs: readonly Uint8Array[]): string {
	return `${inputs.length}:${inputs.map(input => createHash('sha256').update(input).digest('hex')).join(':')}`;
}

interface IQueuedRequest<TRun, TResult> {
	readonly id: number;
	readonly byteLength: number;
	readonly runDeadlineMs: number;
	readonly memoryKeys?: readonly Uint8Array[];
	/** 求めた鍵（記録が無いうちは求めない）。 */
	memoryKey?: string;
	/** worker へ送る中身を作る。送るときにバイト列を写す（送ると元の ArrayBuffer は手放すため）。 */
	readonly prepare: () => { readonly request: TRun; readonly transfer: readonly ArrayBuffer[] };
	readonly resolve: (value: TResult) => void;
	timer?: unknown;
	cancellation?: { dispose(): void };
}

function isOutOfMemory(error: unknown): boolean {
	return !!error && typeof error === 'object' && (error as { readonly code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY';
}

const defaultTimers: IParadisOfficeSemanticWorkerTimers = {
	setTimeout: (handler, delay) => setTimeout(handler, delay),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 呼び出し側のバイト列を写す。worker へ移すと元の ArrayBuffer は使えなくなるため。 */
export function ownedParadisOfficeBytes(bytes: Uint8Array): Uint8Array {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export class ParadisOfficeSemanticWorkerQueue<TRun, TResult> extends Disposable {

	private worker: IParadisOfficeSemanticWorker<TRun, TResult> | undefined;
	/** いま worker が処理している依頼（1 件だけ）。 */
	private running: IQueuedRequest<TRun, TResult> | undefined;
	/** まだ worker へ送っていない依頼。 */
	private readonly queue: IQueuedRequest<TRun, TResult>[] = [];
	private queuedBytes = 0;
	/** メモリ不足で落ちた入力の鍵。古いものが先頭。 */
	private readonly outOfMemoryKeys: string[] = [];
	private nextId = 1;
	private idleTimer: unknown;
	private readonly timers: IParadisOfficeSemanticWorkerTimers;

	constructor(private readonly options: IParadisOfficeSemanticWorkerQueueOptions<TRun, TResult>) {
		super();
		this.timers = options.timers ?? defaultTimers;
	}

	get workerRunning(): boolean {
		return this.worker !== undefined;
	}

	/**
	 * 1 件を頼む。`byteLength` は待ち行列のバイト数の上限に数える大きさ、`prepare` は worker へ送る直前に
	 * 呼ばれて、送る中身と移す ArrayBuffer を返す。
	 */
	run(byteLength: number, prepare: IQueuedRequest<TRun, TResult>['prepare'], token: CancellationToken, runOptions: IParadisOfficeSemanticWorkerRunOptions = {}): Promise<TResult> {
		if (this._store.isDisposed || token.isCancellationRequested) {
			return Promise.resolve(this.options.failure('cancelled'));
		}
		let key: string | undefined;
		if (runOptions.memoryKeys && this.outOfMemoryKeys.length > 0) {
			key = memoryKey(runOptions.memoryKeys);
			if (this.outOfMemoryKeys.includes(key)) {
				// 前にこの入力で worker がメモリ不足になった。もう一度走らせても同じように落ちる。
				return Promise.resolve(this.options.failure('limitExceeded'));
			}
		}
		const waiting = this.running !== undefined || this.queue.length > 0;
		if (waiting && (this.queue.length >= this.options.queueLimit || this.queuedBytes + byteLength > this.options.queueByteLimit)) {
			return Promise.resolve(this.options.failure('busy'));
		}
		this.clearIdleTimer();
		return new Promise<TResult>(resolve => {
			const request: IQueuedRequest<TRun, TResult> = {
				id: this.nextId++, byteLength, prepare, resolve,
				runDeadlineMs: runOptions.runDeadlineMs ?? this.options.runDeadlineMs,
				...(runOptions.memoryKeys ? { memoryKeys: runOptions.memoryKeys } : {}),
				...(key ? { memoryKey: key } : {}),
			};
			request.cancellation = token.onCancellationRequested(() => this.cancel(request));
			this.queue.push(request);
			this.queuedBytes += byteLength;
			// 待ち行列の締め切り。走り始めたら張り替える。
			request.timer = this.timers.setTimeout(() => this.expireQueued(request), this.options.queueDeadlineMs);
			this.pump();
		});
	}

	override dispose(): void {
		this.clearIdleTimer();
		const requests = [...(this.running ? [this.running] : []), ...this.queue.splice(0)];
		this.queuedBytes = 0;
		this.running = undefined;
		for (const request of requests) {
			this.settle(request, this.options.failure('cancelled'));
		}
		this.stopWorker();
		super.dispose();
	}

	/** 走っている依頼が無ければ、待ち行列の先頭を worker へ送る。 */
	private pump(): void {
		while (!this.running && this.queue.length > 0) {
			const request = this.dequeue(0);
			this.clearTimer(request);
			const worker = this.ensureWorker();
			if (!worker) {
				this.settle(request, this.options.failure('failed'));
				continue;
			}
			try {
				const { request: payload, transfer } = request.prepare();
				worker.postMessage({ id: request.id, op: 'run', request: payload }, transfer);
			} catch {
				this.settle(request, this.options.failure('failed'));
				continue;
			}
			this.running = request;
			request.timer = this.timers.setTimeout(() => this.expireRunning(request), request.runDeadlineMs);
		}
		this.scheduleIdle();
	}

	private dequeue(index: number): IQueuedRequest<TRun, TResult> {
		const [request] = this.queue.splice(index, 1);
		this.queuedBytes -= request.byteLength;
		return request;
	}

	private ensureWorker(): IParadisOfficeSemanticWorker<TRun, TResult> | undefined {
		if (this.worker) {
			return this.worker;
		}
		let worker: IParadisOfficeSemanticWorker<TRun, TResult>;
		try {
			worker = this.options.createWorker();
		} catch {
			// 起動できなかった。次の依頼でもう一度試す。
			return undefined;
		}
		this.worker = worker;
		let crash: unknown;
		worker.on('message', message => {
			if (this.worker !== worker || message?.kind !== 'result' || this.running?.id !== message.id) {
				return;
			}
			const request = this.running;
			this.running = undefined;
			this.settle(request, message.result);
			this.pump();
		});
		worker.on('error', error => {
			crash = error;
			this.lost(worker, error);
		});
		worker.on('exit', () => this.lost(worker, crash));
		return worker;
	}

	/** worker が落ちた。走っていた依頼は失敗にし（メモリ不足なら大きすぎる扱い）、待っている依頼は新しい worker で続ける。 */
	private lost(worker: IParadisOfficeSemanticWorker<TRun, TResult>, error: unknown): void {
		if (this.worker !== worker) {
			return;
		}
		this.worker = undefined;
		void worker.terminate().catch(() => undefined);
		const request = this.running;
		this.running = undefined;
		if (request) {
			const outOfMemory = isOutOfMemory(error);
			if (outOfMemory && request.memoryKeys) {
				this.rememberOutOfMemory(request.memoryKey ?? memoryKey(request.memoryKeys));
			}
			this.settle(request, this.options.failure(outOfMemory ? 'limitExceeded' : 'failed'));
		}
		this.pump();
	}

	/** 実行の締め切りを過ぎた。worker を止めてこの依頼だけを失敗にし、待っている依頼は新しい worker で続ける。 */
	private expireRunning(request: IQueuedRequest<TRun, TResult>): void {
		request.timer = undefined;
		if (this.running !== request) {
			return;
		}
		this.running = undefined;
		this.stopWorker();
		this.settle(request, this.options.failure('limitExceeded'));
		this.pump();
	}

	/** 待ち行列で待ちすぎた。worker は止めず、この依頼だけを走らせずに返す（混み合っていた）。 */
	private expireQueued(request: IQueuedRequest<TRun, TResult>): void {
		request.timer = undefined;
		const index = this.queue.indexOf(request);
		if (index < 0) {
			return;
		}
		this.dequeue(index);
		this.settle(request, this.options.failure('busy'));
		this.scheduleIdle();
	}

	private cancel(request: IQueuedRequest<TRun, TResult>): void {
		const index = this.queue.indexOf(request);
		if (index >= 0) {
			this.dequeue(index);
			this.settle(request, this.options.failure('cancelled'));
			this.scheduleIdle();
			return;
		}
		if (this.running === request) {
			try {
				this.worker?.postMessage({ id: request.id, op: 'cancel' });
			} catch {
				// worker が既に止まっていれば、待ちは exit の処理で畳まれる。
			}
		}
	}

	private rememberOutOfMemory(key: string): void {
		const index = this.outOfMemoryKeys.indexOf(key);
		if (index >= 0) {
			this.outOfMemoryKeys.splice(index, 1);
		}
		this.outOfMemoryKeys.push(key);
		while (this.outOfMemoryKeys.length > OUT_OF_MEMORY_MEMORY) {
			this.outOfMemoryKeys.shift();
		}
	}

	private settle(request: IQueuedRequest<TRun, TResult>, value: TResult): void {
		this.clearTimer(request);
		request.cancellation?.dispose();
		request.resolve(value);
	}

	private clearTimer(request: IQueuedRequest<TRun, TResult>): void {
		if (request.timer !== undefined) {
			this.timers.clearTimeout(request.timer);
			request.timer = undefined;
		}
	}

	private stopWorker(): void {
		const worker = this.worker;
		this.worker = undefined;
		void worker?.terminate().catch(() => undefined);
	}

	private scheduleIdle(): void {
		this.clearIdleTimer();
		if (this.running || this.queue.length > 0 || !this.worker) {
			return;
		}
		this.idleTimer = this.timers.setTimeout(() => {
			this.idleTimer = undefined;
			if (!this.running && this.queue.length === 0) {
				this.stopWorker();
			}
		}, this.options.idleMs);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== undefined) {
			this.timers.clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}
