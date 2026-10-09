/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の EMF・WMF の変換を行う worker（別スレッド）の入口。shared process から `worker_threads` で起動される。
// 変換は記録 1 件の中で長く止まることがあり、shared process 本体で走らせると、その間ほかのチャネル
// （拡張機能・同期など）の応答が止まるので、ここで行う。
// パッケージ版でもこの場所へ出力されるよう、`build/next/index.ts` の入口一覧に載せてある。

import { parentPort } from 'worker_threads';
import type { IParadisOfficeSemanticWorkerReply, ParadisOfficeSemanticWorkerMessage } from '../office/paradisOfficeSemanticWorkerQueue.js';
import type { IParadisSpreadsheetMetafileImages } from '../../common/paradisSpreadsheet.js';
import { convertParadisSpreadsheetMetafiles } from './paradisSpreadsheetMetafiles.js';
import type { IParadisSpreadsheetMetafileWorkerRun } from './paradisSpreadsheetMetafileWorkerBackend.js';

class MetafileCancelled extends Error { }

/** 走っている依頼。取り消しは、この中の依頼についてだけ覚える（終わった依頼の取り消しを溜めないため）。 */
const running = new Set<number>();
const cancelled = new Set<number>();

async function handle(id: number, request: IParadisSpreadsheetMetafileWorkerRun): Promise<void> {
	running.add(id);
	let reply: IParadisOfficeSemanticWorkerReply<IParadisSpreadsheetMetafileImages>;
	try {
		const images = await convertParadisSpreadsheetMetafiles(request.bytes, {
			checkpoint: async () => {
				// 取り消しの知らせを受け取れるよう、区切りごとに順番を譲る。
				await new Promise(resolve => setImmediate(resolve));
				if (cancelled.has(id)) {
					throw new MetafileCancelled();
				}
			},
		});
		reply = { kind: 'result', id, result: { images } };
	} catch (error) {
		reply = { kind: 'result', id, result: { images: {}, unavailableReason: error instanceof MetafileCancelled ? 'cancelled' : 'failed' } };
	} finally {
		running.delete(id);
		cancelled.delete(id);
	}
	parentPort?.postMessage(reply);
}

parentPort?.on('message', (message: ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetMetafileWorkerRun>) => {
	if (message.op === 'cancel') {
		if (running.has(message.id)) {
			cancelled.add(message.id);
		}
		return;
	}
	if (message.request?.bytes instanceof Uint8Array) {
		void handle(message.id, message.request);
	} else {
		parentPort?.postMessage({ kind: 'result', id: message.id, result: { images: {}, unavailableReason: 'invalid' } });
	}
});
