/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルブラウザミラーの WebRTC 化（設計「案3」）先行スパイク①: PC側キャプチャ。
//
// 目的: 内蔵ブラウザ（WebContentsView）"単体"の映像を、ウィンドウ全体ではなく
// WebRTC 映像トラックとして取り出せるかを検証する。
//
// Electron 42 の API 経路:
//   session.setDisplayMediaRequestHandler((request, callback) => callback({ video: frame }))
// の `Streams.video` は `Video | WebFrameMain` を受け付ける（electron.d.ts 23411 付近）。
// WebFrameMain を渡すと「そのフレームだけ」をキャプチャできる（画面全体やウィンドウ全体
// ではなく、埋め込まれた WebContentsView の中身だけ）。対象は
// `browserView.webContents.mainFrame`。
//
// 本番実装では arm 対象を Chromium DevTools targetId で明示する。shared process 側の
// paradisMobileRelayService が `PARADIS_CDP_TARGET_CHANNEL` 経由で呼ぶ
// ParadisCdpTargetService.armMirrorCapture（electron-main）から paradisArmMirrorCapture が
// 呼ばれ、次の1回の getDisplayMedia に対して1回限り・TTL 15秒で arm する（期限切れ/対象
// 消失時は 'deny' を返しフェイルクローズ）。環境変数 `PARADIS_MIRROR_CAPTURE_VIEW` は上記の
// arm が無い場合のローカル検証用フォールバックで、立っている間は「最初に見つかった内蔵
// ブラウザビュー」のフレームを返す（既存の画面録画/スクショ機能に影響を与えないための env
// ゲート）。

import { webContents as electronWebContents, WebFrameMain } from 'electron';
import { BrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { PARADIS_MIRROR_CAPTURE_ENV, ParadisBrowserMirrorCapture } from './paradisBrowserMirrorCaptureCore.js';

export { PARADIS_MIRROR_CAPTURE_ENV };

const capture = new ParadisBrowserMirrorCapture({
	fromDevToolsTargetId: targetId => electronWebContents.fromDevToolsTargetId(targetId),
	getAllWebContents: () => electronWebContents.getAllWebContents(),
	isBrowserViewWebContents: webContents => BrowserViewMainService.isBrowserViewWebContents(webContents as Electron.WebContents),
});

/**
 * 指定 DevTools targetId の WebContentsView 単体キャプチャを次の1回の getDisplayMedia
 * に対して arm する（TTL 15秒、ワンショット）。shared process の paradisMobileRelayService
 * が `PARADIS_CDP_TARGET_CHANNEL` 経由で呼ぶ ParadisCdpTargetService.armMirrorCapture
 * （electron-main）から呼ばれる。
 */
export function paradisArmMirrorCapture(targetId: string): void {
	capture.arm(targetId);
}

/**
 * `setDisplayMediaRequestHandler` から呼ばれ、キャプチャ対象の WebFrameMain を返す。
 *
 * targetId で arm 済みの場合は DevTools targetId から解決し、期限切れや対象消失なら
 * 'deny' を返す（フェイルクローズ。画面全体キャプチャへのフォールバックを防ぐ）。
 * arm されておらず env `PARADIS_MIRROR_CAPTURE_VIEW` も未設定の場合は undefined を返し、
 * 呼び出し側（app.ts のハンドラ）は従来どおり画面全体キャプチャにフォールバックする。
 *
 * env のみが設定されている場合（ローカル検証用フォールバック）は「最初に見つかった
 * 内蔵ブラウザビュー」を対象にする。
 */
export function paradisResolveMirrorCaptureFrame(): WebFrameMain | 'deny' | undefined {
	return capture.resolve();
}
