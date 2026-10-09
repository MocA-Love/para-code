/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word 解析の worker を必要なときだけ起動して使い回す。しばらく依頼が無ければ終了させてメモリを返す。
//
// 守り（shared process 本体を巻き込まないため。作りは paradisOfficeWorkerHost.ts に合わせた）:
// - worker のヒープに上限を付ける（Office の worker と同じ 384 MiB）。上限を超えた文書は worker だけが落ちる
// - worker へ送るのは 1 件ずつ。待っている依頼はこちらの待ち行列に置き、worker には送らない
// - 実行の締め切りは、先頭になって worker へ送った時点で張る。過ぎたら worker を止め、その依頼だけを失敗にする
// - 待ち行列には別の締め切りを設ける。過ぎたら worker は止めず、その依頼だけを取り消して返す
// - 待ち行列の長さに上限を付ける（待っている依頼は、それぞれ文書のバイト列を掴んでいるため）
// - worker が落ちたら、走っていた依頼は失敗として返す。shared process の中で解析し直すことはしない
//   （表示は解析に頼っていないので、解析できないだけで済む）。次の依頼では新しい worker を起動し直す

import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IParadisWordAnalysisResult, IParadisWordComparisonResult, ParadisWordSemanticFailureCode } from '../../common/word/paradisWordSemanticSummary.js';
import type { IParadisWordSemanticBackend } from './paradisWordSemanticChannel.js';
import type { ParadisWordSemanticWorkerMessage, ParadisWordSemanticWorkerRequest } from './paradisWordSemanticWorkerProtocol.js';

/** 依頼が途絶えてから worker を終了させるまでの時間。 */
export const PARADIS_WORD_SEMANTIC_WORKER_IDLE_MS = 60_000;
/**
 * 実行の締め切り。内側の締め切り（部品一覧 30 秒＋解析 60 秒、比較は全体で 60 秒＋部品一覧 30 秒×2）が
 * 先に効くよう、それより長くしてある。内側で止まらなかったときだけ worker を止める。
 */
export const PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS = 120_000;
export const PARADIS_WORD_SEMANTIC_COMPARE_DEADLINE_MS = 150_000;
/** 待ち行列で待てる時間。過ぎた依頼は走らせずに取り消す。 */
export const PARADIS_WORD_SEMANTIC_QUEUE_DEADLINE_MS = 60_000;
/** 待ち行列に置ける依頼の数（走っている 1 件は数えない）。 */
export const PARADIS_WORD_SEMANTIC_QUEUE_LIMIT = 8;
/** 待ち行列の依頼が掴んでいるバイト列の合計の上限。 */
export const PARADIS_WORD_SEMANTIC_QUEUE_BYTES_LIMIT = 96 * 1024 * 1024;
/** メモリ不足で worker を落とした文書を覚えておく数。同じ文書は次から worker を起動せずに断る。 */
export const PARADIS_WORD_SEMANTIC_OOM_MEMORY = 8;
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

interface IRequest {
	readonly id: number;
	/** worker へ送る。送るときにバイト列を写す（送ると元の ArrayBuffer は手放すため）。 */
	readonly send: (worker: IParadisWordSemanticWorker, id: number) => void;
	readonly runDeadlineMs: number;
	/** 待ち行列で掴んでいるバイト数。 */
	readonly bytes: number;
	/** 依頼の入力。メモリ不足で落ちたときに、覚えておく鍵を作るために持つ。 */
	readonly inputs: readonly Uint8Array[];
	readonly resolve: (value: Result) => void;
	readonly token: CancellationToken;
	timer?: unknown;
	cancellation?: { dispose(): void };
}

