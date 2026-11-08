/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 組み立てるスクリプトへ値を入れるための小さな補助。どの層からも読めるように何も import しない。

/**
 * 文字列を、組み立てるスクリプトの中に置く JavaScript の文字列リテラルにする。
 *
 * `JSON.stringify` の結果はそのまま JavaScript の式として読めるが、`<script>` の中に置くと `</script>` や `<!--` で
 * 閉じられうる。`<`・`>` と、古い実行環境で行の終わりと読まれる U+2028・U+2029 を `\u` の形に書き直す
 * （読んだときの値は `JSON.stringify` と同じ）。
 */
export function paradisScriptStringLiteral(value: string): string {
	return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
