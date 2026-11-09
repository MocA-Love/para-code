/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 4（Q600）のタブ。高さ 32、選んだものは文字を強くして下に 2px のアクセントの線。
//
// 包んでいる本家のファイル: 無し（base に汎用のタブの部品が無い）。役目（tablist・tab・tabpanel・aria-selected）と
// 矢印キー・Home・End の移動は、置く側の画面が持つ（統合のモーダルは paradisHubDialog.ts）。ここは見た目のクラスだけ。

import './media/paradisTabs.css';

/** タブを並べる入れ物のクラス。 */
export const PARADIS_TABS_CLASS = 'paradis-tabs';

/** 1 つのタブ（`button role="tab"`）に付けるクラス。キーボードのフォーカスは内側の青い枠。 */
export function paradisTabClasses(): string[] {
	return ['paradis-tab', 'paradis-focus-ring-inset'];
}
