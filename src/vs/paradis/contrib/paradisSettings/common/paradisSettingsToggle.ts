/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「設定 (Para Code)」のオン/オフの行と設定値の対応。
// 本家の `chat.disableAIFeatures` のように「true で止まる」設定を「使う」の行で見せるときは裏返す。

/** 設定値から、チェックを付けるか。裏返す行は、値が true のときだけオフにする。 */
export function paradisToggleChecked(value: unknown, inverted: boolean): boolean {
	return inverted ? value !== true : value === true;
}

/** チェックの状態から、書き込む設定値。裏返す行でも必ず真偽値を明示して書く（既定値に任せない）。 */
export function paradisToggleValue(checked: boolean, inverted: boolean): boolean {
	return inverted ? !checked : checked;
}