function ownedCopy(bytes: Uint8Array): Uint8Array {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function failure(code: ParadisWordSemanticFailureCode): IParadisWordAnalysisResult {
	return { ok: false, code };
}

function isOutOfMemory(error: unknown): boolean {
	return !!error && typeof error === 'object' && (error as { readonly code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY';
}

const defaultTimers: IParadisWordSemanticWorkerTimers = {
	setTimeout: (handler, delay) => setTimeout(handler, delay),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** メモリ不足で落ちた依頼を覚えておくための鍵（入力の数と、それぞれの SHA-256）。 */
function outOfMemoryKey(inputs: readonly Uint8Array[]): string {
	return `${inputs.length}:${inputs.map(input => createHash('sha256').update(input).digest('hex')).join(':')}`;
}

export class ParadisWordSemanticWorkerBackend extends Disposable implements IParadisWordSemanticBackend {

	private worker: IParadisWordSemanticWorker | undefined;
	/** いま worker が処理している依頼（1 件だけ）。 */
	private running: IRequest | undefined;
	/** まだ worker へ送っていない依頼。 */
	private readonly queue: IRequest[] = [];
	private nextId = 1;
	private idleTimer: unknown;
	/** メモリ不足で worker を落とした依頼の入力（古いものから捨てる）。 */
	private readonly outOfMemoryKeys: string[] = [];

	constructor(
		private readonly createWorker: () => IParadisWordSemanticWorker,
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
		return this.request((worker, id) => {
			const copy = ownedCopy(bytes);
			worker.postMessage({ id, op: 'analyze', bytes: copy }, [copy.buffer as ArrayBuffer]);
		}, PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS, [bytes], token) as Promise<IParadisWordAnalysisResult>;
	}

	compare(original: Uint8Array, modified: Uint8Array, token: CancellationToken): Promise<IParadisWordComparisonResult> {
		return this.request((worker, id) => {
			const left = ownedCopy(original);
			const right = ownedCopy(modified);
			worker.postMessage({ id, op: 'compare', original: left, modified: right }, [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer]);
		}, PARADIS_WORD_SEMANTIC_COMPARE_DEADLINE_MS, [original, modified], token) as Promise<IParadisWordComparisonResult>;
	}

	get workerRunning(): boolean {
		return this.worker !== undefined;
	}

	override dispose(): void {
		this.clearIdleTimer();
		const requests = [...(this.running ? [this.running] : []), ...this.queue.splice(0)];
		this.running = undefined;
		for (const request of requests) {
			this.settle(request, failure('cancelled'));
		}
		this.stopWorker();
		super.dispose();
	}

	private request(send: IRequest['send'], runDeadlineMs: number, inputs: readonly Uint8Array[], token: CancellationToken): Promise<Result> {
		if (this._store.isDisposed || token.isCancellationRequested) {
			return Promise.resolve(failure('cancelled'));
		}
		// 前にメモリ不足で worker を落とした依頼（同じ文書・同じ組）は、もう一度落とさないよう、走らせずに断る。
		// 覚えている入力が無ければ、ハッシュは求めない（メモリ不足が起きた時点で求める）。
		if (this.outOfMemoryKeys.length > 0 && this.outOfMemoryKeys.includes(outOfMemoryKey(inputs))) {
			return Promise.resolve(failure('limitExceeded'));
		}
		// 混み合っているときは「混み合っている」と返す（しばらくしてから頼み直せば通る）。
		const bytes = inputs.reduce((total, input) => total + input.byteLength, 0);
		const queuedBytes = this.queue.reduce((total, request) => total + request.bytes, 0);
		if (this.queue.length >= PARADIS_WORD_SEMANTIC_QUEUE_LIMIT || (this.queue.length > 0 && queuedBytes + bytes > PARADIS_WORD_SEMANTIC_QUEUE_BYTES_LIMIT)) {
			return Promise.resolve(failure('busy'));
		}
		this.clearIdleTimer();
		return new Promise<Result>(resolve => {
			const request: IRequest = { id: this.nextId++, send, runDeadlineMs, bytes, inputs, resolve, token };
			request.cancellation = token.onCancellationRequested(() => this.cancel(request));
			this.queue.push(request);
			// 待ち行列の締め切り。走り始めたら張り替える。
			request.timer = this.timers.setTimeout(() => this.expireQueued(request), PARADIS_WORD_SEMANTIC_QUEUE_DEADLINE_MS);
			this.pump();
		});
	}

	/** 走っている依頼が無ければ、待ち行列の先頭を worker へ送る。 */
	private pump(): void {
		while (!this.running && this.queue.length > 0) {
			const request = this.queue.shift()!;
			this.clearTimer(request);
			const worker = this.ensureWorker();
			if (!worker) {
				this.settle(request, failure('failed'));
				continue;
			}
			try {
				request.send(worker, request.id);
			} catch {
				this.settle(request, failure('failed'));
				continue;
			}
			this.running = request;
			request.timer = this.timers.setTimeout(() => this.expireRunning(request), request.runDeadlineMs);
		}
		this.scheduleIdle();
	}

	private ensureWorker(): IParadisWordSemanticWorker | undefined {
		if (this.worker) {
			return this.worker;
		}
		let worker: IParadisWordSemanticWorker;
		try {
			worker = this.createWorker();
		} catch {
			// 起動できなかった。次の依頼でもう一度試す。
			return undefined;
		}
		this.worker = worker;
		let crash: unknown;
		worker.on('message', message => {
			if (this.worker !== worker || message.kind !== 'result' || this.running?.id !== message.id) {
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
	private lost(worker: IParadisWordSemanticWorker, error: unknown): void {
		if (this.worker !== worker) {
			return;
		}
		this.worker = undefined;
		void worker.terminate().catch(() => undefined);
		const request = this.running;
		this.running = undefined;
		if (request) {
			const outOfMemory = isOutOfMemory(error);
			if (outOfMemory) {
				this.outOfMemoryKeys.push(outOfMemoryKey(request.inputs));
				this.outOfMemoryKeys.splice(0, Math.max(0, this.outOfMemoryKeys.length - PARADIS_WORD_SEMANTIC_OOM_MEMORY));
			}
			this.settle(request, failure(outOfMemory ? 'limitExceeded' : 'failed'));
		}
		this.pump();
	}

	/** 実行の締め切りを過ぎた。worker を止めてこの依頼だけを失敗にし、待っている依頼は新しい worker で続ける。 */
	private expireRunning(request: IRequest): void {
		request.timer = undefined;
		if (this.running !== request) {
			return;
		}
		this.running = undefined;
		this.stopWorker();
		this.settle(request, failure('limitExceeded'));
		this.pump();
	}

	/** 待ち行列で待ちすぎた。worker は止めず、この依頼だけを走らせずに「混み合っている」と返す。 */
	private expireQueued(request: IRequest): void {
		request.timer = undefined;
		const index = this.queue.indexOf(request);
		if (index < 0) {
			return;
		}
		this.queue.splice(index, 1);
		this.settle(request, failure('busy'));
	}

	private cancel(request: IRequest): void {
		const index = this.queue.indexOf(request);
		if (index >= 0) {
			this.queue.splice(index, 1);
			this.settle(request, failure('cancelled'));
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

	private settle(request: IRequest, value: Result): void {
		this.clearTimer(request);
		request.cancellation?.dispose();
		request.resolve(value);
	}

	private clearTimer(request: IRequest): void {
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
		}, this.idleMs);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== undefined) {
			this.timers.clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}
