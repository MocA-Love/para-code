/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルへ送る文字列から、打鍵として解釈される制御文字を落とす。改行だけは複数行の指示のために残す。
 *
 * エージェントの起動コマンドのプロンプト（利用者・エージェント（MCP）・定期実行の定義から来る）と、
 * MCP の `send_terminal_input` の本文の両方がこれを通す。
 * - `\x03`（割り込み）や `\x15`（行の消去）が入ると行が捨てられ、後ろが別のコマンドとして動く
 * - ESC を通すと貼り付けの終わりの印（`ESC [201~`）を偽造できる
 * - タブはシェルの補完や Claude Code の質問画面の「次の質問へ」に食われる（空白4つにする）
 */
export function paradisStripTerminalControlCharacters(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/\t/g, '    ')
		// C0 制御文字（改行を除く）・DEL・C1 制御文字
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}
