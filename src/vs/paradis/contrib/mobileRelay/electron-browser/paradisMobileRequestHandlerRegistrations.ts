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
// 終わった会話の一覧・中身・再開（W2-29）
import './paradisMobileAgentSessions.js';
import './paradisMobileScmSyncRequests.js'; // push / fetch / pull・コミットの失敗からの立て直し・ファイルごとのステージ（W2-15）
import './paradisMobilePullRequestRequests.js'; // PR の状態・CI の失敗をエージェントへ・マージ（W2-36）
import './paradisMobileBookmarkRequests.js'; // ブラウザのブックマークバー（browser.bookmarks.v1）
import './paradisMobileFileAtRequests.js'; // 差分の画面の変更前・変更後の中身（scm.file-at.v1）
import './paradisMobileWordDiffRequests.js'; // 差分の画面の Word の差分（scm.word-diff.v1）
import './paradisMobileFileIconRequests.js'; // ファイルの一覧のアイコン（fs.icon-theme.v1）
import './paradisMobileAttachmentRequests.js'; // モバイルから上げた添付画像のサムネイルと原寸（fs.attachment.v1）
import './paradisMobileVoiceUsageRequests.js'; // 読み上げ（Aivis・ElevenLabs）の使用量（usage.voice.v1）
import './paradisMobileDoNotDisturbRequests.js'; // PC のおやすみモードの切り替え（notify.dnd-remote.v1）

export { };
