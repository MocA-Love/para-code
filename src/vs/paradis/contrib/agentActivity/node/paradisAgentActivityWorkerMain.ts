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

import { parentPort } from 'worker_threads';
import { ParadisActivityTranscriptParser } from '../common/paradisAgentActivity.js';
import { IParadisActivityWorkerEnvelope, ParadisActivityParseReply, ParadisActivityWorkerReply, ParadisActivityWorkerRequest } from '../common/paradisAgentActivityWorkerProtocol.js';
import { ParadisSessionIndexStore } from './paradisSessionIndexStore.js';
import { paradisReadTranscriptLines } from './paradisTranscriptLineReader.js';

let store: { readonly path: string; readonly store: ParadisSessionIndexStore } | undefined;
/** 索引への書き込みは1本ずつ（同じ接続で BEGIN を重ねない）。 */
let indexQueue: Promise<unknown> = Promise.resolve();

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
			return queued(() => openStore(request.dbPath).update(request.files, { includeToolOutput: request.includeToolOutput }));
		case 'indexSearch':
			return queued(() => openStore(request.dbPath).search(request.query));
		case 'indexStats':
			return queued(() => openStore(request.dbPath).stats());
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
