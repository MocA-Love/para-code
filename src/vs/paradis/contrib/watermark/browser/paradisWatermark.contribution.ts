/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 空のエディタグループのwatermark(トップページ)のスタイル上書きを読み込むだけのエントリ。
// 画像差し替え(letterpress → paradisWatermark.png)とクリック可能なエントリのスタイルを含む。
// エントリのクリック実行ロジック本体は editorGroupWatermark.ts 側のPARA-PATCH参照。

import './media/paradisWatermark.css';
