/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「設定 (Para Code)」ダイアログが今このウィンドウで開いているか。
//
// 設定を切り替えたときに通知を出す機能は、ダイアログの中で切り替えられた場合は通知を出さず、
// ダイアログの行の中で知らせる。通知の層（z-index）はダイアログの背景より下にあり、ダイアログを
// 開いたままだと裏に隠れて「元に戻す」が押せないため。層の順序そのものは他のダイアログや
// モーダルとの重なりに関わるので変えない。
//
// 状態はウィンドウ（renderer）ごと。設定の変化は全ウィンドウに届くが、通知を出すのはフォーカスの
// あるウィンドウだけなので、そのウィンドウの中だけを見ればよい。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

let openDialogCount = 0;

/** ダイアログが開いたことを記録する。戻り値を dispose すると閉じたことになる（2回目以降は何もしない）。 */
export function paradisMarkSettingsDialogOpen(): IDisposable {
	openDialogCount++;
	return toDisposable(() => openDialogCount--);
}

/** このウィンドウで「設定 (Para Code)」ダイアログが開いているか。 */
export function paradisIsSettingsDialogOpen(): boolean {
	return openDialogCount > 0;
}
