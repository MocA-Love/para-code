/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能のページ（chrome-extension://）に、画面の取得の求めを許さない（P9e）。Electron 43.7.7 では、getDisplayMedia と、
// 生の画面 id を渡す getUserMedia（chromeMediaSource: 'desktop'）は、どちらも機器の種類の無い 'media' の求めとして権限の受け手に
// 届き、区別できない。getUserMedia の方は setDisplayMediaRequestHandler も通らない（2026-10-30 に実測）。upstream の判定のままだと、
// 拡張機能の origin にカメラとマイクを許したあと、画面の id を当てるだけで画面全体を撮れるので、種類の無い 'media' と
// display-capture を拡張機能のページでは一切許さない。カメラ・マイク（種類のある 'media'）は upstream の判定のまま。

/** 拡張機能のページからの、画面の取得の求めか（断るべきなら true）。 */
export function paradisIsExtensionDisplayMediaRequest(permission: string, requestingUrl: string | undefined, mediaKinds: readonly string[] | undefined): boolean {
	const displayOnly = permission === 'display-capture' || (permission === 'media' && (mediaKinds ?? []).length === 0);
	return displayOnly && typeof requestingUrl === 'string' && requestingUrl.startsWith('chrome-extension://');
}
