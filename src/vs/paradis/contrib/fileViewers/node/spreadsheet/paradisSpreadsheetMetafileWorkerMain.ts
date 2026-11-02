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
import { runParadisWorkerLoop } from '../../../../node/paradisWorkerLoop.js';
import { paradisOfficeWorkerFailureKind } from '../office/paradisOfficeWorkerDiagnostics.js';
import type { IParadisSpreadsheetMetafileImages } from '../../common/paradisSpreadsheet.js';
import { convertParadisSpreadsheetMetafiles } from './paradisSpreadsheetMetafiles.js';
import type { IParadisSpreadsheetMetafileWorkerRun } from './paradisSpreadsheetMetafileWorkerBackend.js';

class MetafileCancelled extends Error { }

runParadisWorkerLoop<IParadisSpreadsheetMetafileWorkerRun, IParadisSpreadsheetMetafileImages>(parentPort, {
	accepts: (request): request is IParadisSpreadsheetMetafileWorkerRun => !!request && typeof request === 'object' && (request as { readonly bytes?: unknown }).bytes instanceof Uint8Array,
	invalid: { images: {}, unavailableReason: 'invalid' },
	// 握った例外の種類は共通の受け口が返事に載せ、shared process が Sentry へ送る。
	failed: { images: {}, unavailableReason: 'failed' },
	failureKind: paradisOfficeWorkerFailureKind,
	run: async (request, token) => {
		try {
			const images = await convertParadisSpreadsheetMetafiles(request.bytes, {
				checkpoint: async () => {
					// 取り消しの知らせを受け取れるよう、区切りごとに順番を譲る。
					await new Promise(resolve => setImmediate(resolve));
					if (token.isCancellationRequested) {
						throw new MetafileCancelled();
					}
				},
			});
			return { result: { images } };
		} catch (error) {
			if (error instanceof MetafileCancelled) {
				return { result: { images: {}, unavailableReason: 'cancelled' } };
			}
			throw error;
		}
	},
});
