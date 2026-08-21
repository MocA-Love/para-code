/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML プレビューを配るローカルサーバの、renderer と shared process で共有する定義。

/** workbench(renderer) ⇔ shared process のチャネル名。 */
export const PARADIS_HTML_PREVIEW_CHANNEL = 'paradisHtmlPreview';

export interface IParadisHtmlPreviewService {
	/**
	 * フォルダーをローカルサーバに載せ、その中身を指す base URL（末尾は `/`）を返す。
	 * 同じフォルダーを何度渡しても同じ URL を返す。
	 */
	mount(directory: string): Promise<string>;
}
