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
// Excel のエディタを開いた・戻したときに worker を起動して exceljs と jszip を読み込ませ
// （{@link ParadisSpreadsheetParseWorkerBackend.warm}）、ファイルの読み出しと並べて読み込みの待ちを隠す。

import { promises as fs } from 'fs';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ownedParadisOfficeBytes, ParadisOfficeSemanticWorkerQueue, type IParadisOfficeSemanticWorker, type IParadisOfficeSemanticWorkerTimers, type ParadisOfficeSemanticWorkerFailure } from '../office/paradisOfficeSemanticWorkerQueue.js';
import { createParadisOfficeSemanticWorker, reportParadisOfficeWorkerFailure } from '../office/paradisOfficeWorkerDiagnostics.js';

/** worker へ送る依頼。`bytes` が無ければ、読み込みだけをする（温める）。 */
export interface IParadisSpreadsheetParseWorkerRun {
	readonly bytes?: Uint8Array;
	readonly imagePixelBudget?: number;
}

/**
 * worker の返事。ブックは書式を表にまとめた形の JSON のバイト列（`encodeParadisWorkbookJson`）。
 * 解析の例外は文言だけを持ち帰る（ビューアがそのまま画面に出す）。
 */
export type ParadisSpreadsheetParseWorkerResult =
	| { readonly kind: 'workbookJson'; readonly json: Uint8Array }
	| { readonly kind: 'warm' }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'unavailable'; readonly reason: ParadisOfficeSemanticWorkerFailure; /** 待ち行列で待ちすぎた `busy`（すぐに断ったのではない）。 */ readonly expired?: true };

/**
 * 解析が投げた例外を、worker の返事にする。V8 の文字列の上限を超えた（シートの XML などが大きすぎて
 * `Invalid string length` になった）ときは、ヒープの上限・締め切りと同じく大きすぎるブックとして断る
 * （ビューアは「ブックが大きすぎるため…」と出す）。それ以外は文言を持ち帰る（ビューアがそのまま画面に出す）。
 */
export function paradisSpreadsheetParseErrorResult(error: unknown): ParadisSpreadsheetParseWorkerResult {
	if (error instanceof RangeError && error.message === 'Invalid string length') {
		return { kind: 'unavailable', reason: 'limitExceeded' };
	}
	return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
}

export type IParadisSpreadsheetParseWorker = IParadisOfficeSemanticWorker<IParadisSpreadsheetParseWorkerRun, ParadisSpreadsheetParseWorkerResult>;

/**
 * 依頼が途絶えてから worker を終了させるまでの時間。Excel のエディタを開く・戻すたびに温める依頼が来て延びる。
 * 大きなブックの後は worker のヒープが大きく残るので、ほかの worker より長いが 30 分までは持たない。
 * Excel を開かない人には worker を起動しない。
 */
export const PARADIS_SPREADSHEET_PARSE_WORKER_IDLE_MS = 5 * 60 * 1000;
/**
 * 実行の締め切り。返ってこない worker を止めるためのもの。実ファイルでいちばん重いブックでも 12 秒ほど。
 * 過ぎたら（worker のヒープの上限を超えたときと同じく）大きすぎるブックとして断る。
 */
export const PARADIS_SPREADSHEET_PARSE_RUN_DEADLINE_MS = 10 * 60 * 1000;
/** 待ち行列で待てる時間。過ぎたら 1 回だけ待ち行列へ入れ直し、それでも待ちすぎたら混んでいるとして断る（本体では解析しない）。 */
export const PARADIS_SPREADSHEET_PARSE_QUEUE_DEADLINE_MS = 120_000;
/** 待ち行列に置ける依頼の数（走っている 1 件は数えない）。 */
export const PARADIS_SPREADSHEET_PARSE_QUEUE_LIMIT = 8;
/** 待ち行列に置ける依頼のバイト数の合計。ビューアが読む上限（20 MiB）の 4 件ぶん。 */
export const PARADIS_SPREADSHEET_PARSE_QUEUE_BYTES = 80 * 1024 * 1024;
/**
 * worker のヒープの上限。詳しい解析の worker（384 MB）より大きくとる。超えたら大きすぎるブックとして断る
 * （shared process 本体で上限なしに解析し直すと、本体のメモリを使い切るおそれがあるため）。
 */
