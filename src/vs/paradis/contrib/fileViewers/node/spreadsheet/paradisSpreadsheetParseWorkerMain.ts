/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のブックの解析（表示用）を行う worker（別スレッド）の入口。shared process から `worker_threads` で起動される。
// 解析の中身は shared process 本体で走っていたときと同じ `ParadisSpreadsheetService`。返す前にセルの書式を
// 表にまとめ、shared process へ写す量を減らす。
// パッケージ版でもこの場所へ出力されるよう、`build/next/index.ts` の入口一覧に載せてある。

import { parentPort } from 'worker_threads';
import type { ParadisOfficeSemanticWorkerMessage } from '../office/paradisOfficeSemanticWorkerQueue.js';
import { paradisOfficeWorkerFailureKind } from '../office/paradisOfficeWorkerDiagnostics.js';
import { packParadisWorkbookStyles } from '../../common/spreadsheet/paradisSpreadsheetStyleTable.js';
import { ParadisSpreadsheetService } from '../paradisSpreadsheetService.js';
import type { IParadisSpreadsheetParseWorkerRun, ParadisSpreadsheetParseWorkerResult } from './paradisSpreadsheetParseWorkerBackend.js';

const service = new ParadisSpreadsheetService();

async function handle(id: number, request: IParadisSpreadsheetParseWorkerRun): Promise<void> {
	let result: ParadisSpreadsheetParseWorkerResult;
	// 想定外の例外の種類。返事に載せて、shared process が Sentry へ送る。
	let cause: string | undefined;
	try {
		if (request.bytes) {
			const source = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
			const budget = typeof request.imagePixelBudget === 'number' ? request.imagePixelBudget : undefined;
			result = { kind: 'workbook', workbook: packParadisWorkbookStyles(await service.parseWorkbookBytes(source, budget)) };
		} else {
			await service.warm();
			result = { kind: 'warm' };
		}
	} catch (error) {
		result = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
		// 壊れた・対応していないブックで exceljs・jszip が投げるのは素の Error で、利用者のファイルの問題なので送らない。
		// TypeError など、それ以外の例外はこちらの不具合の疑いがあるので種類だけ送る。
		// この判定のため、worker の中で自前の `new Error(...)` を投げると Sentry には送られない（送りたい失敗は別の型で投げる）。
		if (!(error instanceof Error) || error.constructor !== Error) {
			cause = paradisOfficeWorkerFailureKind(error);
		}
	}
	parentPort?.postMessage({ kind: 'result', id, result, ...(cause ? { cause } : {}) });
}

// 解析は途中で止められないので、取り消しの知らせは受け流す（待ち行列の側で依頼を外す）。
parentPort?.on('message', (message: ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetParseWorkerRun>) => {
	if (message.op !== 'run') {
		return;
	}
	const request = message.request;
	if (request && (request.bytes === undefined || request.bytes instanceof Uint8Array)) {
		void handle(message.id, request);
	} else {
		parentPort?.postMessage({ kind: 'result', id: message.id, result: { kind: 'unavailable', reason: 'failed' } });
	}
});
