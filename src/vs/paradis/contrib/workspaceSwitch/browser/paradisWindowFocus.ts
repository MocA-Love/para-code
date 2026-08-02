/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mainWindow } from '../../../../base/browser/window.js';

/**
 * ワークベンチ本体のウィンドウ自身が見えていて、かつフォーカスされているか。
 *
 * エージェントの通知 (音 / OS通知 / Aivis) と、完了状態の自動既読はどちらも
 * 「ユーザーがそのターミナルを見ているか」で抑制する。ここで `IHostService.hasFocus`
 * を使うと、補助ウィンドウ (エディタを別ウィンドウに出したもの、エージェント・ライブ
 * ウィンドウ) にフォーカスがあるだけで「見ている」と判定されてしまう。とくにライブ
 * ウィンドウはサブモニターに出しっぱなしにする使い方をするため、そこにフォーカスが
 * 残っている間ずっと通知が消える。
 *
 * そのため本体ウィンドウの document で直接判定する。補助ウィンドウ側で作業している
 * 間は「本体は見ていない」とみなし、通知は鳴る。
 *
 * 完了 (review) の自動既読も同じ判定を共有する。ライブウィンドウで完了を見ている間は
 * 既読にならず、完了バッジは本体ウィンドウに戻るまで残る。これは承知のうえで、
 * 「見落としを防ぐために通知は必ず鳴らす」方を優先した選択 (2026-08-02 の判断)。
 * 既読化を先に進めると、その完了の通知そのものが発火しなくなる。
 */
export function paradisIsWorkbenchWindowFocused(): boolean {
	return !mainWindow.document.hidden && mainWindow.document.hasFocus();
}
