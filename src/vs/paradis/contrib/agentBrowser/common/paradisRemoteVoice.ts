/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先で aivis-mcp が読み上げた音声を、手元の PC で鳴らす（Q190〜Q193）。
// 接続先の aivis-mcp は戻り経路（ssh -R）越しに MP3 を Para Code へ送り、Para Code は手元の
// aivis-mcp（`--play-audio`）のキューへ積む。手元の発話と重ならず、ミュートも aivis 側で効く。

/** 接続先の読み上げを手元で鳴らすか。既定はオン。 */
export const PARADIS_REMOTE_VOICE_LOCAL_PLAYBACK_SETTING = 'paradis.voice.playRemoteLocally';

/** `--play-audio` を持つ aivis-mcp の最小の版。 */
export const PARADIS_AIVIS_PLAY_AUDIO_MIN_VERSION: readonly [number, number, number] = [2, 4, 0];

/** 設定値を解釈する。明示的に false のときだけオフ。 */
export function paradisRemoteVoiceLocalPlaybackEnabled(value: unknown): boolean {
	return value !== false;
}

/**
 * `aivis-mcp --version` の出力（`aivis-mcp v2.4.0`）が `--play-audio` を持つ版か。
 * 読めない出力は持たないものとして扱う（古い版は `--play-audio` を知らず、MCP サーバーとして
 * 標準入力を待ち続けてしまうため、呼ぶ前に必ず確かめる）。
 */
export function paradisAivisSupportsPlayAudio(versionOutput: string): boolean {
	const match = /v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/.exec(versionOutput);
	if (!match?.groups) {
		return false;
	}
	const actual = [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)];
	for (let i = 0; i < 3; i++) {
		if (actual[i] !== PARADIS_AIVIS_PLAY_AUDIO_MIN_VERSION[i]) {
			return actual[i] > PARADIS_AIVIS_PLAY_AUDIO_MIN_VERSION[i];
		}
	}
	return true;
}

/**
 * MP3 らしい先頭か（ID3 タグか MPEG フレームの同期ビット）。接続先から届いた任意のバイト列を、
 * 手元のデコーダ（ffplay・mpv・afplay）へそのまま渡さないための入口の確認。
 */
export function paradisLooksLikeMp3(audio: Uint8Array): boolean {
	if (audio.byteLength < 4) {
		return false;
	}
	if (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) {
		return true;
	}
	return audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
}
