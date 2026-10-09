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
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import type { IParadisSemanticDiagnosticsSummary } from '../../common/paradisSpreadsheet.js';
import type { IParadisOfficeSemanticWorkerReply, ParadisOfficeSemanticWorkerMessage } from '../office/paradisOfficeSemanticWorkerQueue.js';
import { collectParadisSpreadsheetSemanticDiagnostics, unavailableParadisSpreadsheetSemanticDiagnostics } from './paradisSpreadsheetSemanticDiagnostics.js';
import type { IParadisSpreadsheetSemanticWorkerRun } from './paradisSpreadsheetSemanticWorkerBackend.js';

const active = new Map<number, CancellationTokenSource>();

async function handle(id: number, request: IParadisSpreadsheetSemanticWorkerRun): Promise<void> {
	const cancellation = new CancellationTokenSource();
	active.set(id, cancellation);
	let reply: IParadisOfficeSemanticWorkerReply<IParadisSemanticDiagnosticsSummary>;
	try {
		reply = { kind: 'result', id, result: await collectParadisSpreadsheetSemanticDiagnostics(request.bytes, cancellation.token) };
	} catch {
		reply = { kind: 'result', id, result: unavailableParadisSpreadsheetSemanticDiagnostics('failed') };
	} finally {
		active.delete(id);
		cancellation.dispose();
	}
	parentPort?.postMessage(reply);
}

parentPort?.on('message', (message: ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetSemanticWorkerRun>) => {
	if (message.op === 'cancel') {
		active.get(message.id)?.cancel();
		return;
	}
	if (message.request?.bytes instanceof Uint8Array) {
		void handle(message.id, message.request);
	} else {
		parentPort?.postMessage({ kind: 'result', id: message.id, result: unavailableParadisSpreadsheetSemanticDiagnostics('invalid') });
	}
});
