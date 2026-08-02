/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Shift+Enter を改行 (ESC+CR) として送る設定。エージェント・ライブウィンドウのミラーも
 * 同じ設定を見るため、contribution 本体ではなくここに置いて副作用なしで参照できるようにする。
 */
export const PARADIS_TERMINAL_SHIFT_ENTER_SETTING = 'paradis.terminal.shiftEnterNewline';
