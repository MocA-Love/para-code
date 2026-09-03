/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース色をタブ背景に対して見える明度へ寄せる部分だけを、テーマ・DOM・DI から切り離したもの。
// contribution 本体 (`paradisSpaceAccent.contribution.ts`) は色の取得と CSS 変数の配布に専念する。

import { Color } from '../../../../base/common/color.js';

/** タブ上端の色帯として成立させたい、タブ背景との最小コントラスト比。 */
export const PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO = 3;

/**
 * スペース色を、与えられたタブ背景すべてに対して見える明度へ寄せて返す。
 *
 * 色帯はアクティブタブ (`tab.activeBackground`) だけでなく選択中タブ (`tab.selectedBackground`) にも
 * 出るため、`backgrounds` にはその両方を（不透明化したうえで）渡す。コントラストが最も厳しい背景を
 * 基準に判定・調整することで、どちらのタブでも帯が沈まない色を選ぶ。
 *
 * @param accent スペースに設定された色。
 * @param backgrounds 帯が乗りうるタブ背景。空配列のときは調整できないので accent をそのまま返す。
 */
export function paradisAdjustSpaceAccent(accent: Color, backgrounds: readonly Color[]): Color {
	if (backgrounds.length === 0) {
		return accent;
	}
	const worstBg = backgrounds.reduce((worst, bg) =>
		bg.getContrastRatio(accent) < worst.getContrastRatio(accent) ? bg : worst);
	if (worstBg.getContrastRatio(accent) >= PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO) {
		return accent;
	}

	// 12色のパレットには背景に沈む暗い色 (slate 等) も混ざる。暗い背景では明るく、
	// 明るい背景では暗く寄せて、どのスペースでも色帯が見える状態を保つ。
	return worstBg.isLighter()
		? worstBg.reduceRelativeLuminace(accent, PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO)
		: worstBg.increaseRelativeLuminace(accent, PARADIS_SPACE_ACCENT_MIN_CONTRAST_RATIO);
}
