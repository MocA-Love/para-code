/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセス（electron-main）向け fork 機能の集約入り口。`app.ts` の `initChannels` から1回だけ呼ばれる。
//
// `app.ts` に並んでいた fork のチャネル登録を、そのままの順番でここへ移した。新しい main プロセスの
// チャネルはこの関数の中に足し、`app.ts` 側は触らない（upstream 取り込み時のコンフリクト面を増やさないため）。
// `app.ts` に残っている fork の行（ミラー用の画面キャプチャ・webview の service worker の掃除と見張り・
// pty ホストの起動・LocalPty チャネル・暗号化チャネルの shared process への公開）は upstream の処理の
// 途中に入るもので、ここへは移せない。

import { DisposableStore } from '../base/common/lifecycle.js';
import { ProxyChannel } from '../base/parts/ipc/common/ipc.js';
import { Server as ElectronIPCServer } from '../base/parts/ipc/electron-main/ipc.electron.js';
import { Client as MessagePortClient } from '../base/parts/ipc/electron-main/ipc.mp.js';
import { IBrowserViewMainService } from '../platform/browserView/electron-main/browserViewMainService.js';
import { IConfigurationService } from '../platform/configuration/common/configuration.js';
import { IDialogMainService } from '../platform/dialogs/electron-main/dialogMainService.js';
import { IEnvironmentMainService } from '../platform/environment/electron-main/environmentMainService.js';
import { IInstantiationService, ServicesAccessor } from '../platform/instantiation/common/instantiation.js';
import { ILifecycleMainService } from '../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../platform/log/common/log.js';
import { IProductService } from '../platform/product/common/productService.js';
import { ILocalPtyService } from '../platform/terminal/common/terminal.js';
import { IUpdateService } from '../platform/update/common/update.js';
import { IWindowsMainService } from '../platform/windows/electron-main/windows.js';
import { IParadisAgentCursorEvents, PARADIS_AGENT_BROWSER_SHOW_CURSOR_OVERLAY_SETTING, PARADIS_AGENT_CURSOR_CHANNEL, PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL, PARADIS_CDP_TARGET_CHANNEL } from './contrib/agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpTargetService } from './contrib/agentBrowser/electron-main/paradisCdpTargetService.js';
import { ParadisCursorOverlayController } from './contrib/agentBrowser/electron-main/paradisCursorOverlayController.js';
import { PARADIS_RESOURCE_MONITOR_CHANNEL } from './contrib/resourceMonitor/common/paradisResourceMonitor.js';
import { ParadisResourceMonitorMainService } from './contrib/resourceMonitor/electron-main/paradisResourceMonitorMainService.js';
import { paradisRegisterHealthBeacon } from './contrib/healthBeacon/electron-main/paradisHealthBeaconMain.js';
import { paradisRegisterHeapSnapshot } from './contrib/heapSnapshot/electron-main/paradisHeapSnapshotMain.js';
import { paradisRegisterBrowserProfiles } from './contrib/browserProfiles/electron-main/paradisBrowserProfilesMain.js';
import { paradisRegisterBrowserDownloads } from './contrib/browserDownloads/electron-main/paradisBrowserDownloadsMain.js';
import { paradisRegisterPtyDaemonStatus } from './contrib/ptyDaemon/electron-main/paradisPtyDaemonStatusService.js';
import { paradisRegisterUpdateTerminals } from './contrib/updateTerminals/electron-main/paradisUpdateTerminalsMain.js';
import { paradisRegisterMenuBar } from './contrib/menuBar/electron-main/paradisMenuBarMain.js';
import { paradisRegisterKeepAwake } from './contrib/keepAwake/electron-main/paradisKeepAwakeMain.js';
import { paradisRegisterTaskBoardHost } from './contrib/taskBoard/electron-main/paradisTaskBoardHostMain.js';
import { PARADIS_MOBILE_WINDOW_LEASE_CHANNEL } from './contrib/mobileRelay/common/paradisMobileWindowLease.js';
import { ParadisMobileWindowLeaseChannel } from './contrib/mobileRelay/electron-main/paradisMobileWindowLeaseChannel.js';
import { paradisRegisterDesignMode } from './contrib/browserDesignMode/electron-main/paradisDesignModeMain.js';
import { paradisRegisterBrowserLoadStall } from './contrib/browserLoadStall/electron-main/paradisBrowserLoadStallMain.js';
import { ParadisBrowserViewFreezer } from './contrib/browserFreeze/electron-main/paradisBrowserViewFreezer.js';
import { PARADIS_BROWSER_FREEZE_HIDDEN_TABS_SETTING } from './contrib/browserFreeze/common/paradisBrowserFreeze.js';

