/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルブラウザミラーの WebRTC 化 先行スパイク①: レンダラ側 PoC。
//
// コマンド `paradis.browserMirror.captureSpike` を実行すると、workbench レンダラで
// navigator.mediaDevices.getDisplayMedia() を呼ぶ。electron-main の
// setDisplayMediaRequestHandler（app.ts、PARA-PATCH）が env `PARADIS_MIRROR_CAPTURE_VIEW`
// で arm されていれば、画面全体ではなく内蔵ブラウザビュー(WebContentsView)単体の
// WebFrameMain が返り、その映像トラックが得られる。
//
// このコマンドは取得したストリームを video 要素に流し、トラック情報（解像度・settings・
// label）をコンソールとログに出す。本実装ではこのストリームを RTCPeerConnection に
// addTrack してモバイルへ送る（案3）。
//
// 検証手順（.claude/skills/launch の launch.sh + CDP）:
//   1. PARADIS_MIRROR_CAPTURE_VIEW=1 を付けて dev ビルドを起動
//   2. 内蔵ブラウザ（para-browser）を1つ開く
//   3. コマンドパレットから "Paradis: Browser Mirror Capture Spike" を実行
//   4. DevTools コンソール / ログで `[paradisBrowserMirrorSpike]` の出力を確認

import { localize2 } from '../../../../nls.js';
import { addDisposableListener, getActiveWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

class ParadisBrowserMirrorCaptureSpikeAction extends Action2 {

	static readonly ID = 'paradis.browserMirror.captureSpike';

	constructor() {
		super({
			id: ParadisBrowserMirrorCaptureSpikeAction.ID,
			title: localize2('paradis.browserMirror.captureSpike', 'Paradis: Browser Mirror Capture Spike'),
			// スパイク検証用の使い捨てコマンド。コマンドパレットには出さない（main 側が
			// PARADIS_MIRROR_CAPTURE_VIEW で arm されていない状態で誤実行すると、既存の
			// 画面キャプチャ経路へフォールバックして macOS の画面収録権限ダイアログが出得るため）。
			// 検証時は launch.sh + CDP から executeCommand で起動する。
			f1: false
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const logService = accessor.get(ILogService);
		const notificationService = accessor.get(INotificationService);
		const store = new DisposableStore();

		const targetWindow = getActiveWindow();
		const mediaDevices = targetWindow.navigator.mediaDevices;
		if (!mediaDevices?.getDisplayMedia) {
			const msg = 'getDisplayMedia is unavailable in this renderer';
			logService.error(`[paradisBrowserMirrorSpike] ${msg}`);
			notificationService.notify({ severity: Severity.Error, message: `Browser Mirror Spike: ${msg}` });
			return;
		}

		let stream: MediaStream | undefined;
		try {
			stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
		} catch (err) {
			logService.error('[paradisBrowserMirrorSpike] getDisplayMedia failed', err);
			notificationService.notify({ severity: Severity.Error, message: `Browser Mirror Spike: getDisplayMedia failed — ${err}` });
			return;
		}

		const [track] = stream.getVideoTracks();
		if (!track) {
			logService.error('[paradisBrowserMirrorSpike] no video track in stream');
			notificationService.notify({ severity: Severity.Error, message: 'Browser Mirror Spike: no video track' });
			stream.getTracks().forEach(t => t.stop());
			return;
		}

		const settings = track.getSettings();
		const info = {
			label: track.label,
			readyState: track.readyState,
			width: settings.width,
			height: settings.height,
			frameRate: settings.frameRate,
			displaySurface: (settings as MediaTrackSettings & { displaySurface?: string }).displaySurface
		};
		logService.info(`[paradisBrowserMirrorSpike] track acquired ${JSON.stringify(info)}`);

		// video 要素に流して実解像度を確認（トラックの settings が空でも videoWidth で取れる）。
		const video = document.createElement('video');
		video.autoplay = true;
		video.muted = true;
		video.srcObject = stream;
		store.add(toDisposable(() => {
			video.srcObject = null;
			video.remove();
		}));
		store.add(addDisposableListener(video, 'loadedmetadata', () => {
			logService.info(`[paradisBrowserMirrorSpike] video metadata ${video.videoWidth}x${video.videoHeight}`);
			notificationService.notify({
				severity: Severity.Info,
				message: `Browser Mirror Spike: captured ${video.videoWidth}x${video.videoHeight} — track "${track.label}" (${info.displaySurface ?? 'unknown surface'})`
			});
		}));

		// スパイクなので数秒後に停止して後片付けする。
		const stopTimer = setTimeout(() => {
			stream?.getTracks().forEach(t => t.stop());
			store.dispose();
			logService.info('[paradisBrowserMirrorSpike] stream stopped, disposed');
		}, 8000);
		store.add(toDisposable(() => clearTimeout(stopTimer)));
	}
}

registerAction2(ParadisBrowserMirrorCaptureSpikeAction);
