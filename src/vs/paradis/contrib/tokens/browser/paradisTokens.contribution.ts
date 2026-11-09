/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの土台（段 0、Q596）を読み込む。寸法（角丸・高さ）・動き・フォーカスの枠の太さ・重なりの段と、fork の部品が
// 共有する寸法（2 段の行・ポップオーバーの見出しなど）は vs/paradis/browser/media/paradisTokens.css の 1 か所、
// 色は paradis.* のテーマの色（vs/paradis/common/paradisColors.ts）にある。重なりの段の表は vs/paradis/browser/paradisModal.ts。

import '../../../browser/media/paradisTokens.css';
import '../../../common/paradisColors.js';