export const PARADIS_SPREADSHEET_PARSE_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 3072, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 });

export class ParadisSpreadsheetParseWorkerBackend extends Disposable {

	private readonly queue: ParadisOfficeSemanticWorkerQueue<IParadisSpreadsheetParseWorkerRun, ParadisSpreadsheetParseWorkerResult>;
	/** 走っている・待ち行列にある温める依頼。 */
	private warming: Promise<ParadisSpreadsheetParseWorkerResult> | undefined;

	constructor(
		createWorker: () => IParadisSpreadsheetParseWorker,
		timers?: IParadisOfficeSemanticWorkerTimers,
		/** 失敗の報告の送り先（テストで差し替える）。 */
		reportFailure: typeof reportParadisOfficeWorkerFailure = reportParadisOfficeWorkerFailure,
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
			// 締め切りで切れたのは、ヒープの上限で落ちた（大きいだけのブック）のと違って worker が返ってこなかったので、
			// こちらの不具合の疑いとして送る。利用者には同じく大きすぎるブックとして断る。
			onRunDeadline: () => reportFailure('spreadsheet-parse', 'deadline', 'run-deadline'),
			queueExpired: () => ({ kind: 'unavailable', reason: 'busy', expired: true }),
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
		// 共通の入口から起こす（パッケージ版で exceljs・jszip を node_modules.asar から読めるように）。起動・読み込みの失敗は Sentry へ送る。
		return () => createParadisOfficeSemanticWorker('spreadsheet-parse', workerPath, PARADIS_SPREADSHEET_PARSE_WORKER_RESOURCE_LIMITS);
	}

	async parse(bytes: Uint8Array, imagePixelBudget: number | undefined, token: CancellationToken): Promise<ParadisSpreadsheetParseWorkerResult> {
		const first = await this.enqueueParse(bytes, imagePixelBudget, token);
		// 待ち行列で待ちすぎたものは、前の重い解析が終わって空いていることがあるので 1 回だけ入れ直す。
		// すぐに断った `busy`（待ち行列が埋まっていた）は入れ直さない
		if (first.kind === 'unavailable' && first.reason === 'busy' && first.expired && !token.isCancellationRequested) {
			const second = await this.enqueueParse(bytes, imagePixelBudget, token);
			return second.kind === 'unavailable' && second.expired ? { kind: 'unavailable', reason: 'busy' } : second;
		}
		return first.kind === 'unavailable' && first.expired ? { kind: 'unavailable', reason: 'busy' } : first;
	}

	private enqueueParse(bytes: Uint8Array, imagePixelBudget: number | undefined, token: CancellationToken): Promise<ParadisSpreadsheetParseWorkerResult> {
		return this.queue.run(bytes.byteLength, () => {
			// 写してから移す。元のバイト列はメモリ不足の記録の鍵に使い、`Buffer` の共有の領域を移してしまうこともない。
			const copy = ownedParadisOfficeBytes(bytes);
			return { request: { bytes: copy, ...(imagePixelBudget !== undefined ? { imagePixelBudget } : {}) }, transfer: [copy.buffer as ArrayBuffer] };
		}, token, { memoryKeys: [bytes] });
	}

	/**
	 * worker を起動し、exceljs と jszip を読み込ませておく。worker が既に動いている、または温める依頼が走っている・
	 * 待っているときは積まない（タブを素早く行き来して待ち行列を埋め、続く解析が `busy` で断られないように）。
	 */
	warm(token: CancellationToken): Promise<ParadisSpreadsheetParseWorkerResult> {
		if (this.warming) {
			return this.warming;
		}
		if (this.queue.workerRunning) {
			return Promise.resolve({ kind: 'warm' });
		}
		const warming = this.warming = this.queue.run(0, () => ({ request: {}, transfer: [] }), token).finally(() => {
			if (this.warming === warming) {
				this.warming = undefined;
			}
		});
		return warming;
	}
}
