/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のブックの解析（表示用、exceljs）を worker で走らせる。
//
// 解析は大きなブックで 10 秒ほど shared process 本体を止め、その間は Word の配信先の登録や拡張機能など、
// ほかのチャネルの応答も待たされていた。worker（別スレッド）で走らせ、本体は受け渡しだけをする。
// 待ち行列の守り（1 件ずつ・締め切り・メモリ不足の記録）は paradisOfficeSemanticWorkerQueue.ts にある。
// worker は起動して少し後に exceljs と jszip を読み込んでおき（{@link ParadisSpreadsheetParseWorkerBackend.warm}）、
// 最初のブックを開くときの読み込みの待ち（実測 320〜458 ms）を表示の前から外す。

import { promises as fs } from 'fs';
import { Worker } from 'worker_threads';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IParadisPackedWorkbookData } from '../../common/spreadsheet/paradisSpreadsheetStyleTable.js';
import { ownedParadisOfficeBytes, ParadisOfficeSemanticWorkerQueue, type IParadisOfficeSemanticWorker, type IParadisOfficeSemanticWorkerTimers, type ParadisOfficeSemanticWorkerFailure } from '../office/paradisOfficeSemanticWorkerQueue.js';

/** worker へ送る依頼。`bytes` が無ければ、読み込みだけをする（温める）。 */
export interface IParadisSpreadsheetParseWorkerRun {
	readonly bytes?: Uint8Array;
	readonly imagePixelBudget?: number;
}

/** worker の返事。解析の例外は文言だけを持ち帰る（ビューアがそのまま画面に出す）。 */
export type ParadisSpreadsheetParseWorkerResult =
	| { readonly kind: 'workbook'; readonly workbook: IParadisPackedWorkbookData }
	| { readonly kind: 'warm' }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'unavailable'; readonly reason: ParadisOfficeSemanticWorkerFailure };

export type IParadisSpreadsheetParseWorker = IParadisOfficeSemanticWorker<IParadisSpreadsheetParseWorkerRun, ParadisSpreadsheetParseWorkerResult>;

/**
 * 依頼が途絶えてから worker を終了させるまでの時間。温めた worker を、ブックを開くあいだは持っておく。
 * 終了した後は、次のブックを開くときにもう一度起動する（そのときは読み込みの待ちがある）。
 */
export const PARADIS_SPREADSHEET_PARSE_WORKER_IDLE_MS = 30 * 60 * 1000;
/** 実行の締め切り。実ファイルでいちばん重いブックでも 12 秒ほどなので、十分に長くとる。 */
export const PARADIS_SPREADSHEET_PARSE_RUN_DEADLINE_MS = 120_000;
/** 待ち行列で待てる時間。表示を待っている依頼なので、実行の締め切りと同じだけ待つ。 */
export const PARADIS_SPREADSHEET_PARSE_QUEUE_DEADLINE_MS = 120_000;
/** 待ち行列に置ける依頼の数（走っている 1 件は数えない）。 */
export const PARADIS_SPREADSHEET_PARSE_QUEUE_LIMIT = 8;
/** 待ち行列に置ける依頼のバイト数の合計。ビューアが読む上限（20 MiB）の 4 件ぶん。 */
export const PARADIS_SPREADSHEET_PARSE_QUEUE_BYTES = 80 * 1024 * 1024;
/**
 * worker のヒープの上限。解析は shared process 本体で走っていたときと同じだけのブックを開ける必要があるので、
 * 詳しい解析の worker（384 MB）より大きくとる。
 */
export const PARADIS_SPREADSHEET_PARSE_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 3072, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 });

export class ParadisSpreadsheetParseWorkerBackend extends Disposable {

	private readonly queue: ParadisOfficeSemanticWorkerQueue<IParadisSpreadsheetParseWorkerRun, ParadisSpreadsheetParseWorkerResult>;

	constructor(
		createWorker: () => IParadisSpreadsheetParseWorker,
		timers?: IParadisOfficeSemanticWorkerTimers,
	) {
		super();
		this.queue = this._register(new ParadisOfficeSemanticWorkerQueue({
			createWorker,
			failure: reason => ({ kind: 'unavailable', reason }),
			runDeadlineMs: PARADIS_SPREADSHEET_PARSE_RUN_DEADLINE_MS,
			queueDeadlineMs: PARADIS_SPREADSHEET_PARSE_QUEUE_DEADLINE_MS,
			queueLimit: PARADIS_SPREADSHEET_PARSE_QUEUE_LIMIT,
			queueByteLimit: PARADIS_SPREADSHEET_PARSE_QUEUE_BYTES,
			idleMs: PARADIS_SPREADSHEET_PARSE_WORKER_IDLE_MS,
			timers,
		}));
	}

	/**
	 * 本物の worker_threads の Worker を作る関数。`workerPath` は worker 入口の .js の絶対パス。
	 * 入口が無い（worker を同梱していない環境）なら `undefined`。そのときは呼び出し側が本体で解析する。
	 */
	static async workerFactory(workerPath: string): Promise<(() => IParadisSpreadsheetParseWorker) | undefined> {
		try {
			await fs.access(workerPath);
		} catch {
			return undefined;
		}
		return () => new Worker(workerPath, { resourceLimits: PARADIS_SPREADSHEET_PARSE_WORKER_RESOURCE_LIMITS }) as unknown as IParadisSpreadsheetParseWorker;
	}

	parse(bytes: Uint8Array, imagePixelBudget: number | undefined, token: CancellationToken): Promise<ParadisSpreadsheetParseWorkerResult> {
		return this.queue.run(bytes.byteLength, () => {
			// 写してから移す。元のバイト列はメモリ不足の記録の鍵に使い、`Buffer` の共有の領域を移してしまうこともない。
			const copy = ownedParadisOfficeBytes(bytes);
			return { request: { bytes: copy, ...(imagePixelBudget !== undefined ? { imagePixelBudget } : {}) }, transfer: [copy.buffer as ArrayBuffer] };
		}, token, { memoryKeys: [bytes] });
	}

	/** worker を起動し、exceljs と jszip を読み込ませておく。 */
	warm(token: CancellationToken): Promise<ParadisSpreadsheetParseWorkerResult> {
		return this.queue.run(0, () => ({ request: {}, transfer: [] }), token);
	}
}
