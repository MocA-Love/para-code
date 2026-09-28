/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルの scm / fs の新しい種類を受ける処理（`registerParadisMobileRequestHandler` を呼ぶファイル）を
// 副作用 import で並べる場所。1 種類 1 行で足す。並べるだけなので、担当どうしで衝突しても解消は機械的。
// 使い方は paradisMobileRequestHandlers.ts の先頭を参照。

import './paradisMobileDiffReviewRequests.js'; // 差分レビューの印・行のメモ・確認済みのステージ（W2-14 / W2-28）
import './paradisMobileOpenUrl.js';

export { };
