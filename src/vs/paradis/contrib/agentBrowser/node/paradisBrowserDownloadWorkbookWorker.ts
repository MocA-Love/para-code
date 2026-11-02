/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// read_download の xlsx を、shared process の本線ではなく worker（別スレッド）で読む。50 MB・展開後 200 MB までの
// ブックの解析は数秒から数十秒かかり、本線で走らせると、その間すべてのペインの MCP の呼び出しが待たされるため。
// worker は共通の入口（src/vs/paradis/node/paradisWorker.ts）から起こす。素の `new Worker` や `eval: true` では、
// パッケージ版で worker の中から `node_modules.asar` の exceljs を解決できない（Excel の EMF/WMF の worker と同じ）。
// 呼び出しごとに起こして、終わったら止める（read_download はたまにしか呼ばれないので、常駐させない）。

import { FileAccess } from '../../../../base/common/network.js';
import { createParadisWorker } from '../../../node/paradisWorker.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import type { IParadisDownloadWorkbookRequest } from './paradisBrowserDownloadReader.js';

/** worker の本体の入口（`out` からの相対）。`build/next/index.ts` の入口一覧に載せてある。 */
const WORKER_ENTRY = 'vs/paradis/contrib/agentBrowser/node/paradisBrowserDownloadWorkbookWorkerMain.js';

/** 1 回の解析の上限。過ぎたら worker を止めて断る。 */
export const PARADIS_DOWNLOAD_WORKBOOK_TIMEOUT_MS = 90_000;

/** worker のヒープの上限。展開後 200 MB のブックを exceljs が読めるだけの大きさにし、超えたら worker だけが落ちる。 */
const WORKER_MAX_OLD_GENERATION_MB = 1536;

/** worker から返る答え。`result` は read_download の結果そのもの。`stage` は失敗した段（exceljs を読む・ブックを文字にする）。 */
export type ParadisDownloadWorkbookReply =
	| { readonly kind: 'result'; readonly result: unknown }
	| { readonly kind: 'failed'; readonly stage: 'load' | 'render'; readonly cause: string };

/** 起こした worker のうち、ここで使うところ（テストで差し替える）。 */
export interface IParadisDownloadWorkbookWorker {
	readonly terminateRequested: boolean;
	once(event: 'message', listener: (reply: ParadisDownloadWorkbookReply) => void): unknown;
	once(event: 'error', listener: (error: unknown) => void): unknown;
	once(event: 'exit', listener: (code: number) => void): unknown;
	postMessage(value: unknown, transferList: readonly ArrayBuffer[]): void;
	terminate(): Promise<number>;
}

export interface IParadisDownloadWorkbookRunOptions {
	/** この時刻（ミリ秒）までに終わらなければ止める。待ち行列で待った時間も含めた期限。無ければ起こしてから 90 秒。 */
	readonly deadline?: number;
	/** 呼び出し側が諦めたら、起こす前なら起こさず、走っていれば止める。 */
	readonly signal?: AbortSignal;
	/** worker を起こす（テストで差し替える）。 */
	readonly createWorker?: () => IParadisDownloadWorkbookWorker;
	/** 失敗を Sentry へ送る（テストで差し替える）。 */
	readonly report?: (error: unknown, extra: { readonly stage: string }) => void;
	readonly now?: () => number;
}

function failure(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

function createWorker(): IParadisDownloadWorkbookWorker {
	return createParadisWorker(FileAccess.asFileUri(WORKER_ENTRY).fsPath, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB }, stdout: true, stderr: true }) as unknown as IParadisDownloadWorkbookWorker;
}

function report(error: unknown, extra: { readonly stage: string }): void {
	reportParadisDiagnosticError('owned', 'agent-browser', 'read-download-workbook-worker', error, extra);
}

/**
 * xlsx を worker で読み、read_download の結果を返す。worker が起きない・落ちた・時間切れ・取り消しのときも結果（失敗）で返す。
 * Sentry へ送るのは、こちらの不具合でありうるもの（起きない・読み込めない・文字にできない・答えずに終わった・時間切れ）だけ。
 * メモリ切れ（大きすぎるブック）と、答えを受け取った後・こちらから止めた後の終了は送らない。
 */
export async function paradisReadDownloadWorkbookInWorker(request: IParadisDownloadWorkbookRequest, options: IParadisDownloadWorkbookRunOptions = {}): Promise<unknown> {
	const now = options.now ?? Date.now;
	const send = options.report ?? report;
	if (options.signal?.aborted) {
		return failure(`Reading ${request.name} was cancelled.`);
	}
	const remaining = Math.min(PARADIS_DOWNLOAD_WORKBOOK_TIMEOUT_MS, (options.deadline ?? Number.POSITIVE_INFINITY) - now());
	if (remaining <= 0) {
		return failure(`Para Code is busy reading other Excel files, and ${request.name} waited too long. Call read_download again.`);
	}
	// worker へ渡す（transfer する）ので、呼び出し元の Buffer とは別の領域に写す
	const data = new Uint8Array(request.data.byteLength);
	data.set(request.data);
	let worker: IParadisDownloadWorkbookWorker;
	try {
		worker = (options.createWorker ?? createWorker)();
	} catch (error) {
		send(error, { stage: 'create' });
		return failure(`${request.name} could not be read: Para Code could not start the Excel reader.`);
	}
	const started = worker;
	let settled = false;
	const disposables: (() => void)[] = [];
	try {
		return await new Promise<unknown>(resolve => {
			const settle = (result: unknown) => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
			};
			const timer = setTimeout(() => {
				send(new Error(`timed out after ${Math.round(remaining)} ms`), { stage: 'timeout' });
				settle(failure(`Reading ${request.name} took too long and was stopped. Save a smaller part of the data (for example one sheet as csv) and read that.`));
			}, remaining);
			disposables.push(() => clearTimeout(timer));
			const onAbort = () => settle(failure(`Reading ${request.name} was cancelled.`));
			options.signal?.addEventListener('abort', onAbort, { once: true });
			disposables.push(() => options.signal?.removeEventListener('abort', onAbort));
			started.once('message', reply => {
				if (reply?.kind === 'result') {
					settle(reply.result);
					return;
				}
				const stage = reply?.kind === 'failed' && reply.stage === 'render' ? 'render' : 'load';
				send(new Error(typeof reply?.cause === 'string' ? reply.cause : 'unknown'), { stage });
				settle(failure(stage === 'render' ? `${request.name} could not be read: the Excel reader failed while reading it.` : `${request.name} could not be read: the Excel reader failed to load.`));
			});
			started.once('error', error => {
				const outOfMemory = (error as { code?: unknown } | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY';
				if (!outOfMemory && !settled) {
					send(error, { stage: 'run' });
				}
				settle(failure(outOfMemory ? `${request.name} is too large to read as a whole. Save a smaller part of the data (for example one sheet as csv) and read that.` : `${request.name} could not be read: the Excel reader stopped.`));
			});
			started.once('exit', code => {
				// 答えた後・メモリ切れ・こちらから止めた後の終了は、知らせることが無い
				if (!settled && !started.terminateRequested) {
					send(new Error(`exit ${code}`), { stage: 'exit' });
				}
				settle(failure(`${request.name} could not be read: the Excel reader stopped (exit code ${code}).`));
			});
			started.postMessage({ ...request, data }, [data.buffer as ArrayBuffer]);
		});
	} finally {
		for (const dispose of disposables) {
			dispose();
		}
		await started.terminate().catch(() => undefined);
	}
}
