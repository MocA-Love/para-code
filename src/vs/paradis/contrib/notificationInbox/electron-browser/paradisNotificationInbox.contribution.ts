/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の受信箱（台帳・ベル・Dock の件数・メニューバーのアイコン）の入り口。
// paradis.electron-browser.contribution.ts からこのファイルだけを読み込む。

import '../browser/paradisNotificationInboxSettings.js';
import './paradisNotificationInboxService.js';
import './paradisNotificationInboxSync.contribution.js';
import './paradisNotificationInboxBell.contribution.js';
import './paradisNotificationInboxBadge.contribution.js';
