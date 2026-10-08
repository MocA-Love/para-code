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

/** ticket の応答で名乗る取込の形式。接続先の aivis-mcp 2.5.0 は、これがあれば合成を受け取りながら chunked で送る。 */
export const PARADIS_REMOTE_VOICE_STREAM_INGRESS = 'stream-v1';

/**
 * 使わなかった音声 ticket を返す口（aivis-mcp 2.6）。ticket の応答に `release: true` を名乗ったときだけ使われる。
 * `Authorization: Bearer <ticket>` で、その ticket 1 枚を消す。
 */
export const PARADIS_MOBILE_VOICE_TICKET_RELEASE_PATH = '/paradis-mcp/mobile-voice-ticket/release';

/** chunked の取込で、要求のヘッダーを受けた時点で「手元で鳴らす」と引き受けたことを返す応答のヘッダー。 */
export const PARADIS_REMOTE_VOICE_ACCEPTED_HEADER = 'X-Para-Local-Playback';

const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/**
 * MP3 の先頭（ID3v2 タグがあれば飛ばす）にある最初のフレームのヘッダーから、ビットレート（kbps）と音声の
 * 始まる位置を読む。Layer III 以外・読み切れていない・壊れているときは undefined。届く速さ（実時間の何倍で
 * 届いているか）を見積もるのに使う。
 */
export function paradisMp3Bitrate(audio: Uint8Array): { readonly kbps: number; readonly offset: number } | undefined {
	let offset = 0;
	if (audio.byteLength >= 10 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) {
		const size = ((audio[6] & 0x7f) << 21) | ((audio[7] & 0x7f) << 14) | ((audio[8] & 0x7f) << 7) | (audio[9] & 0x7f);
		offset = 10 + size + ((audio[5] & 0x10) ? 10 : 0);
	}
	if (audio.byteLength < offset + 4 || audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0) {
		return undefined;
	}
	const versionBits = (audio[offset + 1] >> 3) & 0x03;
	const layerBits = (audio[offset + 1] >> 1) & 0x03;
	const bitrateIndex = (audio[offset + 2] >> 4) & 0x0f;
	if (versionBits === 0x01 || layerBits !== 0x01 || bitrateIndex === 0 || bitrateIndex === 0x0f) {
		return undefined;
	}
	const kbps = (versionBits === 0x03 ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[bitrateIndex];
	return kbps ? { kbps, offset } : undefined;
}

/** 接続先の aivis-mcp が、合成した声とモデルを名乗る要求のヘッダー（`provider:voice:model`、音量の表の鍵）。 */
export const PARADIS_REMOTE_VOICE_GAIN_KEY_HEADER = 'X-Para-Gain-Key';
/** 感情タグ入りの発話の印（値 `1`）。音量の覚え直しに使わない（aivis-mcp 2.5.1 の docs/ingest-protocol.md）。 */
export const PARADIS_REMOTE_VOICE_TAGGED_HEADER = 'X-Para-Tagged';
/**
 * 接続先で `aivis --mute` 中の発話の印（値 `1`）。ticket に `muteAware: true` を載せた Para Code にだけ付く。手元では
 * 鳴らさず、モバイルへだけ届ける（Q209 B）。
 */
export const PARADIS_REMOTE_VOICE_MUTED_HEADER = 'X-Para-Muted';

/** 要求のヘッダーの値を音量の表の鍵として読む。形が違えば undefined（表の補正は 0dB）。 */
export function paradisRemoteVoiceGainKey(value: string | string[] | undefined): string | undefined {
	if (typeof value !== 'string' || value.length > 300) {
		return undefined;
	}
	return /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,128}:[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}
