/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのセッションの権限（browserSessionPermissions.ts）は getDisplayMedia を断る（Electron 43 では、getDisplayMedia は
// 機器の種類の無い 'media' の求めとして届き、カメラとマイクの両方の扱いになる。2026-10-30 に実測）。拡張機能の
// desktopCapture・tabCapture（P9e、vs/paradis/contrib/browserExtensions/electron-main/paradisBrowserExtensionCapture.ts）が
// 印を構えた拡張機能のページだけを通すための口。ここで通しても、撮る源はセッションの setDisplayMediaRequestHandler が印から決め、
// 当たらなければ断る（ここは「受け手まで届かせるか」だけ）。

type Gate = (requestingUrl: string) => boolean;

let gate: Gate | undefined;

/** 拡張機能の管理が、印を構えたページを通す判定を置く（外すときは undefined）。 */
export function paradisSetDisplayCaptureGate(next: Gate | undefined): void {
	gate = next;
}

/**
 * その権限の求めを、印を構えた拡張機能のページのものとして通すか。通すのは画面の取得の求めだけ（display-capture と、機器の種類の
 * 無い 'media'）。カメラ・マイク（種類のある 'media'）は通さない。
 */
export function paradisAllowsDisplayCapture(permission: string, requestingUrl: string | undefined, mediaKinds: readonly string[] | undefined): boolean {
	const displayOnly = permission === 'display-capture' || (permission === 'media' && (mediaKinds ?? []).length === 0);
	if (!displayOnly || !gate || typeof requestingUrl !== 'string' || !requestingUrl.startsWith('chrome-extension://')) {
		return false;
	}
	try {
		return gate(requestingUrl);
	} catch {
		return false;
	}
}
