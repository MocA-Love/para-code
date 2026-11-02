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

/** worker から返る答え。`result` は read_download の結果そのもの。 */
export type ParadisDownloadWorkbookReply = { readonly kind: 'result'; readonly result: unknown } | { readonly kind: 'failed'; readonly cause: string };

function failure(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

/** xlsx を worker で読み、read_download の結果を返す。worker が起きない・落ちた・時間切れのときも結果（失敗）で返す。 */
export async function paradisReadDownloadWorkbookInWorker(request: IParadisDownloadWorkbookRequest): Promise<unknown> {
	// worker へ渡す（transfer する）ので、呼び出し元の Buffer とは別の領域に写す
	const data = new Uint8Array(request.data.byteLength);
	data.set(request.data);
	let worker;
	try {
		worker = createParadisWorker(FileAccess.asFileUri(WORKER_ENTRY).fsPath, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB }, stdout: true, stderr: true });
	} catch (error) {
		reportParadisDiagnosticError('owned', 'agent-browser', 'read-download-workbook-worker', error, { stage: 'create' });
		return failure(`${request.name} could not be read: Para Code could not start the Excel reader.`);
	}
	const started = worker;
	try {
		return await new Promise<unknown>(resolve => {
			const timer = setTimeout(() => resolve(failure(`Reading ${request.name} took longer than ${PARADIS_DOWNLOAD_WORKBOOK_TIMEOUT_MS / 1000} seconds and was stopped. Save a smaller part of the data (for example one sheet as csv) and read that.`)), PARADIS_DOWNLOAD_WORKBOOK_TIMEOUT_MS);
			const settle = (result: unknown) => {
				clearTimeout(timer);
				resolve(result);
			};
			started.once('message', (reply: ParadisDownloadWorkbookReply) => {
				if (reply?.kind === 'result') {
					settle(reply.result);
				} else {
					reportParadisDiagnosticError('owned', 'agent-browser', 'read-download-workbook-worker', new Error(typeof reply?.cause === 'string' ? reply.cause : 'unknown'), { stage: 'load' });
					settle(failure(`${request.name} could not be read: the Excel reader failed to load.`));
				}
			});
			started.once('error', error => {
				const outOfMemory = (error as { code?: unknown })?.code === 'ERR_WORKER_OUT_OF_MEMORY';
				if (!outOfMemory) {
					reportParadisDiagnosticError('owned', 'agent-browser', 'read-download-workbook-worker', error, { stage: 'run' });
				}
				settle(failure(outOfMemory ? `${request.name} is too large to read as a whole. Save a smaller part of the data (for example one sheet as csv) and read that.` : `${request.name} could not be read: the Excel reader stopped.`));
			});
			started.once('exit', code => {
				if (!started.terminateRequested) {
					reportParadisDiagnosticError('owned', 'agent-browser', 'read-download-workbook-worker', new Error(`exit ${code}`), { stage: 'exit' });
				}
				settle(failure(`${request.name} could not be read: the Excel reader stopped (exit code ${code}).`));
			});
			started.postMessage({ ...request, data }, [data.buffer as ArrayBuffer]);
		});
	} finally {
		await started.terminate().catch(() => undefined);
	}
}
