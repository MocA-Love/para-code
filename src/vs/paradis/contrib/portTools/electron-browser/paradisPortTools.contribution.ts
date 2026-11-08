/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 呼び出し元ペインのウィンドウとして、ポートの転送の道具の受け口（paradisPortToolsChannel.ts）を shared process へ登録する。
// 転送の読み書きはポートパネルと同じ台帳（IRemoteExplorerService.tunnelModel）、張り直しはポートパネルの
// 「張り直す」と同じ処理（portReforward）、確認はページ共有と同じ承認のダイアログを使う。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteExplorerService } from '../../../../workbench/services/remote/common/remoteExplorerService.js';
import { TunnelCloseReason } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { paradisReforwardTunnel } from '../../portReforward/electron-browser/paradisPortReforwardTunnel.js';
import { PARADIS_PORT_TOOLS_CHANNEL } from '../common/paradisPortTools.js';
import { ParadisPortToolsChannel } from './paradisPortToolsChannel.js';

class ParadisPortToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisPortTools';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IRemoteExplorerService remoteExplorerService: IRemoteExplorerService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IConfigurationService configurationService: IConfigurationService,
		@INativeHostService nativeHostService: INativeHostService,
		@ILogService logService: ILogService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
		@IParadisAgentBrowserTabsService approvals: IParadisAgentBrowserTabsService,
	) {
		super();
		const authority = environmentService.remoteAuthority;
		sharedProcessService.registerChannel(PARADIS_PORT_TOOLS_CHANNEL, new ParadisPortToolsChannel(
			{
				remoteAuthority: authority,
				localPortHost: () => configurationService.getValue('remote.localPortHost'),
				forwarded: () => Array.from(remoteExplorerService.tunnelModel.forwarded.values()),
				candidates: () => remoteExplorerService.tunnelModel.candidatesOrUndefined,
				forward: (properties, attributes) => remoteExplorerService.forward(properties, attributes),
				close: remote => remoteExplorerService.close({ host: remote.host, port: remote.port }, TunnelCloseReason.User),
				reforward: (tunnel, localPort) => paradisReforwardTunnel({ remoteExplorerService, sharedProcessService, authority, logService }, tunnel, localPort),
				// 転送と同じく 127.0.0.1 へ bind して確かめる（base/node/ports.ts の findFreePortFaster）
				isLocalPortFree: port => nativeHostService.isPortFree(port),
			},
			paneToken => paneTokenService.getInstanceForToken(paneToken) !== undefined,
			async (paneToken, request, cancellation) => {
				// ダイアログはウィンドウ側の締め切り（50 秒）で閉じる。shared process の待ちはそれより長い
				const deadline = new ParadisApprovalDeadline(cancellation);
				try {
					const outcome = await approvals.askApproval(paneToken, request, deadline.token);
					return outcome === 'cancelled' && deadline.timedOut ? 'timedOut' : outcome;
				} finally {
					deadline.dispose();
				}
			},
		));
	}
}

registerWorkbenchContribution2(ParadisPortToolsContribution.ID, ParadisPortToolsContribution, WorkbenchPhase.AfterRestored);
