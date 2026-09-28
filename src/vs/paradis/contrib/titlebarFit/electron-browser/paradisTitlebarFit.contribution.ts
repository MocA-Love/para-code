/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーに fork が足した部品 (左: CPU/RAM・リミット・サービス状態・ポート、右: エージェント一覧・
// ブラウザ一覧) を、狭いウィンドウでも中央のコマンドセンターに重ねないための配置規則。
// 部品ごとの CSS ではなくここに集めるのは、どれを先に畳むかという優先順位が部品をまたぐため。
import './media/paradisTitlebarFit.css';
