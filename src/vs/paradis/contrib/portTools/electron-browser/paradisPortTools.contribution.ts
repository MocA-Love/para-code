/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 呼び出し元ペインのウィンドウとして、ポートの転送の道具の受け口（paradisPortToolsChannel.ts）を shared process へ登録する。
// 転送の読み書きはポートパネルと同じ台帳（IRemoteExplorerService.tunnelModel）、張り直しはポートパネルの
// 「張り直す」と同じ処理（portReforward）、確認はページ共有と同じ承認のダイアログを使う。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IsDevelopmentContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IRemoteExplorerService } from '../../../../workbench/services/remote/common/remoteExplorerService.js';
import { TunnelCloseReason } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisConfirmServices } from '../../confirmDialog/browser/paradisConfirmDialog.js';
import { paradisProbeReforwardedPort, paradisReforwardReferenceCounts, paradisReforwardTunnel } from '../../portReforward/electron-browser/paradisPortReforwardTunnel.js';
import { IParadisReforwardConfirmRow, paradisReforwardConfirm, ParadisReforwardOtherWindows } from '../common/paradisPortReforwardConfirm.js';
import { PARADIS_PORT_TOOLS_CHANNEL } from '../common/paradisPortTools.js';
import { paradisShowReforwardConfirm } from './paradisPortReforwardConfirmDialog.js';
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
		@ILayoutService layoutService: ILayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHostService hostService: IHostService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
	) {
		super();
		const authority = environmentService.remoteAuthority;
		const confirmServices: IParadisConfirmServices = { layoutService, keybindingService, hostService };
		const shared = { sharedProcessService, authority, logService };
		const channel = new ParadisPortToolsChannel(
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
				referenceCounts: async tunnels => {
					// shared process の台帳はリモートのホストごとなので、ホストごとにまとめて問う
					const counts = new Map<string, number | undefined>();
					for (const host of new Set(tunnels.map(tunnel => tunnel.remoteHost))) {
						const ports = tunnels.filter(tunnel => tunnel.remoteHost === host).map(tunnel => tunnel.remotePort);
						const answers = await paradisReforwardReferenceCounts(shared, host, ports);
						ports.forEach((port, index) => counts.set(`${host}:${port}`, answers[index]));
					}
					return tunnels.map(tunnel => counts.get(`${tunnel.remoteHost}:${tunnel.remotePort}`));
				},
				probe: (localPort, remotePort) => paradisProbeReforwardedPort(shared, localPort, remotePort),
			},
			paneToken => paneTokenService.getInstanceForToken(paneToken) !== undefined,
			async (paneToken, request, cancellation) => {
				// ダイアログはウィンドウ側の締め切り（50 秒）で閉じる。shared process の待ちはそれより長い
				const deadline = new ParadisApprovalDeadline(cancellation);
				// 張り直しの確認は UI キットの確認で中身（案 C）を描く
				const confirm = request.reforward;
				try {
					const outcome = await approvals.askApproval(paneToken, confirm ? { ...request, present: presentation => paradisShowReforwardConfirm(confirmServices, confirm, presentation) } : request, deadline.token);
					return outcome === 'cancelled' && deadline.timedOut ? 'timedOut' : outcome;
				} finally {
					deadline.dispose();
				}
			},
		);
		sharedProcessService.registerChannel(PARADIS_PORT_TOOLS_CHANNEL, channel);
		// SSH の接続がつなぎ直されたら、張り直しても繋がらなかった記録は当てにならない
		const connection = remoteAgentService.getConnection();
		if (connection) {
			this._register(connection.onDidStateChange(event => {
				if (event.type === PersistentConnectionEventType.ConnectionGain) {
					channel.forgetUnreachable();
				}
			}));
		}
	}
}

/**
 * 開発用: 張り直しの確認を見本の中身で出す（SSH の窓が無い環境で見た目を確かめるため）。開発のビルドでだけ
 * コマンドパレットに出る。転送には何もしない。
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.dev.previewPortReforwardConfirm',
			title: localize2('paradis.dev.previewPortReforwardConfirm', "Para Code (Dev): Preview Port Reforward Confirmation"),
			precondition: IsDevelopmentContext,
			menu: { id: MenuId.CommandPalette, when: IsDevelopmentContext },
		});
	}
	async run(accessor: ServicesAccessor, scenario?: string): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const services: IParadisConfirmServices = { layoutService: accessor.get(ILayoutService), keybindingService: accessor.get(IKeybindingService), hostService: accessor.get(IHostService) };
		const scenarios = ['3', '21', '21-changes', '100-changes'];
		const picked = scenario ?? (await quickInputService.pick(scenarios.map(label => ({ label })), { canPickMany: false }))?.label;
		if (!picked) {
			return;
		}
		const count = Number(picked.split('-')[0]);
		const extra = [21010, 21017, 21029, 21030, 2101, 21039, 21040, 21049, 21050, 21059, 21060, 21069, 21070, 21079, 21080, 21089, 21090, 21099];
		const ports = [4545, 21009, 21019, ...extra, ...Array.from({ length: 100 }, (_, index) => 30000 + index)].slice(0, count);
		const changes = picked.includes('changes');
		const rows: IParadisReforwardConfirmRow[] = ports.map((remotePort, index) => ({ remotePort, localPort: changes && index === 1 ? 65459 : remotePort, changesLocal: changes && index === 1, label: index === 0 ? 'vite' : undefined }));
		const otherWindows: ParadisReforwardOtherWindows = count === 3 ? { kind: 'none' } : { kind: 'some', count: 2 };
		const confirm = paradisReforwardConfirm({ rows, inUse: changes ? [{ remotePort: 21100, localPort: 65460 }] : [], reason: 'ブラウザから localhost:4545 に繋がらないため', asksReason: true, otherWindows });
		await paradisShowReforwardConfirm(services, confirm, {
			message: confirm.title,
			paneLabel: '「ブラウザの表示の確認」（ターミナル 3・スペース「web-app」）',
			markerClass: 'paradis-dev-preview',
			token: CancellationToken.None,
		});
	}
});

registerWorkbenchContribution2(ParadisPortToolsContribution.ID, ParadisPortToolsContribution, WorkbenchPhase.AfterRestored);
