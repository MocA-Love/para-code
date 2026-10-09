/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 読めなかった画像の代わりの箱。Word のサニタイザの代替表示と同じ見た目の、決まった SVG。
// renderer がサニタイザ全体を読み込まずに使えるよう、ここに置く（サニタイザも、この文を検査に通してから使う）。

export const PARADIS_OFFICE_BROKEN_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 48"><rect width="320" height="48" fill="#eeeeee"/><text x="8" y="28" fill="#000000">Office asset unavailable</text></svg>';

/** 代わりの箱の data URL。 */
export const PARADIS_OFFICE_BROKEN_IMAGE_HREF = `data:image/svg+xml;base64,${btoa(PARADIS_OFFICE_BROKEN_IMAGE_SVG)}`;
