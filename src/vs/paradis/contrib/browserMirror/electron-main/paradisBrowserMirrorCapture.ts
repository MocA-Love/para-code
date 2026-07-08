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
// 本番実装では arm 対象を viewId で明示（IBrowserViewMainService.tryGetBrowserView(id)）し、
// レンダラ→main の IPC チャネルで arm する。スパイクではその配線を省き、環境変数
// `PARADIS_MIRROR_CAPTURE_VIEW` が立っているときのみ「最初に見つかった内蔵ブラウザビュー」の
// フレームを返す（既存の画面録画/スクショ機能に影響を与えないための env ゲート）。

import { webContents as electronWebContents, WebFrameMain } from 'electron';
import { BrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';

/** スパイク用の env ゲート。値が truthy のときだけミラーキャプチャを arm する。 */
export const PARADIS_MIRROR_CAPTURE_ENV = 'PARADIS_MIRROR_CAPTURE_VIEW';

/**
 * 本実装の arm 状態（モバイルの webrtc-offer 受信時に shared process 経由で設定される）。
 * one-shot: resolve で消費する。TTL を過ぎた arm は無効（腐った arm が後続の無関係な
 * getDisplayMedia を乗っ取らないように）。
 */
let armedTargetId: string | undefined;
let armedExpiresAt = 0;
const ARM_TTL_MS = 15_000;

/**
 * 指定 DevTools targetId の WebContentsView 単体キャプチャを次の1回の getDisplayMedia
 * に対して arm する。shared process の ParadisCdpTargetService.armMirrorCapture から呼ばれる。
 */
export function paradisArmMirrorCapture(targetId: string): void {
	armedTargetId = targetId;
	armedExpiresAt = Date.now() + ARM_TTL_MS;
}

/**
 * `setDisplayMediaRequestHandler` から呼ばれ、キャプチャ対象の WebFrameMain を返す。
 *
 * arm されていない（env 未設定）場合や対象ビューが無い場合は undefined を返し、
 * 呼び出し側（app.ts のハンドラ）は従来どおり画面全体キャプチャにフォールバックする。
 *
 * スパイクでは「最初に見つかった内蔵ブラウザビュー」を対象にする。本番では viewId で
 * 明示解決する（下記コメント参照）。
 */
export function paradisResolveMirrorCaptureFrame(): WebFrameMain | 'deny' | undefined {
	// 本実装経路: webrtc-offer 起点の one-shot arm（targetId 明示）。
	// arm されていた要求は必ず fail-closed（frame か 'deny'）で返す。undefined で
	// 素通しすると呼び出し側が全画面キャプチャへフォールバックし、ブラウザビュー
	// 1枚のつもりがデスクトップ全体をモバイルへ配信してしまう（TTL失効・ビュー破棄・
	// 不正な targetId のいずれでも）。
	if (armedTargetId !== undefined) {
		const targetId = armedTargetId;
		const expired = Date.now() > armedExpiresAt;
		armedTargetId = undefined;
		if (expired) {
			return 'deny';
		}
		const wc = electronWebContents.fromDevToolsTargetId(targetId);
		if (wc && !wc.isDestroyed() && wc.mainFrame) {
			return wc.mainFrame;
		}
		return 'deny';
	}

	const spec = process.env[PARADIS_MIRROR_CAPTURE_ENV];
	if (!spec) {
		return undefined;
	}

	// 本番: browserViewMainService.tryGetBrowserView(spec)?.webContents.mainFrame で
	// viewId 明示解決する。スパイクでは列挙して最初の内蔵ブラウザビューを拾う。
	for (const wc of electronWebContents.getAllWebContents()) {
		if (wc.isDestroyed()) {
			continue;
		}
		if (BrowserViewMainService.isBrowserViewWebContents(wc)) {
			const frame = wc.mainFrame;
			// mainFrame は破棄済み webContents では null になり得る。
			return frame ?? undefined;
		}
	}

	return undefined;
}
