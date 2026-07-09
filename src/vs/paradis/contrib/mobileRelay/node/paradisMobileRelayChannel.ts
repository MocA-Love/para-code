/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPCServer, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisCdpFrameSubscription, PARADIS_CDP_TARGET_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../common/paradisMobileRelay.js';
import { ParadisMobileRelayService } from './paradisMobileRelayService.js';

/**
 * shared process 側でモバイルリレーサービスを生成し、IPCチャネルとして公開する。
 * renderer 側は ISharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL) で接続する。
 * sharedProcessMain.ts から1行で呼ぶ（既存の registerParadis* と同じ形）。
 *
 * 長期秘密鍵の暗号化のため、main プロセスの 'encryption'(safeStorage) チャネルを注入する。
 */
export function registerParadisMobileRelay(server: IPCServer, userDataPath: string, mainProcessService: IMainProcessService, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const store = new DisposableStore();
	const encryptionService = ProxyChannel.toService<IEncryptionService>(mainProcessService.getChannel('encryption'));
	// ブラウザミラーの再描画プッシュ購読（electron-main の beginFrameSubscription を中継）
	const cdpFrames = ProxyChannel.toService<IParadisCdpFrameSubscription>(mainProcessService.getChannel(PARADIS_CDP_TARGET_CHANNEL));
	const service = store.add(new ParadisMobileRelayService(userDataPath, encryptionService, cdpFrames, logService, configurationService, args));
	server.registerChannel(PARADIS_MOBILE_RELAY_CHANNEL, ProxyChannel.fromService(service, store));
	return store;
}
