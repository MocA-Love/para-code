/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の EMF・WMF の変換を worker で走らせる。待ち行列の守り（1 件ずつ・実行と待ち行列の締め切り・OOM の記録）は
// paradisOfficeSemanticWorkerQueue.ts にある。worker が使えないときも shared process の中では変換しない
// （EMF・WMF は代替表示の箱のままになるだけ）。

import { Worker } from 'worker_threads';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IParadisSpreadsheetMetafileImages } from '../../common/paradisSpreadsheet.js';
import { ownedParadisOfficeBytes, ParadisOfficeSemanticWorkerQueue, type IParadisOfficeSemanticWorker, type IParadisOfficeSemanticWorkerTimers } from '../office/paradisOfficeSemanticWorkerQueue.js';
import { PARADIS_SPREADSHEET_METAFILE_MILLISECONDS } from './paradisSpreadsheetMetafiles.js';

/** worker へ送る依頼の中身。 */
export interface IParadisSpreadsheetMetafileWorkerRun {
	readonly bytes: Uint8Array;
}

export type IParadisSpreadsheetMetafileWorker = IParadisOfficeSemanticWorker<IParadisSpreadsheetMetafileWorkerRun, IParadisSpreadsheetMetafileImages>;

/** 依頼が途絶えてから worker を終了させるまでの時間。 */
export const PARADIS_SPREADSHEET_METAFILE_WORKER_IDLE_MS = 60_000;
/**
 * 実行の締め切り。worker の中では変換を 10 秒で打ち切るが、記録 1 件の中の処理は止められないので、
 * ブックの展開の分も見込んだこの締め切りで worker ごと止める。
 */
export const PARADIS_SPREADSHEET_METAFILE_RUN_DEADLINE_MS = PARADIS_SPREADSHEET_METAFILE_MILLISECONDS + 10_000;
/** 待ち行列で待てる時間。過ぎた依頼は走らせずに `busy` で返す。 */
export const PARADIS_SPREADSHEET_METAFILE_QUEUE_DEADLINE_MS = 30_000;
/** 待ち行列に置ける依頼の数（走っている 1 件は数えない）。 */
export const PARADIS_SPREADSHEET_METAFILE_QUEUE_LIMIT = 8;
/** 待ち行列に置ける依頼のバイト数の合計。ビューアが読む上限（20 MiB）の 3 件ぶん。 */
export const PARADIS_SPREADSHEET_METAFILE_QUEUE_BYTES = 60 * 1024 * 1024;
/** worker のヒープの上限。Office・Word・Excel の解析の worker と同じ値。 */
export const PARADIS_SPREADSHEET_METAFILE_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 });

export class ParadisSpreadsheetMetafileWorkerBackend extends Disposable {

	private readonly queue: ParadisOfficeSemanticWorkerQueue<IParadisSpreadsheetMetafileWorkerRun, IParadisSpreadsheetMetafileImages>;

	constructor(
		createWorker: () => IParadisSpreadsheetMetafileWorker,
		timers?: IParadisOfficeSemanticWorkerTimers,
	) {
		super();
		this.queue = this._register(new ParadisOfficeSemanticWorkerQueue({
			createWorker,
			failure: code => ({ images: {}, unavailableReason: code }),
			runDeadlineMs: PARADIS_SPREADSHEET_METAFILE_RUN_DEADLINE_MS,
			queueDeadlineMs: PARADIS_SPREADSHEET_METAFILE_QUEUE_DEADLINE_MS,
			queueLimit: PARADIS_SPREADSHEET_METAFILE_QUEUE_LIMIT,
			queueByteLimit: PARADIS_SPREADSHEET_METAFILE_QUEUE_BYTES,
			idleMs: PARADIS_SPREADSHEET_METAFILE_WORKER_IDLE_MS,
			timers,
		}));
	}

	/** 本物の worker_threads の Worker を作る関数。`workerPath` は worker 入口の .js の絶対パス。 */
	static workerFactory(workerPath: string): () => IParadisSpreadsheetMetafileWorker {
		return () => new Worker(workerPath, { resourceLimits: PARADIS_SPREADSHEET_METAFILE_WORKER_RESOURCE_LIMITS }) as unknown as IParadisSpreadsheetMetafileWorker;
	}

	convert(bytes: Uint8Array, token: CancellationToken): Promise<IParadisSpreadsheetMetafileImages> {
		return this.queue.run(bytes.byteLength, () => {
			const copy = ownedParadisOfficeBytes(bytes);
			return { request: { bytes: copy }, transfer: [copy.buffer as ArrayBuffer] };
		}, token, { memoryKeys: [bytes] });
	}
}
