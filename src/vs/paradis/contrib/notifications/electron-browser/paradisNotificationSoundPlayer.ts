/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 着信音の再生（renderer の HTMLAudioElement）。ビルトイン音源は FileAccess.asBrowserUri で直接
// 参照できる（upstream の accessibilitySignalService.ts と同じ手法、mp3もビルドでコピーされる）。
// カスタム音源は `~/.para-code/assets/ringtones/` に置かれたユーザーファイルのため、レンダラーから
// 直接file://参照はできず、shared process 経由でバイト列(base64)を取得してBlob URL化する。

import { FileAccess } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CUSTOM_RINGTONE_ID, getRingtoneFilename, isBuiltInRingtoneId, PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';

/** base64音声データをBlob URLへ変換する（workbench CSPの media-src には blob: を許可済み）。 */
export function base64ToBlobUrl(base64: string, mimeType: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/**
 * 着信音の解決 + 再生。設定ダイアログのプレビュー再生と、通知トリガーの実再生の両方から使う。
 */
export class ParadisNotificationSoundPlayer extends Disposable {

	private _currentAudio: HTMLAudioElement | undefined;
	private _currentBlobUrl: string | undefined;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	private async _resolveUrl(ringtoneId: string): Promise<{ url: string; revoke: boolean } | undefined> {
		if (ringtoneId === CUSTOM_RINGTONE_ID) {
			try {
				const result = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL)
					.call<{ base64: string; mimeType: string } | null>('readCustomAudioFile');
				if (!result) {
					return undefined;
				}
				return { url: base64ToBlobUrl(result.base64, result.mimeType), revoke: true };
			} catch (error) {
				this.logService.warn('[ParadisNotifications] failed to read custom audio', error);
				return undefined;
			}
		}
		if (isBuiltInRingtoneId(ringtoneId)) {
			const filename = getRingtoneFilename(ringtoneId);
			if (!filename) {
				return undefined;
			}
			return { url: FileAccess.asBrowserUri(`vs/paradis/contrib/notifications/browser/media/sounds/${filename}`).toString(true), revoke: false };
		}
		return undefined;
	}

	/** 再生中の音を止める（プレビューの再選択・通知の重複防止用）。 */
	stop(): void {
		if (this._currentAudio) {
			this._currentAudio.pause();
			this._currentAudio.src = '';
			this._currentAudio = undefined;
		}
		if (this._currentBlobUrl) {
			URL.revokeObjectURL(this._currentBlobUrl);
			this._currentBlobUrl = undefined;
		}
	}

	/** volume は 0-100。ringtoneId が解決できない場合は何もしない。 */
	async play(ringtoneId: string, volume: number): Promise<void> {
		this.stop();
		const resolved = await this._resolveUrl(ringtoneId);
		if (!resolved) {
			return;
		}
		const audio = new Audio(resolved.url);
		audio.volume = Math.max(0, Math.min(1, volume / 100));
		this._currentAudio = audio;
		if (resolved.revoke) {
			this._currentBlobUrl = resolved.url;
		}
		try {
			await audio.play();
		} catch (error) {
			this.logService.warn('[ParadisNotifications] failed to play sound', error);
		}
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
