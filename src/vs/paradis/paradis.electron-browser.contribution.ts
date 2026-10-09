/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Paradis独自機能（通常ウィンドウ向け・Electron専用API依存）の集約import入り口。
// このファイルは workbench.desktop.main.ts からのみ読み込まれる（web workbenchでは読み込まれない）。
// INativeHostService 等、electron-main プロセスの実装を必要とする contribution はここに追加する。
// web/desktop 両対応の contribution は paradis.common.contribution.ts 側に追加すること。

import './contrib/sentry/electron-browser/paradisSentryRenderer.js';
import './contrib/sentry/electron-browser/paradisUnhandledErrorReporter.contribution.js';
// main プロセスの混雑の計測チャネルを、スペースの切り替えの計測へつなぐ（M1〜M4）
import './contrib/mainLoad/electron-browser/paradisMainLoadProbe.contribution.js';
import './contrib/windowTransparency/electron-browser/paradisWindowTransparency.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentBrowser.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentPreview.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentBrowserTabs.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentBrowserBindingRestore.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentNotes.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentBrowserCursorSettings.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentPageScriptsBanner.contribution.js';
// Claude Code の OSC 7501（作業の状態）に答え、hook の届かないペインの状態の補助にする
import './contrib/agentBrowser/electron-browser/paradisProgramStatus.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisBrowserScope.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisAgentStatus.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisAddRepositoryFlow.contribution.js';
// モバイル端末⇔ターミナルペインのアタッチUIが使うモデル（registerSingletonを起動時に確実に走らせる）
import './contrib/mobileCanvas/electron-browser/paradisMobileCanvasModel.js';
import './contrib/mobileCanvas/electron-browser/paradisMobileCanvasLifecycle.contribution.js';
// エージェントの「この端末を使いたい」を承認ダイアログで受ける（B13）
import './contrib/mobileCanvas/electron-browser/paradisMobileDeviceRequest.contribution.js';
import './contrib/browserButton/electron-browser/paradisOpenBrowserButton.contribution.js';
import './contrib/layoutPresets/electron-browser/paradisLayoutPresets.contribution.js';
import './contrib/notifications/electron-browser/paradisNotificationTrigger.contribution.js';
import './contrib/notifications/electron-browser/paradisNotificationSettingsDialog.contribution.js';
import './contrib/notifications/electron-browser/paradisDoNotDisturbStatusBar.contribution.js';
import './contrib/notifications/electron-browser/paradisAivisMuteSync.contribution.js';
import './contrib/notifications/electron-browser/paradisAgentDictionarySync.contribution.js';
import './contrib/notifications/electron-browser/paradisDictationAudioHold.contribution.js';
import './contrib/dictation/browser/paradisDictationAvailability.contribution.js';
import './contrib/notificationInbox/electron-browser/paradisNotificationInbox.contribution.js';
import './contrib/defaultExtensions/electron-browser/paradisDefaultExtensions.contribution.js';
import './contrib/fileViewers/electron-browser/paradisHtmlViewer.contribution.js';
import './contrib/fileViewers/electron-browser/paradisSpreadsheetViewer.contribution.js';
import './contrib/fileViewers/electron-browser/paradisPdfViewer.contribution.js';
import './contrib/fileViewers/electron-browser/paradisDocxViewer.contribution.js';
import './contrib/fileViewers/electron-browser/paradisOfficeDesktopSourceService.js';
import './contrib/browserBookmarks/electron-browser/paradisBrowserBookmarks.contribution.js';
import './contrib/browserProfiles/electron-browser/paradisBrowserProfiles.contribution.js';
import './contrib/browserProfiles/electron-browser/paradisBrowserProfileMcp.contribution.js';
import './contrib/browserDownloads/electron-browser/paradisBrowserDownloads.contribution.js';
import './contrib/releaseNotes/electron-browser/paradisReleaseNotes.contribution.js';
import './contrib/keepAwake/electron-browser/paradisKeepAwake.contribution.js';
import './contrib/mobileRelay/electron-browser/paradisMobileRelay.contribution.js';
import './contrib/mobileRelay/electron-browser/paradisMobileLinkMetrics.contribution.js';
import './contrib/mobileRelay/electron-browser/paradisMobileViewportBanner.contribution.js';
import './contrib/mobileRelay/electron-browser/paradisMobileDoNotDisturbSync.contribution.js';
import './contrib/browserMirror/electron-browser/paradisBrowserMirrorSpike.contribution.js';
import './contrib/remoteHosts/electron-browser/paradisRemoteHostBrowser.js';
// 2 画面のファイル転送（このマシン ⇄ このウィンドウの接続先）。アクティビティバー左下のボタンは
// アクティビティバーが作られる前に登録する必要があるので、ここでの読み込みに頼る
import './contrib/fileTransfer/electron-browser/paradisFileTransfer.contribution.js';
import './contrib/paradisSettings/electron-browser/paradisSettingsDialog.contribution.js';
import './contrib/usageDashboard/electron-browser/paradisUsageDashboard.contribution.js';
import './contrib/ccusage/electron-browser/paradisCcusage.contribution.js';
import './contrib/rtk/electron-browser/paradisRtk.contribution.js';
import './contrib/sessionResume/electron-browser/paradisSessionResume.contribution.js';
import './contrib/agentActivity/electron-browser/paradisSessionIndex.contribution.js';
import './contrib/githubMetrics/electron-browser/paradisGithubMetrics.contribution.js';
import './contrib/codexTerminalTitle/electron-browser/paradisCodexTerminalTitle.contribution.js';
import './contrib/codexAccounts/electron-browser/paradisCodexAccounts.contribution.js';
import './contrib/agentLiveWindow/electron-browser/paradisAgentLiveWindow.contribution.js';
import './contrib/agentInsights/electron-browser/paradisAgentInsights.contribution.js';
import './contrib/browserLiveWindow/electron-browser/paradisBrowserLiveWindow.contribution.js';
import './contrib/browserZoomIndicator/electron-browser/paradisBrowserZoomIndicator.contribution.js';
import './contrib/browserDesignMode/electron-browser/paradisDesignMode.contribution.js';
import './contrib/healthBeacon/electron-browser/paradisHealthBeacon.contribution.js';
import './contrib/heapSnapshot/electron-browser/paradisHeapSnapshot.contribution.js';
import './contrib/resourceMonitor/electron-browser/paradisSystemUsage.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisRemoteDefaultWorkspace.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisRemoteAgentTunnel.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisRemoteAgentHooks.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentHooksSettings.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentHookReplay.contribution.js';
import './contrib/agentHookTrust/electron-browser/paradisCodexHookTrust.contribution.js';
import './contrib/agentModelCatalog/electron-browser/paradisAgentModelCatalog.contribution.js';
import './contrib/agentIde/electron-browser/paradisAgentIde.contribution.js';
import './contrib/scheduledRuns/electron-browser/paradisScheduledRuns.contribution.js';
import './contrib/skillsManager/electron-browser/paradisSkillsManager.contribution.js';
import { registerParadisRemoteTranscriptMirrorContribution } from './contrib/mobileRelay/electron-browser/paradisRemoteTranscriptMirror.contribution.js';

