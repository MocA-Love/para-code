/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Paradis独自機能（通常ウィンドウ向け）の集約import入り口。
// ここに置けるのは web/desktop 両方の workbench で安全にロードできる contribution のみ
// （このファイルは workbench.common.main.ts 経由で desktop / web 両方から読み込まれるため）。
// Electron専用API（INativeHostService 経由の BrowserWindow 操作等）に依存する contribution は
// ここではなく paradis.electron-browser.contribution.ts に追加すること。

import './contrib/windowTransparency/browser/paradisSettings.contribution.js';
import './contrib/workspaceSwitch/browser/paradisWorkspaceSwitch.contribution.js';
import './contrib/notifications/browser/paradisNotificationsSettings.js';
