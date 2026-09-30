/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// REH サーバー（SSH 等の接続先）向け fork 機能の集約入り口。`serverServices.ts` から1回だけ呼ばれる。
//
// 新しいチャネルを足すとき:
//  1. `contrib/<feature>/node/` に `ParadisServerContributions.register('<id>', ({ server, accessor }) => ...)` を書く
//  2. このファイルの「登録」欄へ、そのファイルの副作用 import を1行足す
// `serverServices.ts` 側は触らない（upstream 取り込み時のコンフリクト面を増やさないため）。
//
// このファイルは Electron を含まない素の node で動く。electron-* 層のものを import しないこと。
//
// 既存の fork チャネル（`registerParadis*ForServer` の直呼び）はまだ `serverServices.ts` に並んでいる。
// pty ホストのサービスなど、この登録口より前に作られる値を受け取るものがあるため、移すときは
// 1つずつ引数の出どころを確かめる。

import { IDisposable } from '../base/common/lifecycle.js';
import { IPCServer } from '../base/parts/ipc/common/ipc.js';
import { ServicesAccessor } from '../platform/instantiation/common/instantiation.js';
import { ILogService } from '../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from './common/paradisProcessContributions.js';

// --- 登録（新しいチャネルはこの下に副作用 import を1行足す） ---
import './contrib/codexAccounts/node/paradisCodexAccounts.server.js';
import './contrib/limitsMonitor/node/paradisClaudeAccounts.server.js';

/**
 * 登録済みの REH サーバー向け contribution をすべて呼ぶ。
 * `accessor` は `invokeFunction` の中のものを渡すこと（同期的にしか使えない）。
 */
export function registerParadisServerContributions(server: IPCServer<RemoteAgentConnectionContext>, accessor: ServicesAccessor): IDisposable {
	return ParadisServerContributions.instantiate(server, accessor, accessor.get(ILogService));
}
