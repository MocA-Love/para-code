/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウ透過機能（paradis.window.transparency.*）の設定キー・共有定数。
// 透過対応が必要な他のparadis機能（例: fileViewers のwebview背景）からも参照される。

export const PARADIS_TRANSPARENCY_ENABLED_KEY = 'paradis.window.transparency.enabled';
export const PARADIS_TRANSPARENCY_OPACITY_KEY = 'paradis.window.transparency.opacity';

/** 透過が実際に有効なとき `.monaco-workbench` に付与されるCSSクラス。 */
export const PARADIS_TRANSPARENT_CLASS = 'paradis-transparent';

/** 背景が透けすぎて前景の可読性が失われないための下限。設定値がこれを下回る場合はクランプする。 */
export const PARADIS_TRANSPARENCY_MIN_OPACITY = 0.3;
export const PARADIS_TRANSPARENCY_MAX_OPACITY = 1;
export const PARADIS_TRANSPARENCY_DEFAULT_OPACITY = 0.9;

/**
 * 設定から読んだ opacity 値を有効範囲（0.3〜1）へクランプする。数値でない場合は既定値を返す。
 */
export function clampParadisTransparencyOpacity(raw: number | undefined): number {
	const value = typeof raw === 'number' && !isNaN(raw) ? raw : PARADIS_TRANSPARENCY_DEFAULT_OPACITY;
	return Math.min(PARADIS_TRANSPARENCY_MAX_OPACITY, Math.max(PARADIS_TRANSPARENCY_MIN_OPACITY, value));
}
