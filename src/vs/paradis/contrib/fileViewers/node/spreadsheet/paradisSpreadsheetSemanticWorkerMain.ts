/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の詳しい解析を行う worker（別スレッド）の入口。shared process から `worker_threads` で起動される。
//
// 部品一覧と意味解析は、大きなブックで十数秒かかる。shared process 本体で走らせると、その間ほかの
// チャネル（拡張機能・通知など）の応答が止まるので、ここで行う。exceljs は読み込まない。
// パッケージ版でもこの場所へ出力されるよう、`build/next/index.ts` の入口一覧に載せてある。

import { parentPort } from 'worker_threads';
import { unavailableParadisSpreadsheetSemanticDiagnostics, type IParadisSemanticDiagnosticsSummary } from '../../common/paradisSpreadsheet.js';
import { runParadisWorkerLoop } from '../../../../node/paradisWorkerLoop.js';
import { paradisOfficeWorkerFailureKind } from '../office/paradisOfficeWorkerDiagnostics.js';
import { collectParadisSpreadsheetSemanticDiagnostics } from './paradisSpreadsheetSemanticDiagnostics.js';
import type { IParadisSpreadsheetSemanticWorkerRun } from './paradisSpreadsheetSemanticWorkerBackend.js';

runParadisWorkerLoop<IParadisSpreadsheetSemanticWorkerRun, IParadisSemanticDiagnosticsSummary>(parentPort, {
	accepts: (request): request is IParadisSpreadsheetSemanticWorkerRun => !!request && typeof request === 'object' && (request as { readonly bytes?: unknown }).bytes instanceof Uint8Array,
	invalid: unavailableParadisSpreadsheetSemanticDiagnostics('invalid'),
	failed: unavailableParadisSpreadsheetSemanticDiagnostics('failed'),
	failureKind: paradisOfficeWorkerFailureKind,
	run: async (request, token) => {
		// 解析の中で握られた想定外の例外の種類。返事に載せて、shared process が Sentry へ送る。
		let cause: string | undefined;
		const result = await collectParadisSpreadsheetSemanticDiagnostics(request.bytes, token, error => { cause = paradisOfficeWorkerFailureKind(error); });
		return { result, ...(cause ? { cause } : {}) };
	},
});
