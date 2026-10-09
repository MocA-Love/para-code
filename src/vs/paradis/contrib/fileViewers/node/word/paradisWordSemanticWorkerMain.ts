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
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import type { ParadisWordSemanticWorkerMessage, ParadisWordSemanticWorkerRequest, ParadisWordSemanticWorkerRun } from './paradisWordSemanticWorkerProtocol.js';
import { ParadisWordSemanticService } from './paradisWordSemanticService.js';

const service = new ParadisWordSemanticService();
const active = new Map<number, CancellationTokenSource>();

async function handle(id: number, request: ParadisWordSemanticWorkerRun): Promise<void> {
	const cancellation = new CancellationTokenSource();
	active.set(id, cancellation);
	let reply: ParadisWordSemanticWorkerMessage;
	try {
		reply = request.op === 'analyze'
			? { kind: 'result', id, result: await service.analyze(request.bytes, cancellation.token) }
			: { kind: 'result', id, result: await service.compare(request.original, request.modified, cancellation.token) };
	} catch {
		reply = { kind: 'result', id, result: { ok: false, code: 'failed' } };
	} finally {
		active.delete(id);
		cancellation.dispose();
	}
	parentPort?.postMessage(reply);
}

parentPort?.on('message', (message: ParadisWordSemanticWorkerRequest) => {
	if (message.op === 'cancel') {
		active.get(message.id)?.cancel();
		return;
	}
	void handle(message.id, message.request);
});
