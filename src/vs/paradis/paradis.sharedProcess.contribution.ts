/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 向け fork 機能の集約入り口。`sharedProcessMain.ts` から1回だけ呼ばれる。
//
// 新しいチャネルを足すとき:
//  1. `contrib/<feature>/node/`（Electron の utility process 専用 API が要るなら `electron-utility/`）に
//     `ParadisSharedProcessContributions.register('<id>', ({ server, accessor }) => ...)` を書く
//  2. このファイルの「登録」欄へ、そのファイルの副作用 import を1行足す
// `sharedProcessMain.ts` 側は触らない（upstream 取り込み時のコンフリクト面を増やさないため）。
//
// 既存の fork チャネル（`registerParadis*` の直呼び）はまだ `sharedProcessMain.ts` に並んでいる。
// 互いに値を渡し合うもの（agentBrowser → mobileCanvas / mobileRelay）があり、順序を崩さずに
// 移せるか確かめてから移す。

import { IDisposable } from '../base/common/lifecycle.js';
import { IPCServer } from '../base/parts/ipc/common/ipc.js';
import { ServicesAccessor } from '../platform/instantiation/common/instantiation.js';
import { ILogService } from '../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from './common/paradisProcessContributions.js';

// --- 登録（新しいチャネルはこの下に副作用 import を1行足す） ---
// 登録（instantiate）はこの import の順に行う。codexAccounts はアカウント用の Codex ホームを有効にする
// （paradisEnableCodexAccountHomes）ので、ホームの一覧を使う agentHookTrust・agentActivity より先に置く。
import './contrib/limitsMonitor/node/paradisClaudeAccounts.contribution.js';
import './contrib/codexAccounts/node/paradisCodexAccountsChannel.js';
import './contrib/agentHookTrust/node/paradisCodexHookTrust.js';
import './contrib/agentModelCatalog/node/paradisAgentModelCatalog.js';
import './contrib/agentActivity/node/paradisAgentActivityChannel.js';
import './contrib/notificationInbox/node/paradisNotificationInboxChannel.js';
import './contrib/agentIde/node/paradisAgentIde.sharedProcess.js';
import './contrib/scheduledRuns/node/paradisScheduledRunsChannel.js';
import './contrib/computerUse/node/paradisComputerUse.sharedProcess.js';
import './contrib/fileTransfer/node/paradisFileModes.sharedProcess.js';
import './contrib/fileTransfer/node/paradisSftp.sharedProcess.js';
import './contrib/resourceMonitor/node/paradisSystemUsage.sharedProcess.js';
import './contrib/notifications/node/paradisAgentDictionary.sharedProcess.js';

/**
 * 登録済みの shared process 向け contribution をすべて呼ぶ。
 * `accessor` は `invokeFunction` の中のものを渡すこと（同期的にしか使えない）。
 */
export function registerParadisSharedProcessContributions(server: IPCServer<string>, accessor: ServicesAccessor): IDisposable {
	return ParadisSharedProcessContributions.instantiate(server, accessor, accessor.get(ILogService));
}
