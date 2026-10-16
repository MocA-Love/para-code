/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の worker_threads の worker が共通で使う入口。`paradisWorker.ts` の `createParadisWorker` が
// この .js を起こし、`workerData` で本体の入口を渡す。ここで asar の解決を登録してから本体を動的に
// import する（理由は paradisWorkerAsarResolution.ts）。パッケージ版でもこの場所へ出力されるよう、
// `build/next/index.ts` の入口一覧に載せてある。npm パッケージを import しないこと。

import { workerData } from 'worker_threads';
import { resolve } from '../../base/common/path.js';
import { registerParadisWorkerAsarResolution, startParadisWorkerEntry } from './paradisWorkerAsarResolution.js';

// out/vs/paradis/node/ から 4 つ上が `out` の 1 つ上（bootstrap-esm.ts の appRoot と同じ場所）。
const appRoot = resolve(import.meta.dirname, '..', '..', '..', '..');

await startParadisWorkerEntry(workerData, () => registerParadisWorkerAsarResolution(appRoot), url => import(url));
