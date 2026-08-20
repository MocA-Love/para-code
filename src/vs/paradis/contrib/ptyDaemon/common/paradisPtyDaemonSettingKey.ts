/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの設定キー。
//
// 読む人が main・設定画面・ポップオーバーの3箇所に散るので、文字列はここ1箇所に置く。

/** 常駐を使うかどうか。既定は false（opt-in）。 */
export const PARADIS_PTY_DAEMON_ENABLED = 'paradis.terminal.daemon.enabled';
