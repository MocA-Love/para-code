/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPCServer, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../common/paradisMobileRelay.js';
import { ParadisMobileRelayService } from './paradisMobileRelayService.js';

/**
 * shared process 側でモバイルリレーサービスを生成し、IPCチャネルとして公開する。
 * renderer 側は ISharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL) で接続する。
 * sharedProcessMain.ts から1行で呼ぶ（既存の registerParadis* と同じ形）。
 */
export function registerParadisMobileRelay(server: IPCServer, userDataPath: string, logService: ILogService): IDisposable {
	const store = new DisposableStore();
	const service = store.add(new ParadisMobileRelayService(userDataPath, logService));
	server.registerChannel(PARADIS_MOBILE_RELAY_CHANNEL, ProxyChannel.fromService(service, store));
	return store;
}
