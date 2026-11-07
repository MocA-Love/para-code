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
// 前からある fork チャネル（`registerParadis*ForServer` の直呼び）は、`serverServices.ts` に並んでいた
// ものをそのままの順番で下の `registerParadisServerContributions` に移した。pty ホストのサービスなど、
// この登録口より前に作られる値は引数で受け取る。`serverServices.ts` に残っている fork の行
// （常駐 pty の有効化・ターミナルの猶予時間・サーバーの寿命）は upstream の式の途中に入るもので、
// ここへは移せない。

import { DisposableStore, IDisposable } from '../base/common/lifecycle.js';
import { IPCServer } from '../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../platform/instantiation/common/instantiation.js';
import { ILogService } from '../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../platform/remote/common/remoteAgentEnvironment.js';
import { ParadisServerContributions } from './common/paradisProcessContributions.js';
// 前からある fork チャネル（直呼びで登録するもの）
import { IParadisServerDaemonPtyAccess, registerParadisPtyDaemonStatusForServer } from './contrib/ptyDaemon/node/paradisPtyDaemonStatusServer.js';
import { registerParadisWorktreeGitForServer } from './contrib/workspaceSwitch/node/paradisWorktreeGitChannel.js';
import { registerParadisCcusageForServer } from './contrib/ccusage/node/paradisCcusageChannel.js';
import { registerParadisLimitsMonitorForServer } from './contrib/limitsMonitor/node/paradisLimitsMonitorChannel.js';
import { registerParadisRtkForServer } from './contrib/rtk/node/paradisRtkChannel.js';
import { registerParadisHostResourcesForServer } from './contrib/resourceMonitor/node/paradisHostResourcesChannel.js';
import { registerParadisSessionResumeForServer } from './contrib/sessionResume/node/paradisSessionResumeChannel.js';
import { registerParadisSpaceDiskForServer } from './contrib/spaceDisk/node/paradisSpaceDiskChannel.js';
import { registerParadisHtmlPreviewForServer } from './contrib/fileViewers/node/paradisHtmlPreviewChannel.js';
import { registerParadisOfficeForServer } from './contrib/fileViewers/node/paradisOfficeServerChannel.js';
import { registerParadisCodexTerminalTitleForServer } from './contrib/codexTerminalTitle/node/paradisCodexTerminalTitleChannel.js';
import { registerParadisRemoteSearchForServer } from './contrib/mobileRelay/node/paradisRemoteSearchChannel.js';
import { registerParadisGithubMetricsForServer } from './contrib/githubMetrics/node/paradisGithubMetricsChannel.js';
import { registerParadisPortListForServer } from './contrib/portList/node/paradisPortListChannelServer.js';

// --- 登録（新しいチャネルはこの下に副作用 import を1行足す） ---
import './contrib/codexAccounts/node/paradisCodexAccounts.server.js';
import './contrib/limitsMonitor/node/paradisClaudeAccounts.server.js';
import './contrib/fileTransfer/node/paradisFileModes.server.js';
import './contrib/agentHookTrust/node/paradisRemoteCodexHookTrust.server.js';
import './contrib/updateTerminals/node/paradisStaleServers.server.js';
import './contrib/notifications/node/paradisAgentDictionary.server.js';
import './contrib/mobileRelay/node/paradisRemoteShellOutput.server.js'; // SSH の接続先のシェルの出力（agent.shells.v1）
import './contrib/ptyDaemon/node/paradisPtyHandover.server.js'; // 常駐の端末の引き継ぎ（記録と引き取り直し）
import './contrib/taskBoard/node/paradisTaskBoardRemote.server.js'; // タスクボードの SSH 中継（接続先の検査と実行）
import './contrib/claudeMod/node/paradisRemoteClaudeMod.server.js'; // 接続先の Claude Code へ mod を読ませてよいか（方針と版）

/**
 * REH サーバーへ fork のチャネルをすべて登録する。`serverServices.ts` から1回だけ呼ばれる。
 *
 * 前からある直呼びのチャネルを元の順番で登録し、その後に上の登録口に入ったもの、最後に常駐 pty の
 * 状態チャネルを登録する。`accessor` は `invokeFunction` の中のものを渡すこと（同期的にしか使えない）。
 * `logService`・`configurationService` は `serverServices.ts` が作ったものをそのまま受け取る。
 */
export function registerParadisServerContributions(
	server: IPCServer<RemoteAgentConnectionContext>,
	accessor: ServicesAccessor,
	logService: ILogService,
	configurationService: IConfigurationService,
	ptyHostService: IParadisServerDaemonPtyAccess,
	userDataPath: string,
): IDisposable {
	const store = new DisposableStore();

	// expose the same git channel the shared process has, so a connected
	// client can clone onto this machine. The shared process copy always runs git
	// locally, so handing it a path on this side fails with ENOENT.
	store.add(registerParadisWorktreeGitForServer(server, logService));

	// the agents run here while a client is connected, so what they used is
	// recorded in this machine's home. Counting it on the client side misses all of it.
	store.add(registerParadisCcusageForServer(server, logService, configurationService));
	store.add(registerParadisLimitsMonitorForServer(server, logService));
	// rtk records what it saved on the machine that ran the command, so while a
	// client is connected those savings pile up here, not on the machine showing the window.
	store.add(registerParadisRtkForServer(server, logService));
	// while a client is connected, the terminals and agents run here, so
	// "how busy is the machine" means this machine, not the one showing the window.
	store.add(registerParadisHostResourcesForServer(server, logService));
	// expose the same Session Resume channel the shared process has, so a connected
	// client's Session Resume view can list/preview/search transcripts saved on this machine.
	store.add(registerParadisSessionResumeForServer(server, logService));
	// expose the same Space Disk channel the shared process has, so a connected
	// client can measure disk usage for spaces that live on this machine.
	store.add(registerParadisSpaceDiskForServer(server, logService));
	// expose the same HTML preview server the shared process has, so a connected
	// client can render a page that lives on this machine with its own files alongside it. The
	// client forwards this port; nothing here is reachable from outside this machine.
	store.add(registerParadisHtmlPreviewForServer(server));
	// new remote servers parse Office sources beside the files; old clients retain the legacy channel.
	store.add(registerParadisOfficeForServer(server, configurationService));
	// expose the same Codex terminal title channel the shared process has, so a
	// connected client can read Codex thread metadata that lives on this machine.
	store.add(registerParadisCodexTerminalTitleForServer(server, logService));
	// expose the same ripgrep search channel the shared process has, so a connected
	// client's mobile find/grep can search files that live on this machine.
	store.add(registerParadisRemoteSearchForServer(server, logService));
	// while a client is connected, the gh calls Para Code makes run here, and the
	// sink that records them only exists in the process that owns this service. Without one on
	// this side every call is dropped, so the client's GitHub usage view shows nothing at all.
	store.add(registerParadisGithubMetricsForServer(server, logService));
	// expose the same port-list channel the shared process has, so a connected
	// client's title bar widget can search/kill ports that are actually listening on this machine.
	store.add(registerParadisPortListForServer(server, logService));
	// every fork channel registered through the registry above
	store.add(ParadisServerContributions.instantiate(server, accessor, accessor.get(ILogService)));

	// the daemon that outlives this server lives on this machine, so a connected
	// client's status bar has to ask this side. Asking its own main process instead showed the
	// client PC's daemon in a window whose terminals all run here — and offered to stop it.
	store.add(registerParadisPtyDaemonStatusForServer(server, ptyHostService, configurationService, userDataPath, logService));

	return store;
}
