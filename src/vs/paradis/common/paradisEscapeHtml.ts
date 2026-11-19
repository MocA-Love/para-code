/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * HTML の本文と、二重引用符で囲んだ属性値に入れる文字列のエスケープ（`&`・`<`・`>`・`"`）。
 * 一重引用符は替えない（一重引用符で囲んだ属性値には使わない）。`vs/base/common/strings.ts` の `escape` は引用符を扱わない。
 */
export function paradisEscapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
