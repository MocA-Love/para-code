/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word の詳しい解析を行う worker（別スレッド）の入口。shared process から `worker_threads` で起動される。
//
// 部品一覧の作成（全 XML の正規化とハッシュ）と解析は、大きな文書で数秒かかる。shared process 本体で
// 走らせると、その間ほかのチャネル（拡張機能・通知など）の応答が止まるので、ここで行う。
// パッケージ版でもこの場所へ出力されるよう、`build/next/index.ts` の入口一覧に載せてある。

import { parentPort } from 'worker_threads';
import { runParadisWorkerLoop } from '../../../../node/paradisWorkerLoop.js';
import type { ParadisWordSemanticWorkerResult, ParadisWordSemanticWorkerRun } from './paradisWordSemanticWorkerProtocol.js';
import { paradisOfficeWorkerFailureKind } from '../office/paradisOfficeWorkerDiagnostics.js';
import { ParadisWordSemanticService } from './paradisWordSemanticService.js';

const service = new ParadisWordSemanticService();

/** 依頼の形を確かめる（shared process の待ち行列から来るが、形の違う依頼を解析へ渡さない）。 */
function isWordRun(request: unknown): request is ParadisWordSemanticWorkerRun {
	if (!request || typeof request !== 'object') {
		return false;
	}
	const value = request as { readonly op?: unknown; readonly bytes?: unknown; readonly original?: unknown; readonly modified?: unknown };
	return value.op === 'analyze' || value.op === 'objects' ? value.bytes instanceof Uint8Array
		: value.op === 'compare' ? value.original instanceof Uint8Array && value.modified instanceof Uint8Array
			: false;
}

runParadisWorkerLoop<ParadisWordSemanticWorkerRun, ParadisWordSemanticWorkerResult>(parentPort, {
	accepts: isWordRun,
	invalid: { ok: false, code: 'invalid' },
	failed: { ok: false, code: 'failed' },
	failureKind: paradisOfficeWorkerFailureKind,
	run: async (request, token) => {
		// 解析の中で握られた想定外の例外の種類。返事に載せて、shared process が Sentry へ送る。
		let cause: string | undefined;
		const onUnexpectedError = (error: unknown) => { cause = paradisOfficeWorkerFailureKind(error); };
		const result = request.op === 'analyze'
			? await service.analyze(request.bytes, token, onUnexpectedError)
			: request.op === 'objects'
				? await service.extractObjects(request.bytes, token, onUnexpectedError)
				: await service.compare(request.original, request.modified, token, onUnexpectedError);
		return { result, ...(cause ? { cause } : {}) };
	},
});
