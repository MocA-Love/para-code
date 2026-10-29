/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）が出す窓（ツールバーのボタンのポップアップ、windows.create の小さな窓）か
// を、内蔵ブラウザの preload（preload-browserView.ts）が main に尋ねる channel。拡張機能のセッションの窓なので、
// そのセッションに登録した preload も動いてしまう。同じ拡張機能のページは 1 つのプロセスにまとまる（ポップアップと
// タブで開いたオプションのページが同じプロセスになる。Electron 43.7.7 で実測）ので、プロセスではなく窓ごとに尋ねる。
// 答えは main が窓を作るときに付ける印（paradisBrowserExtensionWindows.ts）。preload は束ねないので、同じ文字を
// preload-browserView.ts の PARADIS_BROWSER_EXTENSION_WINDOW_QUERY にも書いてある。テストが一致を確かめる。

/** 拡張機能の窓かを尋ねる同期の IPC の channel（答えは true / false）。 */
export const PARADIS_BROWSER_EXTENSION_WINDOW_CHANNEL = 'paradis:browserExtensionWindow';
