/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話ログを読む worker（別スレッド）の入口。shared process から `worker_threads` で起動される。
//
// 会話ログは合計で数 GB になることがあり、shared process 本体で読むとその間エージェントの状態通知
// などが遅れる。読み取り・集計・全文索引（同期 API の SQLite）はすべてここで行う。
// パッケージ版でもこの場所へ出力されるよう、`build/next/index.ts` の入口一覧に載せてある。

import { existsSync } from 'fs';
import { parentPort } from 'worker_threads';
import { ParadisActivityTranscriptParser } from '../common/paradisAgentActivity.js';
import { IParadisActivityWorkerEnvelope, ParadisActivityParseReply, ParadisActivityWorkerReply, ParadisActivityWorkerRequest } from '../common/paradisAgentActivityWorkerProtocol.js';
import { ParadisSessionIndexStore, paradisRemoveIndexFiles } from './paradisSessionIndexStore.js';
import { paradisReadTranscriptLines } from './paradisTranscriptLineReader.js';

let store: { readonly path: string; readonly store: ParadisSessionIndexStore } | undefined;
/** 索引への書き込みは1本ずつ（同じ接続で BEGIN を重ねない）。 */
let indexQueue: Promise<unknown> = Promise.resolve();
/** 索引の削除が来たら立てる。実行中の更新は行の切れ目でこれを見て止まる。次の更新の開始で下ろす。 */
let aborted = false;

function openStore(dbPath: string): ParadisSessionIndexStore {
	if (store?.path !== dbPath) {
		store?.store.close();
		store = { path: dbPath, store: new ParadisSessionIndexStore(dbPath) };
	}
	return store.store;
}

function closeStore(): void {
	store?.store.close();
	store = undefined;
}

function queued<T>(run: () => Promise<T> | T): Promise<T> {
	const next = indexQueue.then(run, run);
	indexQueue = next.catch(() => undefined);
	return next;
}

async function parseFiles(request: Extract<ParadisActivityWorkerRequest, { op: 'parse' }>): Promise<ParadisActivityParseReply> {
	const results: (ReturnType<ParadisActivityTranscriptParser['finish']> | null)[] = [];
	for (const file of request.files) {
		try {
			const parser = new ParadisActivityTranscriptParser(file.agent, file.subagentFile);
			await paradisReadTranscriptLines(file.path, 0, line => { parser.pushLine(line); });
			results.push(parser.finish());
		} catch {
			results.push(null);
		}
	}
	return results;
}

async function handle(request: ParadisActivityWorkerRequest): Promise<unknown> {
	switch (request.op) {
		case 'parse':
			return parseFiles(request);
		case 'indexUpdate':
			return queued(() => {
				aborted = false;
				return openStore(request.dbPath).update(request.files, { includeToolOutput: request.includeToolOutput }, () => !aborted);
			});
		case 'indexPrune':
			return queued(() => existsSync(request.dbPath) ? openStore(request.dbPath).prune(request.retentionThresholdMs, request.includeToolOutput) : 0);
		case 'indexSearch':
			// 更新の列には並ばない。更新は別の接続で書いているので、読みは WAL で並行できる。
			if (store?.path !== request.dbPath && !existsSync(request.dbPath)) {
				return { terms: [], uncovered: request.catalogIds, matches: [] };
			}
			return openStore(request.dbPath).search(request.query, request.catalogIds);
		case 'indexStats':
			return existsSync(request.dbPath) ? openStore(request.dbPath).stats() : { files: 0, messages: 0 };
		case 'indexAbort':
			aborted = true;
			return undefined;
		case 'indexDelete':
			return queued(() => {
				closeStore();
				paradisRemoveIndexFiles(request.dbPath);
			});
		case 'indexClose':
			return queued(() => closeStore());
	}
}

parentPort?.on('message', (envelope: IParadisActivityWorkerEnvelope) => {
	void handle(envelope.request).then(
		value => parentPort?.postMessage({ id: envelope.id, ok: true, value } satisfies ParadisActivityWorkerReply),
		error => parentPort?.postMessage({ id: envelope.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ParadisActivityWorkerReply),
	);
});
