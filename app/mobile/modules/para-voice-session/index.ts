// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeModuleShape {
	isSupported(): boolean;
	activate(): Promise<void>;
	deactivate(): Promise<void>;
	enqueueClip(base64: string, gainDb: number): void;
	streamStart(streamId: string, gainDb: number): void;
	streamChunk(streamId: string, base64: string): void;
	streamEnd(streamId: string, aborted: boolean): void;
	playbackStats?(): Record<string, unknown>;
	addListener(eventName: 'onRemoteStop', listener: () => void): { remove(): void };
}

const native = requireOptionalNativeModule<NativeModuleShape>('ParaVoiceSession');

export function isVoiceSessionSupported(): boolean {
	return native?.isSupported() ?? false;
}

/** iOS の playback audio session とロック画面の停止操作を有効にする。 */
export async function activateVoiceSession(): Promise<void> {
	if (!native) {
		throw new Error('voice session unavailable in this build');
	}
	await native.activate();
}

/** 音声通知用のバックグラウンド再生状態を終了する。 */
export async function deactivateVoiceSession(): Promise<void> {
	await native?.deactivate();
}

/**
 * PCから届いた 1 本まるごとの MP3（base64）を再生の列へ積む。`gainDb` は -20 LUFS に揃える補正（上げる方向も可。
 * -1dBFS で頭打ち）。流れと同じ列で、始まった順に鳴らす。
 */
export function enqueueVoiceClip(base64: string, gainDb: number): void {
	native?.enqueueClip(base64, gainDb);
}

/** 流れを始める（voice.stream.v1）。500ms 以上溜まってから鳴らし始める。 */
export function startVoiceStream(streamId: string, gainDb: number): void {
	native?.streamStart(streamId, gainDb);
}

/** 流れの断片（MP3 の base64）を足す。知らない流れの断片は捨てられる。 */
export function appendVoiceStream(streamId: string, base64: string): void {
	native?.streamChunk(streamId, base64);
}

/** 流れを終える。鳴り始める前に `aborted` なら鳴らさない。 */
export function endVoiceStream(streamId: string, aborted: boolean): void {
	native?.streamEnd(streamId, aborted);
}

/** 開発ビルドの確かめ用: 溜めの閾値・途切れた回数など。 */
export function voicePlaybackStats(): Record<string, unknown> | undefined {
	return native?.playbackStats?.();
}

/** ロック画面またはコントロールセンターの停止操作を購読する。 */
export function onVoiceSessionRemoteStop(listener: () => void): () => void {
	const subscription = native?.addListener('onRemoteStop', listener);
	return () => subscription?.remove();
}
