// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeModuleShape {
	isSupported(): boolean;
	activate(): Promise<void>;
	deactivate(): Promise<void>;
	enqueueClip(base64: string): Promise<void>;
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

/** PCから届いたMP3（base64）を再生キューへ積む。到着順に1本ずつ鳴らす。 */
export async function enqueueVoiceClip(base64: string): Promise<void> {
	await native?.enqueueClip(base64);
}

/** ロック画面またはコントロールセンターの停止操作を購読する。 */
export function onVoiceSessionRemoteStop(listener: () => void): () => void {
	const subscription = native?.addListener('onRemoteStop', listener);
	return () => subscription?.remove();
}
