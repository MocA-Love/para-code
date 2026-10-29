/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDP ゲートウェイで、ブラウザ拡張のものをエージェントから隠すための判定。
//
// 拡張は共有したページの中に 2 つの形で入り込む（Electron 43.7.7 で実測、2026-10-29）:
//  - 拡張のページを入れた iframe（パスワード管理のページ内メニューなど）。別プロセスの iframe なので、
//    共有したページのセッションに `Target.attachedToTarget`（type: iframe、url: chrome-extension://…）で現れる
//  - content script の isolated world。`Runtime.executionContextCreated` で、name に拡張の名前、
//    origin に `chrome-extension://<id>` が入る。名前はエージェントが `Page.createIsolatedWorld` で同じ名前を
//    指定すれば揃えられるが、そうして作った world の origin はページの origin になる
// どちらも origin（URL）で見分ける。拡張の中へ入られると、拡張の UI を押したり、拡張の背景へ
// `chrome.runtime.sendMessage` で話しかけたりできてしまう。

/** 拡張のページ・拡張の world の URL / origin の接頭辞。 */
const BROWSER_EXTENSION_SCHEME_PREFIX = 'chrome-extension:';

/** URL か origin がブラウザ拡張のものか。文字列でなければ false。 */
export function paradisIsBrowserExtensionUrl(value: unknown): boolean {
	return typeof value === 'string' && value.trimStart().toLowerCase().startsWith(BROWSER_EXTENSION_SCHEME_PREFIX);
}
