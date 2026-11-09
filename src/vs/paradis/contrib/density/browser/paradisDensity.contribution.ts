/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の部品が共有する寸法（2 段の行・ポップオーバーの見出し・タイトルバーの文字の項目・メニューの行・チップの文字・
// S の箱の本文の上）と、fork の浮く部品の重なりの段（モーダル・小窓・画面から拾う覆い）の CSS 変数を読み込む。
// 値は vs/paradis/browser/media/paradisDensity.css の 1 か所にある（段の表は vs/paradis/browser/paradisModal.ts）。

import '../../../browser/media/paradisDensity.css';
