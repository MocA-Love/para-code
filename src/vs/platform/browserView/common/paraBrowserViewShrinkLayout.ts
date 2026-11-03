/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 拡大率で縮めるときの表示域（画面の px、整数）と拡大率。表示域を整数に丸めたままの倍率で縮めると、ページの表示域
 * （表示域 ÷ 拡大率）が表示サイズより 1 px ほど狭くなり（1600 が 1599.6 になる）、表示サイズちょうどのページが
 * はみ出す。はみ出しは初めは描かれないが、ページの外まで写す撮影の後などに通常のスクロールバーが出て、表示域が
 * 右と下でスクロールバーの分だけ狭くなる（Electron 43 で実測。右下の端の click_at が外れた）。そこで拡大率を、
 * 丸めた表示域が幅・高さとも表示サイズ以上になる値（丸めた表示域 ÷ 表示サイズ のうち小さい方）に合わせる。
 */
export function paraBrowserViewShrinkLayout(width: number, height: number, pageScale: number): { readonly viewSize: { readonly width: number; readonly height: number }; readonly zoom: number } {
	const viewSize = { width: Math.max(1, Math.round(width * pageScale)), height: Math.max(1, Math.round(height * pageScale)) };
	return { viewSize, zoom: Math.min(viewSize.width / width, viewSize.height / height) };
}
