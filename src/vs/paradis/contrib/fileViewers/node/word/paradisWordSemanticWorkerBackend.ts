/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word の詳しい解析を worker（別スレッド）で走らせる。待ち行列の守り（1 件ずつ、実行と待ち行列で別の締め切り、
// 件数とバイト数の上限で `busy`、メモリ不足で落ちた入力の記録、しばらく依頼が無ければ worker を終了）は
// 共通の paradisOfficeSemanticWorkerQueue.ts にある。worker が使えないときも shared process の中では解析しない
// （表示は解析に頼っていないので、解析できないだけで済む）。

import { Worker } from 'worker_threads';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IParadisWordAnalysisResult, IParadisWordComparisonResult } from '../../common/word/paradisWordSemanticSummary.js';
import { ownedParadisOfficeBytes, ParadisOfficeSemanticWorkerQueue, type IParadisOfficeSemanticWorker, type IParadisOfficeSemanticWorkerTimers } from '../office/paradisOfficeSemanticWorkerQueue.js';
import type { IParadisWordSemanticBackend } from './paradisWordSemanticChannel.js';
import type { ParadisWordSemanticWorkerResult, ParadisWordSemanticWorkerRun } from './paradisWordSemanticWorkerProtocol.js';

/** 依頼が途絶えてから worker を終了させるまでの時間。 */
export const PARADIS_WORD_SEMANTIC_WORKER_IDLE_MS = 60_000;
/**
 * 実行の締め切り。内側の締め切り（部品一覧 30 秒＋解析 60 秒、比較は全体で 60 秒＋部品一覧 30 秒×2）が
 * 先に効くよう、それより長くしてある。内側で止まらなかったときだけ worker を止める。
 */
export const PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS = 120_000;
export const PARADIS_WORD_SEMANTIC_COMPARE_DEADLINE_MS = 150_000;
/** 待ち行列で待てる時間。過ぎた依頼は走らせずに `busy` で返す。 */
export const PARADIS_WORD_SEMANTIC_QUEUE_DEADLINE_MS = 60_000;
/** 待ち行列に置ける依頼の数（走っている 1 件は数えない）。 */
export const PARADIS_WORD_SEMANTIC_QUEUE_LIMIT = 8;
/** 待ち行列の依頼が掴んでいるバイト列の合計の上限。 */
export const PARADIS_WORD_SEMANTIC_QUEUE_BYTES_LIMIT = 96 * 1024 * 1024;
/** worker のヒープの上限。Office の worker（paradisOfficeWorkerHost.ts）と同じ値。 */
export const PARADIS_WORD_SEMANTIC_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 });

export type IParadisWordSemanticWorker = IParadisOfficeSemanticWorker<ParadisWordSemanticWorkerRun, ParadisWordSemanticWorkerResult>;

export class ParadisWordSemanticWorkerBackend extends Disposable implements IParadisWordSemanticBackend {

	private readonly queue: ParadisOfficeSemanticWorkerQueue<ParadisWordSemanticWorkerRun, ParadisWordSemanticWorkerResult>;

	constructor(
		createWorker: () => IParadisWordSemanticWorker,
		idleMs = PARADIS_WORD_SEMANTIC_WORKER_IDLE_MS,
		timers?: IParadisOfficeSemanticWorkerTimers,
	) {
		super();
		this.queue = this._register(new ParadisOfficeSemanticWorkerQueue<ParadisWordSemanticWorkerRun, ParadisWordSemanticWorkerResult>({
			createWorker,
			failure: code => ({ ok: false, code }),
			runDeadlineMs: PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS,
			queueDeadlineMs: PARADIS_WORD_SEMANTIC_QUEUE_DEADLINE_MS,
			queueLimit: PARADIS_WORD_SEMANTIC_QUEUE_LIMIT,
			queueByteLimit: PARADIS_WORD_SEMANTIC_QUEUE_BYTES_LIMIT,
			idleMs,
			timers,
		}));
	}

	/** 本物の worker_threads の Worker を作る関数。`workerPath` は worker 入口の .js の絶対パス。 */
	static workerFactory(workerPath: string): () => IParadisWordSemanticWorker {
		return () => new Worker(workerPath, { resourceLimits: PARADIS_WORD_SEMANTIC_WORKER_RESOURCE_LIMITS }) as unknown as IParadisWordSemanticWorker;
	}

	get workerRunning(): boolean {
		return this.queue.workerRunning;
	}

	analyze(bytes: Uint8Array, token: CancellationToken): Promise<IParadisWordAnalysisResult> {
		return this.queue.run(bytes.byteLength, () => {
			const copy = ownedParadisOfficeBytes(bytes);
			return { request: { op: 'analyze', bytes: copy }, transfer: [copy.buffer as ArrayBuffer] };
		}, token, { runDeadlineMs: PARADIS_WORD_SEMANTIC_ANALYZE_DEADLINE_MS, memoryKeys: [bytes] }) as Promise<IParadisWordAnalysisResult>;
	}

	compare(original: Uint8Array, modified: Uint8Array, token: CancellationToken): Promise<IParadisWordComparisonResult> {
		return this.queue.run(original.byteLength + modified.byteLength, () => {
			const left = ownedParadisOfficeBytes(original);
			const right = ownedParadisOfficeBytes(modified);
			return { request: { op: 'compare', original: left, modified: right }, transfer: [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer] };
		}, token, { runDeadlineMs: PARADIS_WORD_SEMANTIC_COMPARE_DEADLINE_MS, memoryKeys: [original, modified] }) as Promise<IParadisWordComparisonResult>;
	}
}
