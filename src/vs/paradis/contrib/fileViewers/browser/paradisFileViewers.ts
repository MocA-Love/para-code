/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// .html / .md の「レンダリング表示」ビューア（Superset apps/desktop の FileViewerPane 相当）で
// 共有する識別子・拡張子の定義。browser 層（web/desktop 両対応）の Markdown ビューアと
// electron-browser 層の HTML ビューアの両方から参照される。

import { extname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

/** Markdown レンダリングビューアの EditorPane / EditorInput 識別子。 */
export const PARADIS_MARKDOWN_EDITOR_ID = 'paradis.editor.markdownPreview';
export const PARADIS_MARKDOWN_INPUT_TYPE_ID = 'paradis.input.markdownPreview';

/** HTML レンダリングビューアの EditorPane / EditorInput 識別子。 */
export const PARADIS_HTML_EDITOR_ID = 'paradis.editor.htmlPreview';
export const PARADIS_HTML_INPUT_TYPE_ID = 'paradis.input.htmlPreview';

/** MD/HTML ビューア共用のテキスト差分エディタ(共通ヘッダー + 標準 DiffEditorWidget 埋め込み)の識別子。 */
export const PARADIS_FILE_DIFF_EDITOR_ID = 'paradis.editor.fileViewerDiff';
export const PARADIS_FILE_DIFF_INPUT_TYPE_ID = 'paradis.input.fileViewerDiff';

/** Excel(スプレッドシート)ビューアの EditorPane / EditorInput 識別子。 */
export const PARADIS_SPREADSHEET_EDITOR_ID = 'paradis.editor.spreadsheet';
export const PARADIS_SPREADSHEET_INPUT_TYPE_ID = 'paradis.input.spreadsheet';
/** Excel 差分ビューアの EditorPane / EditorInput 識別子。 */
export const PARADIS_SPREADSHEET_DIFF_EDITOR_ID = 'paradis.editor.spreadsheetDiff';
export const PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID = 'paradis.input.spreadsheetDiff';

/** レンダリング表示の対象となる拡張子（すべて小文字・ドット付き）。 */
export const PARADIS_MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.markdown'];
export const PARADIS_HTML_EXTENSIONS: readonly string[] = ['.html', '.htm'];
// Excelビューア対象。exceljs は OOXML(.xlsx/.xlsm)のみ対応で、旧BIFF形式(.xls)は非対応のため含めない。
export const PARADIS_SPREADSHEET_EXTENSIONS: readonly string[] = ['.xlsx', '.xlsm'];

// EditorResolver には拡張子ごとに `*<ext>` 形式で個別登録する（ビルトインの Search Editor が
// `'*' + SEARCH_EDITOR_EXT` で登録しているのと同じ実績のある形。brace glob は使わない）。
// globMatchesResource は matchOnPath=false 経路で basename に対して大文字小文字無視でマッチする。
export function paradisGlobForExtension(ext: string): string {
	return `*${ext}`;
}

/** 与えられたリソースの拡張子が Markdown ビューア対象か。 */
export function isParadisMarkdownResource(resource: URI): boolean {
	return PARADIS_MARKDOWN_EXTENSIONS.includes(extname(resource).toLowerCase());
}

/** 与えられたリソースの拡張子が HTML ビューア対象か。 */
export function isParadisHtmlResource(resource: URI): boolean {
	return PARADIS_HTML_EXTENSIONS.includes(extname(resource).toLowerCase());
}

/** 与えられたリソースの拡張子が Excel ビューア対象か。 */
export function isParadisSpreadsheetResource(resource: URI): boolean {
	return PARADIS_SPREADSHEET_EXTENSIONS.includes(extname(resource).toLowerCase());
}
