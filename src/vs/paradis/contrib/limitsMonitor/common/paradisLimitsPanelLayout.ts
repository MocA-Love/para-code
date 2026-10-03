/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネル（paradisLimitsMonitorPanel.ts）の幅・列数・左端の位置を、ウィンドウの幅とボタンの位置から
// 決める純関数。左に Claude、右に Codex の2列（800px）を基本にし、ウィンドウの左右の端からはみ出して
// 欠けないようにする。
//  1. 800px が入る: 800px の2列。ボタンの左端に揃え、右端からはみ出すなら左へ押し戻す
//  2. 800px は入らないが 2列の最小幅（640px）は入る: ウィンドウの幅いっぱい（左右の余白を除く）の2列
//  3. それも入らない: 400px（入らなければウィンドウの幅いっぱい）の1列（Claude の下に Codex）

/** 2列のときの幅（CSS の `.paradis-limits-panel` の width と揃える）。 */
export const PARADIS_LIMITS_PANEL_TWO_COLUMN_WIDTH = 800;
/** 1列のときの幅。 */
export const PARADIS_LIMITS_PANEL_ONE_COLUMN_WIDTH = 400;
/** 2列にする最小の幅（1列あたり 320px）。これより狭いと1列にする。 */
export const PARADIS_LIMITS_PANEL_MIN_TWO_COLUMN_WIDTH = 640;
/** ウィンドウの端との間に空ける余白。 */
export const PARADIS_LIMITS_PANEL_MARGIN = 8;
/** どんなに狭いウィンドウでも、これより細くはしない（その場合だけ右端が欠けうる）。 */
const MIN_WIDTH = 200;

export interface IParadisLimitsPanelLayout {
	readonly left: number;
	readonly width: number;
	readonly columns: 1 | 2;
}

/**
 * @param anchorLeft パネルを開いたボタンの左端（ウィンドウの左端からの px）
 * @param viewportWidth ウィンドウの幅（px）
 */
export function paradisLimitsPanelLayout(anchorLeft: number, viewportWidth: number): IParadisLimitsPanelLayout {
	const margin = PARADIS_LIMITS_PANEL_MARGIN;
	const available = Math.max(0, viewportWidth - margin * 2);
	let width: number;
	let columns: 1 | 2;
	if (available >= PARADIS_LIMITS_PANEL_TWO_COLUMN_WIDTH) {
		width = PARADIS_LIMITS_PANEL_TWO_COLUMN_WIDTH;
		columns = 2;
	} else if (available >= PARADIS_LIMITS_PANEL_MIN_TWO_COLUMN_WIDTH) {
		width = available;
		columns = 2;
	} else {
		width = Math.max(MIN_WIDTH, Math.min(PARADIS_LIMITS_PANEL_ONE_COLUMN_WIDTH, available));
		columns = 1;
	}
	// 右端からはみ出すなら左へ押し戻し、左端の余白より左へは出さない。
	const left = Math.max(margin, Math.min(anchorLeft, viewportWidth - width - margin));
	return { left: Math.round(left), width: Math.round(width), columns };
}
