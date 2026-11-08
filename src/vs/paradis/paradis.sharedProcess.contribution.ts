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
// 前からある fork チャネル（`registerParadis*` の直呼び）は、`sharedProcessMain.ts` に並んでいた
// ものをそのままの順番で下の `registerParadisSharedProcessContributions` に移した。互いに値を
// 渡し合うもの（notifications → agentBrowser → simulator / mobileRelay）があるので、
// 並びを変えるときは渡している値の出どころを確かめる。

import { DisposableStore, IDisposable } from '../base/common/lifecycle.js';
import { IPCServer } from '../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../platform/environment/common/argv.js';
import { INativeEnvironmentService } from '../platform/environment/common/environment.js';
import { ServicesAccessor } from '../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../platform/log/common/log.js';
import { IProductService } from '../platform/product/common/productService.js';
import { ParadisSharedProcessContributions } from './common/paradisProcessContributions.js';
// 前からある fork チャネル（直呼びで登録するもの。下の関数の中で呼ぶ順番に並べてある）
import { registerParadisAgentBrowser } from './contrib/agentBrowser/node/paradisAgentBrowserChannel.js';
import { IParadisPlaywrightInvoker } from './contrib/agentBrowser/node/paradisAgentBrowserService.js';
import { registerParadisSimulator } from './contrib/simulator/node/paradisSimulator.sharedProcess.js';
import { registerParadisNotifications } from './contrib/notifications/node/paradisNotificationsChannel.js';
import { registerParadisAivisMuteBridge } from './contrib/notifications/node/paradisAivisMuteBridgeChannel.js';
import { registerParadisSpreadsheet } from './contrib/fileViewers/node/paradisSpreadsheetChannel.js';
import { registerParadisOffice } from './contrib/fileViewers/node/paradisOfficeChannel.js';
import { registerParadisWordSemantic } from './contrib/fileViewers/node/word/paradisWordSemanticChannel.js';
import { registerParadisRemoteHosts } from './contrib/remoteHosts/node/paradisRemoteHostsChannel.js';
import { registerParadisHtmlPreview } from './contrib/fileViewers/node/paradisHtmlPreviewChannel.js';
import { registerParadisWorktreeGit } from './contrib/workspaceSwitch/node/paradisWorktreeGitChannel.js';
import { registerParadisMobileRelay } from './contrib/mobileRelay/node/paradisMobileRelayChannel.js';
import { registerParadisRemoteSearch } from './contrib/mobileRelay/node/paradisRemoteSearchChannel.js';
import { registerParadisCcusage } from './contrib/ccusage/node/paradisCcusageChannel.js';
import { registerParadisRtk } from './contrib/rtk/node/paradisRtkChannel.js';
import { registerParadisSessionResume } from './contrib/sessionResume/node/paradisSessionResumeChannel.js';
import { registerParadisSpaceDisk } from './contrib/spaceDisk/node/paradisSpaceDiskChannel.js';
import { registerParadisCodexTerminalTitle } from './contrib/codexTerminalTitle/node/paradisCodexTerminalTitleChannel.js';
import { registerParadisLimitsMonitor } from './contrib/limitsMonitor/node/paradisLimitsMonitorChannel.js';
import { registerParadisGithubMetrics } from './contrib/githubMetrics/node/paradisGithubMetricsChannel.js';
import { registerParadisCopilotUtility } from './contrib/copilotUtility/node/paradisCopilotUtilityChannel.js';
import { registerParadisPortList } from './contrib/portList/node/paradisPortListChannel.js';

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
import './contrib/taskBoard/node/paradisTaskBoardBridge.sharedProcess.js';
import './contrib/computerUse/node/paradisComputerUse.sharedProcess.js';
import './contrib/browserBookmarks/node/paradisBookmarkTools.sharedProcess.js';
import './contrib/fileTransfer/node/paradisFileModes.sharedProcess.js';
import './contrib/fileTransfer/node/paradisSftp.sharedProcess.js';
import './contrib/resourceMonitor/node/paradisSystemUsage.sharedProcess.js';
import './contrib/portReforward/node/paradisPortReforward.sharedProcess.js';
import './contrib/portTools/node/paradisPortTools.sharedProcess.js';
import './contrib/notifications/node/paradisAgentDictionary.sharedProcess.js';
import './contrib/claudeMod/node/paradisClaudeContext.sharedProcess.js';
import './contrib/tasks/node/paradisTasksGithub.sharedProcess.js';

/**
 * shared process へ fork のチャネルをすべて登録する。`sharedProcessMain.ts` から1回だけ呼ばれる。
 *
 * 前からある直呼びのチャネルを元の順番で登録し、最後に上の登録口に入ったものを呼ぶ。
 * `accessor` は `invokeFunction` の中のものを渡すこと（同期的にしか使えない）。
 * `args` は shared process の起動引数、`playwrightInvoker` は upstream の Playwright チャネル
 * （agentBrowser がブラウザ操作を頼む先）。
 */