registerParadisRemoteTranscriptMirrorContribution();
import './contrib/remoteTerminals/electron-browser/paradisRemoteTerminalShutdown.contribution.js';
import './contrib/ptyDaemon/electron-browser/paradisPtyDaemonStatusBar.contribution.js';
import './contrib/ptyDaemon/electron-browser/paradisPtyDaemonShutdown.contribution.js';
import './contrib/updateTerminals/electron-browser/paradisUpdateTerminals.contribution.js';
import './contrib/updateTerminals/electron-browser/paradisStaleRemoteServer.contribution.js';
import './contrib/ptyDaemon/electron-browser/paradisTerminalScreens.contribution.js';
import './contrib/terminalCloseCleanup/electron-browser/paradisTerminalCloseCleanupQuit.contribution.js';
import './contrib/terminalRenderer/electron-browser/paradisRenderRepair.contribution.js';
import './contrib/terminalIme/browser/paradisTerminalImeInputGate.contribution.js';
import './contrib/unfocusedDimming/electron-browser/paradisUnfocusedDimming.contribution.js';
import './contrib/terminalResumeBanner/electron-browser/paradisTerminalResumeBanner.contribution.js';
import './contrib/agentChat/electron-browser/paradisAgentChat.contribution.js';
import './contrib/claudeMod/electron-browser/paradisClaudeModConfigDir.contribution.js';
import './contrib/computerUse/electron-browser/paradisComputerUseApproval.contribution.js';
import './contrib/computerUse/electron-browser/paradisComputerUseStatus.contribution.js';
import './contrib/agentTabTitle/electron-browser/paradisClaudeTabTitlePin.contribution.js';
