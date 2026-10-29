/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）が出す窓（ツールバーのボタンのポップアップ、windows.create の小さな窓）の印。
// 拡張機能を読み込んだセッションの窓なので、そのセッションに登録した内蔵ブラウザの preload（preload-browserView.ts）も
// 動いてしまう。窓を作るときに renderer のコマンドラインへこの印を足し、preload はこれを見て何もしない（preload は束ねないので、
// 同じ文字を preload-browserView.ts の paradisIsBrowserExtensionWindowArgv にも書いてある。テストが一致を確かめる）
// （内蔵ブラウザのビューではないので、要素の選択・右クリック・`__vscode_helpers` などを出さない）。

/** 拡張機能の窓の renderer に足すコマンドラインの印（webPreferences.additionalArguments）。 */
export const PARADIS_BROWSER_EXTENSION_WINDOW_SWITCH = '--paradis-browser-extension-window';
