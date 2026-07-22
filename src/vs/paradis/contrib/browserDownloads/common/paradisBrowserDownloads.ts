/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのダウンロード自動保存機能（paradis.browser.downloads.*）の設定キー・共有定数。

export const PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY = 'paradis.browser.downloads.enabled';
export const PARADIS_BROWSER_DOWNLOADS_PATH_KEY = 'paradis.browser.downloads.path';

/** カスタムパス未指定時に OS 標準のダウンロードフォルダ配下へ作るサブフォルダ名。 */
export const PARADIS_BROWSER_DOWNLOADS_DEFAULT_SUBFOLDER = 'Paracode';
