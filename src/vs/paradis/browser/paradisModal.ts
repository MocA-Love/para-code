/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code のモーダルの箱の大きさの段（S・M・L）。各モーダルが自分の CSS に書いていた幅と高さを、この 3 段に寄せる。
//
// - S（確認・入力）: 幅 480（各モーダルが自分の CSS で 420〜560 の間に変えてよい）、高さは中身なり（上限 88vh）
// - M（文脈の作業）: 幅 880、高さ clamp(520px, 72vh, 820px) で固定（中の切り替えで高さを変えない）
// - L（領域を持つ画面）: 使用量の寸法。幅 clamp(1040px, 78vw, 2000px)、高さ clamp(726px, 88vh, 1400px)
//
// 箱の地・枠・角丸・影もここで揃える。背景の暗幕（backdrop）は各モーダルのまま（内蔵ブラウザの裏に隠れないよう
// `paradis-modal-backdrop` の印を付けるのも各モーダル）。

import './media/paradisModal.css';

export const enum ParadisModalSize {
	Small = 's',
	Medium = 'm',
	Large = 'l',
}

/** モーダルの箱に付けるクラス。`$('.my-dialog')` の要素に `classList.add(...paradisModalClasses(ParadisModalSize.Medium))` で付ける。 */
export function paradisModalClasses(size: ParadisModalSize): readonly string[] {
	return ['paradis-modal', `paradis-modal-${size}`];
}
