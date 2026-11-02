/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// read_download の xlsx を読む worker の本体の入口。shared process から共通の入口（paradisWorkerBootstrap.ts）を通して
// 起こされる（paradisBrowserDownloadWorkbookWorker.ts）。依頼を 1 つ受けて答えを 1 つ返す。exceljs は共通の入口が
// asar の解決を登録した後に、ここで動的に読む。パッケージ版でもこの場所へ出力されるよう、`build/next/index.ts` の入口一覧に載せてある。

import { parentPort } from 'worker_threads';
import { paradisRenderDownloadWorkbook, type IParadisDownloadWorkbookRequest } from './paradisBrowserDownloadReader.js';
import type { ParadisDownloadWorkbookReply } from './paradisBrowserDownloadWorkbookWorker.js';

parentPort?.once('message', async (request: IParadisDownloadWorkbookRequest) => {
	let reply: ParadisDownloadWorkbookReply;
	try {
		const Excel = (await import('exceljs')).default;
		reply = { kind: 'result', result: await paradisRenderDownloadWorkbook(Excel, request) };
	} catch (error) {
		const code = (error as { code?: unknown } | undefined)?.code;
		reply = { kind: 'failed', cause: typeof code === 'string' ? code : error instanceof Error ? error.name : typeof error };
	}
	parentPort?.postMessage(reply);
});