/** `app.ts` の `CodeApplication` が持っている main プロセスのサービス。 */
export interface IParadisMainProcessServices {
	readonly configurationService: IConfigurationService;
	readonly environmentMainService: IEnvironmentMainService;
	readonly productService: IProductService;
	readonly lifecycleMainService: ILifecycleMainService;
	readonly logService: ILogService;
}

/**
 * main プロセスへ fork のチャネルをすべて登録する。`app.ts` の `initChannels` から1回だけ呼ばれる。
 *
 * `disposables` は `initChannels` の DisposableStore。`accessor` は `invokeFunction` の中のものを
 * 渡すこと（同期的にしか使えない）。
 */
export function registerParadisMainProcessContributions(
	accessor: ServicesAccessor,
	mainProcessElectronServer: ElectronIPCServer,
	sharedProcessClient: Promise<MessagePortClient>,
	disposables: DisposableStore,
	{ configurationService, environmentMainService, productService, lifecycleMainService, logService }: IParadisMainProcessServices,
): void {
	// viewId -> DevTools targetId resolver channel for the agentBrowser CDP gateway (shared process only)
	const paradisCdpTargetService = new ParadisCdpTargetService(
		accessor.get(IBrowserViewMainService),
		undefined,
		undefined,
		// agent cursor overlay, gated by the Para Code setting (default on, matching the registry default)
		new ParadisCursorOverlayController(() => configurationService.getValue<boolean>(PARADIS_AGENT_BROWSER_SHOW_CURSOR_OVERLAY_SETTING) !== false),
	);
	// pin the real remote-debugging port now, before a second instance can overwrite
	// DevToolsActivePort — this process is the one that wrote it (see paradisCdpUpstreamPortPin.ts).
	paradisCdpTargetService.pinUpstreamPort();
	// the shared process (mobile browser mirror) subscribes to the agent cursor only while a phone watches; do not buffer it until then
	const paradisCdpTargetChannel = ProxyChannel.fromService(paradisCdpTargetService, disposables, { unbufferedEvents: ['onDidChangeAgentCursor'] });
	sharedProcessClient.then(client => client.registerChannel(PARADIS_CDP_TARGET_CHANNEL, paradisCdpTargetChannel));
	// mirror the agent cursor to the workbench too (the browser wall redraws it over the thumbnails; a page that is not on screen never paints its own overlay). Read-only surface: the renderer only subscribes to the event.
	const paradisAgentCursorSurface: IParadisAgentCursorEvents = { onDidChangeAgentCursor: paradisCdpTargetService.onDidChangeAgentCursor };
	// unbufferedEvents: nobody listens while the browser wall is closed, and the default
	// buffering would pile every agent mouse move up in main until someone does. Dropping
	// them is fine — the wall only mirrors what is happening right now.
	mainProcessElectronServer.registerChannel(PARADIS_AGENT_CURSOR_CHANNEL, ProxyChannel.fromService(paradisAgentCursorSurface, disposables, { unbufferedEvents: ['onDidChangeAgentCursor'] }));
	// tell the workbench which integrated browser tabs carry agent init scripts, and let the user remove them from the tab
	mainProcessElectronServer.registerChannel(PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL, ProxyChannel.fromService(paradisCdpTargetService.pageScriptsSurface, disposables));

	// CPU/RAM resource monitor snapshot channel for the titlebar indicator (main process only)
	const paradisResourceMonitorChannel = ProxyChannel.fromService(new ParadisResourceMonitorMainService(), disposables);
	mainProcessElectronServer.registerChannel(PARADIS_RESOURCE_MONITOR_CHANNEL, paradisResourceMonitorChannel);
	disposables.add(paradisRegisterDesignMode(mainProcessElectronServer, accessor.get(IBrowserViewMainService), environmentMainService.userDataPath)); // integrated browser Design Mode (see paradis/contrib/browserDesignMode)
	disposables.add(paradisRegisterBrowserLoadStall(mainProcessElectronServer)); // integrated browser "still waiting" question (see paradis/contrib/browserLoadStall)
	const browserViewFreezer = disposables.add(new ParadisBrowserViewFreezer(accessor.get(IBrowserViewMainService), () => configurationService.getValue<boolean>(PARADIS_BROWSER_FREEZE_HIDDEN_TABS_SETTING) === true)); // freeze integrated browser tabs hidden for a long time, without reloading them; off unless the user turns it on (see paradis/contrib/browserFreeze)
	disposables.add(configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(PARADIS_BROWSER_FREEZE_HIDDEN_TABS_SETTING)) {
			browserViewFreezer.onDidChangeEnabled(); // turning the setting off wakes the tabs it froze
		}
	}));

	// periodic memory/CPU health beacon to Sentry (see paradis/contrib/healthBeacon).
	// This one, updateTerminals and taskBoardHost act on onWillShutdown, so they stay out of `disposables`:
	// this application disposes itself inside its own onWillShutdown listener, which would unsubscribe
	// them before the event reaches them. They live until the process exits.
	paradisRegisterHealthBeacon(mainProcessElectronServer, accessor.get(IWindowsMainService), accessor.get(IBrowserViewMainService), lifecycleMainService, logService);

	// on-demand main process heap snapshot (see paradis/contrib/heapSnapshot)
	disposables.add(paradisRegisterHeapSnapshot(mainProcessElectronServer));

	// named browser profile session maintenance channel (see paradis/contrib/browserProfiles)
	disposables.add(paradisRegisterBrowserProfiles(mainProcessElectronServer, accessor.get(IInstantiationService)));
	disposables.add(paradisRegisterBrowserDownloads(mainProcessElectronServer, configurationService)); // browser download list (see paradis/contrib/browserDownloads)

	// what the pty daemon is holding, for the status bar entry that makes terminals
	// running outside the app visible (see paradis/contrib/ptyDaemon)
	disposables.add(paradisRegisterPtyDaemonStatus(mainProcessElectronServer, accessor.get(ILocalPtyService), configurationService, environmentMainService, productService, logService));
	paradisRegisterUpdateTerminals(mainProcessElectronServer, accessor.get(IWindowsMainService), accessor.get(IDialogMainService), configurationService, environmentMainService, productService, accessor.get(IUpdateService), lifecycleMainService, logService); // ask before ending terminals kept on remotes / the pty daemon when restarting to update (see paradis/contrib/updateTerminals). Not in `disposables`: see the health beacon above

	// menu bar (tray) icon with the notification inbox and agent usage, off by default (see paradis/contrib/menuBar)
	disposables.add(paradisRegisterMenuBar(mainProcessElectronServer, accessor.get(IWindowsMainService), configurationService, logService));
	disposables.add(paradisRegisterKeepAwake(mainProcessElectronServer, accessor.get(IWindowsMainService))); // stop a window's sleep prevention when it reloads, crashes and reopens, or closes (see paradis/contrib/keepAwake)
	paradisRegisterTaskBoardHost(mainProcessElectronServer, configurationService, environmentMainService, lifecycleMainService, logService); // start the bundled task board and open it in its own window (see paradis/contrib/taskBoard). Not in `disposables`: see the health beacon above

	// Renderer reload世代の唯一の権威。Main lifetimeで単調増加し、Shared再起動を跨ぐ。
	const paradisMobileWindowLeaseChannel = disposables.add(new ParadisMobileWindowLeaseChannel(mainProcessElectronServer, accessor.get(IWindowsMainService), lifecycleMainService));
	// Renderer向けchannelは接続固有wrapperをMain authority自身が登録する。
	// global登録すると同一windowの旧接続claimを新世代へ誤束縛できるため、Shared Processへだけ直接公開する。
	sharedProcessClient.then(client => client.registerChannel(PARADIS_MOBILE_WINDOW_LEASE_CHANNEL, paradisMobileWindowLeaseChannel));
}
