/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** 長く隠れたままの内蔵ブラウザのタブを休ませる（凍結する）か。既定はオフ（裏で処理を進めるページや常時接続のページを止めないため）。 */
export const PARADIS_BROWSER_FREEZE_HIDDEN_TABS_SETTING = 'paradis.browser.freezeHiddenTabs';

/** 隠れてからこの時間がたったタブを休ませる。 */
export const PARADIS_BROWSER_FREEZE_AFTER_HIDDEN_MS = 30 * 60_000;
