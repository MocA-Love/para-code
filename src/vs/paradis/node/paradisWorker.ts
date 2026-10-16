/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// npm パッケージを読む fork の worker_threads の worker は、`new Worker(入口)` ではなくこれで起こす。
// 共通の入口（paradisWorkerBootstrap.ts）が asar の解決を登録してから本体を読むので、パッケージ版でも
// `node_modules.asar` の中のパッケージを解決できる。本体の入口も `build/next/index.ts` の入口一覧に
// 載せること（載せないとパッケージに出力されない）。

import { pathToFileURL } from 'url';
import { Worker, type WorkerOptions } from 'worker_threads';
import { FileAccess } from '../../base/common/network.js';
import { PARADIS_WORKER_ENTRY_KEY } from './paradisWorkerAsarResolution.js';

/** 共通の入口の場所（`out` からの相対）。 */
export const PARADIS_WORKER_BOOTSTRAP_MODULE = 'vs/paradis/node/paradisWorkerBootstrap.js';

/**
 * `entryPath`（worker の本体の入口の .js の絶対パス）を、共通の入口を通して worker で起こす。
 * `workerData` は共通の入口が使うので渡せない。
 */
export function createParadisWorker(entryPath: string, options?: Omit<WorkerOptions, 'workerData'>): Worker {
	return new Worker(FileAccess.asFileUri(PARADIS_WORKER_BOOTSTRAP_MODULE).fsPath, {
		...options,
		workerData: { [PARADIS_WORKER_ENTRY_KEY]: pathToFileURL(entryPath).href },
	});
}
