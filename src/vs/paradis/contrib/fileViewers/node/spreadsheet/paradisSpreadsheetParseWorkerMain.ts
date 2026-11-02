/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のブックの解析（表示用）を行う worker（別スレッド）の入口。shared process から `worker_threads` で起動される。
// 解析の中身は shared process 本体で走っていたときと同じ `ParadisSpreadsheetService`。返す前にセルの書式を
// 表にまとめ、JSON のバイト列にして移す（shared process 本体で写し直しや文字列化をしない）。
// パッケージ版でもこの場所へ出力されるよう、`build/next/index.ts` の入口一覧に載せてある。

import { parentPort } from 'worker_threads';
import { runParadisWorkerLoop } from '../../../../node/paradisWorkerLoop.js';
import { paradisOfficeWorkerFailureKind } from '../office/paradisOfficeWorkerDiagnostics.js';
import { encodeParadisWorkbookJson, packParadisWorkbookStyles } from '../../common/spreadsheet/paradisSpreadsheetStyleTable.js';
import { ParadisSpreadsheetService } from '../paradisSpreadsheetService.js';
import type { IParadisSpreadsheetParseWorkerRun, ParadisSpreadsheetParseWorkerResult } from './paradisSpreadsheetParseWorkerBackend.js';

const service = new ParadisSpreadsheetService();

function isParseRun(request: unknown): request is IParadisSpreadsheetParseWorkerRun {
	if (!request || typeof request !== 'object') {
		return false;
	}
	const { bytes, imagePixelBudget } = request as { readonly bytes?: unknown; readonly imagePixelBudget?: unknown };
	return (bytes === undefined || bytes instanceof Uint8Array) && (imagePixelBudget === undefined || typeof imagePixelBudget === 'number');
}

// 解析は途中で止められないので、取り消しは受け流す（待ち行列の側で依頼を外す）。
runParadisWorkerLoop<IParadisSpreadsheetParseWorkerRun, ParadisSpreadsheetParseWorkerResult>(parentPort, {
	accepts: isParseRun,
	invalid: { kind: 'unavailable', reason: 'failed' },
	failed: { kind: 'unavailable', reason: 'failed' },
	failureKind: paradisOfficeWorkerFailureKind,
	run: async request => {
		try {
			if (request.bytes) {
				const source = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
				// JSON にして移す（shared process は開かずに renderer へ中継する）
				const json = encodeParadisWorkbookJson(packParadisWorkbookStyles(await service.parseWorkbookBytes(source, request.imagePixelBudget)));
				return { result: { kind: 'workbookJson', json }, transfer: [json.buffer as ArrayBuffer] };
			}
			await service.warm();
			return { result: { kind: 'warm' } };
		} catch (error) {
			// 壊れた・対応していないブックで exceljs・jszip が投げるのは素の Error で、利用者のファイルの問題なので送らない。
			// TypeError など、それ以外の例外はこちらの不具合の疑いがあるので種類だけ送る。
			// この判定のため、worker の中で自前の `new Error(...)` を投げると Sentry には送られない（送りたい失敗は別の型で投げる）。
			const unexpected = !(error instanceof Error) || error.constructor !== Error;
			return {
				result: { kind: 'error', message: error instanceof Error ? error.message : String(error) },
				...(unexpected ? { cause: paradisOfficeWorkerFailureKind(error) } : {}),
			};
		}
	},
});
