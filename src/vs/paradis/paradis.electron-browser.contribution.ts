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

import './contrib/windowTransparency/electron-browser/paradisWindowTransparency.contribution.js';
import './contrib/agentBrowser/electron-browser/paradisAgentBrowser.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisBrowserScope.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisAgentStatus.contribution.js';
import './contrib/workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.js';
import './contrib/browserButton/electron-browser/paradisOpenBrowserButton.contribution.js';
import './contrib/notifications/electron-browser/paradisNotificationTrigger.contribution.js';
import './contrib/notifications/electron-browser/paradisNotificationSettingsDialog.contribution.js';
import './contrib/defaultExtensions/electron-browser/paradisDefaultExtensions.contribution.js';
import './contrib/fileViewers/electron-browser/paradisHtmlViewer.contribution.js';
import './contrib/fileViewers/electron-browser/paradisSpreadsheetViewer.contribution.js';
import './contrib/fileViewers/electron-browser/paradisPdfViewer.contribution.js';
import './contrib/fileViewers/electron-browser/paradisDocxViewer.contribution.js';
import './contrib/browserBookmarks/electron-browser/paradisBrowserBookmarks.contribution.js';
import './contrib/releaseNotes/electron-browser/paradisReleaseNotes.contribution.js';
import './contrib/keepAwake/electron-browser/paradisKeepAwake.contribution.js';
import './contrib/mobileRelay/electron-browser/paradisMobileRelay.contribution.js';
import './contrib/browserMirror/electron-browser/paradisBrowserMirrorSpike.contribution.js';
import './contrib/ccusage/electron-browser/paradisCcusage.contribution.js';
