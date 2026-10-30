/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのページ（ウェブのページも拡張機能のページも、その子のフレームも）に、画面の取得の求めを許さない（P9e）。
// Electron 43.7.7 では、getDisplayMedia と、生の画面 id を渡す getUserMedia（chromeMediaSource: 'desktop'）は、どちらも機器の
// 種類の無い 'media' の求めとして権限の受け手に届き、区別できない。getUserMedia の方は setDisplayMediaRequestHandler も通らない
// （2026-10-30 に実測）。upstream の判定は種類の無い 'media' をカメラとマイクの両方として扱うので、カメラとマイクを許したページは
// 画面の id を当てるだけで画面全体を撮れる。内蔵ブラウザのセッションには setDisplayMediaRequestHandler が無く、画面の取得は
// どのページにも要らないので、種類の無い 'media' と display-capture は、求めたページ・フレームに関わらず断る。
// カメラ・マイク（種類のある 'media'）は upstream の判定のまま。

/** 画面の取得の求めか（内蔵ブラウザでは断る）。 */
export function paradisIsDisplayMediaRequest(permission: string, mediaKinds: readonly string[] | undefined): boolean {
	return permission === 'display-capture' || (permission === 'media' && (mediaKinds ?? []).length === 0);
}
