/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// webview のページで、ホスト（webview の基盤の index.html）から届いたメッセージかを見分ける。
// 基盤はページの先頭で `window.parent = window`（`window.top`・`window.frameElement` も）に置き換える
// （webview/browser/pre/index.html の `_vscodeApiScript`）。そのため `event.source === window.parent` は
// ホストから届いたメッセージでも成り立たず、届いた文書や本文を必ず捨てる。本物の親のフレームは、
// 子のフレームの一覧に自分の window を持つので、送り主の子の一覧に自分がいるかで見分ける（`length` と
// 番号での参照は、送り主が別のオリジンでも読める）。

/**
 * ページの `<script>` に埋める関数式。`(e) => boolean` で、`e` が本物の親のフレームから届いた
 * `message` イベントなら true。自分自身・自分の中の iframe・それ以外から届いたものは false。
 */
export const PARADIS_WEBVIEW_HOST_MESSAGE_CHECK = `(function(e){var s=e&&e.source;if(!s||s===window){return false;}try{for(var i=0;i<s.length;i++){if(s[i]===window){return true;}}}catch(err){}return false;})`;