export function registerParadisSharedProcessContributions(server: IPCServer<string>, accessor: ServicesAccessor, args: NativeParsedArgs, playwrightInvoker: IParadisPlaywrightInvoker): IDisposable {
	const store = new DisposableStore();

	// 通知サウンド/Aivis読み上げバックエンド（カスタム音源管理・YouTube取込・Aivis Cloud APIクライアント）
	const paradisNotifications = store.add(registerParadisNotifications(server, accessor.get(ILogService), accessor.get(IConfigurationService), args));

	// ブラウザページ⇔エージェントCLI紐付け（バインディングレジストリ+MCP/CDPゲートウェイサーバーの生成とチャネル登録）
	const paradisAgentBrowser = store.add(registerParadisAgentBrowser(
		server,
		playwrightInvoker,
		accessor.get(INativeEnvironmentService).userDataPath,
		accessor.get(IMainProcessService),
		accessor.get(ILogService),
		accessor.get(IConfigurationService),
		args,
		audio => paradisNotifications.publishMobileVoiceClip(audio),
		paradisNotifications,
	));

	// モバイル端末⇔ターミナルペインのアタッチ台帳と mobile_* のツール（上のMCPサーバーへ相乗りさせるため、
	// エージェントCLI側に追加のMCP設定は要らない）、シミュレータの作り直し（serve-sim を組み込んだホストの子プロセス、
	// 映像と入力のチャネル、mobile_fold）
	store.add(registerParadisSimulator(
		server,
		accessor.get(INativeEnvironmentService).userDataPath,
		accessor.get(ILogService),
		provider => paradisAgentBrowser.registerToolProvider(provider),
	));

	// Excelビューア/差分の xlsx パースバックエンド（exceljs。rendererでは動かないためshared processで実行）
	store.add(registerParadisSpreadsheet(server));
	store.add(registerParadisOffice(server));
	// Word の詳しい解析（yauzl・crypto を使うため shared process で実行）
	store.add(registerParadisWordSemantic(server));

	// 「Para ホスト」ビューが、このウィンドウが繋がっていないホストの中身を
	// ssh 越しに読むためのバックエンド（繋がっているホストは IFileService 経由なのでここは通らない）
	registerParadisRemoteHosts(server, accessor.get(ILogService));

	// HTMLプレビューが読むファイルを 127.0.0.1 だけに配るローカルサーバ
	// （最初にプレビューを開くまで listen しない）
	store.add(registerParadisHtmlPreview(server));

	// worktree作成用の git 実行バックエンド（git worktree add / ブランチ列挙）
	store.add(registerParadisWorktreeGit(server, accessor.get(ILogService), accessor.get(IConfigurationService), args));

	// モバイルリレーサービス（src/vs/paradis/contrib/mobileRelay/ 参照）
	store.add(registerParadisMobileRelay(server, accessor.get(INativeEnvironmentService).userDataPath, accessor.get(IMainProcessService), accessor.get(ILogService), accessor.get(IConfigurationService), args, paradisAgentBrowser, paradisNotifications.onDidCreateMobileVoiceClip, probe => paradisNotifications.setMobileVoiceListenerProbe(probe)));
	// モバイルの find/grep 用 ripgrep チャネル
	store.add(registerParadisRemoteSearch(server, accessor.get(ILogService)));

	// ccusage CLI 実行バックエンド（src/vs/paradis/contrib/ccusage/ 参照）
	store.add(registerParadisCcusage(server, accessor.get(ILogService), accessor.get(IConfigurationService), args));
	// rtk CLI 実行バックエンド（src/vs/paradis/contrib/rtk/ 参照）
	store.add(registerParadisRtk(server, accessor.get(ILogService), accessor.get(IConfigurationService), args));
	// おやすみモード ⇔ aivis-mcp のミュート同期（src/vs/paradis/contrib/notifications/ 参照）
	store.add(registerParadisAivisMuteBridge(server, accessor.get(ILogService), accessor.get(IConfigurationService), args));
	// read-only Claude Code / Codex local session history browser (src/vs/paradis/contrib/sessionResume/)
	store.add(registerParadisSessionResume(server, accessor.get(ILogService)));

	// スペースの容量計測（数十秒かかるのでmainではなくここに置く。src/vs/paradis/contrib/spaceDisk/ 参照）
	store.add(registerParadisSpaceDisk(server, accessor.get(ILogService)));

	// Codex terminal title metadata reader（Codex App Serverは起動しない）
	store.add(registerParadisCodexTerminalTitle(server, accessor.get(ILogService)));

	// AIリミットモニターバックエンド（src/vs/paradis/contrib/limitsMonitor/ 参照）
	store.add(registerParadisLimitsMonitor(server, accessor.get(ILogService), accessor.get(IConfigurationService), args));

	// GitHub API 利用状況バックエンド（src/vs/paradis/contrib/githubMetrics/ 参照）
	store.add(registerParadisGithubMetrics(server, accessor.get(ILogService), accessor.get(IConfigurationService), args));

	// Copilot 小型モデルでの短文生成バックエンド（src/vs/paradis/contrib/copilotUtility/ 参照）
	store.add(registerParadisCopilotUtility(server, accessor.get(ILogService), accessor.get(IProductService)));

	// ローカルでリッスン中のポート一覧バックエンド（src/vs/paradis/contrib/portList/ 参照）
	store.add(registerParadisPortList(server, accessor.get(ILogService)));

	// 上の登録口（この先頭の副作用 import）に入ったチャネルをすべて
	store.add(ParadisSharedProcessContributions.instantiate(server, accessor, accessor.get(ILogService)));

	return store;
}
