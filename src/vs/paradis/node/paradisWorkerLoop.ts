/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// worker_threads の worker の中で、依頼（`run`）と取り消し（`cancel`）を受けて返事をする共通の受け口。
// 待ち行列（shared process 側。fileViewers/node/office/paradisOfficeSemanticWorkerQueue.ts）と同じ形の
// メッセージを使う。worker の本体の入口（`…WorkerMain.ts`）はこれに解析の関数を渡すだけにする。
//
// これは入口ではなく、入口に取り込まれる部品。worker の起動は paradisWorker.ts の `createParadisWorker`
// （共通の入口）を通す。

import { CancellationTokenSource, type CancellationToken } from '../../base/common/cancellation.js';

/** 待ち行列 → worker のメッセージ。 */
export type ParadisWorkerLoopMessage<TRun> =
	| { readonly id: number; readonly op: 'run'; readonly request: TRun }
	| { readonly id: number; readonly op: 'cancel' };

/** worker → 待ち行列の返事。 */
export interface IParadisWorkerLoopReply<TResult> {
	readonly kind: 'result';
	readonly id: number;
	readonly result: TResult;
	/** 中で想定外の例外が出たときの、その種類。shared process が Sentry へ送るためだけに使う（文やパスは入れない）。 */
	readonly cause?: string;
}

/** 1 件の依頼を処理した結果。 */
export interface IParadisWorkerLoopOutcome<TResult> {
	readonly result: TResult;
	readonly cause?: string;
	/** 返事と一緒に移す（写さない）ArrayBuffer。 */
	readonly transfer?: readonly ArrayBuffer[];
}

/** worker の `parentPort` のうち、ここで使う部分。テストでは偽物を渡す。 */
export interface IParadisWorkerLoopPort {
	postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
	on(event: 'message', listener: (message: unknown) => void): unknown;
}

export interface IParadisWorkerLoopHandler<TRun, TResult> {
	/** `run` の中身が正しい形か。違えば走らせずに `invalid` を返す。 */
	readonly accepts: (request: unknown) => request is TRun;
	/** 1 件を処理する。`token` は待ち行列から取り消しが来たら取り消される。 */
	readonly run: (request: TRun, token: CancellationToken) => Promise<IParadisWorkerLoopOutcome<TResult>>;
	/** 形の正しくない依頼への返事。 */
	readonly invalid: TResult;
	/** `run` が投げたときの返事。 */
	readonly failed: TResult;
	/** `run` が投げた例外の種類（返事の `cause` に載せる）。 */
	readonly failureKind: (error: unknown) => string;
}

function messageId(message: unknown): number | undefined {
	const id = message && typeof message === 'object' ? (message as { readonly id?: unknown }).id : undefined;
	return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined;
}

/**
 * `port` で依頼を受け、`handler` で処理して返事をする。取り消しは、走っている依頼についてだけ覚える
 * （終わった依頼の取り消しを溜めない）。
 */
export function runParadisWorkerLoop<TRun, TResult>(port: IParadisWorkerLoopPort | null | undefined, handler: IParadisWorkerLoopHandler<TRun, TResult>): void {
	if (!port) {
		return;
	}
	const running = new Map<number, CancellationTokenSource>();
	const reply = (id: number, outcome: IParadisWorkerLoopOutcome<TResult>) => {
		const message: IParadisWorkerLoopReply<TResult> = { kind: 'result', id, result: outcome.result, ...(outcome.cause ? { cause: outcome.cause } : {}) };
		port.postMessage(message, outcome.transfer);
	};
	const handle = async (id: number, request: TRun) => {
		const cancellation = new CancellationTokenSource();
		running.set(id, cancellation);
		let outcome: IParadisWorkerLoopOutcome<TResult>;
		try {
			outcome = await handler.run(request, cancellation.token);
		} catch (error) {
			outcome = { result: handler.failed, cause: handler.failureKind(error) };
		} finally {
			running.delete(id);
			cancellation.dispose();
		}
		reply(id, outcome);
	};
	port.on('message', message => {
		const id = messageId(message);
		if (id === undefined) {
			return;
		}
		const { op, request } = message as { readonly op?: unknown; readonly request?: unknown };
		if (op === 'cancel') {
			running.get(id)?.cancel();
			return;
		}
		if (op !== 'run') {
			return;
		}
		if (handler.accepts(request)) {
			void handle(id, request);
		} else {
			reply(id, { result: handler.invalid });
		}
	});
}
