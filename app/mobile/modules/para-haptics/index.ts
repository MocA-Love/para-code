// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { HapticImpactStyle, HapticNotifyType, HapticPatternName, HapticPrepareKind } from '../../src/hapticTokens.js';

/**
 * 触覚のネイティブ（`ios/ParaHapticsModule.swift`）。どれも同期で、実際に鳴らすのは主スレッド。
 */
export interface ParaHapticsNative {
	/** 端末が触覚を鳴らせるか（iPad・シミュレータでは false）。 */
	readonly supportsHaptics: boolean;
	isLowPowerMode(): boolean;
	prepare(kind: HapticPrepareKind): void;
	selection(): void;
	impact(style: HapticImpactStyle, intensity: number): void;
	notify(type: HapticNotifyType): void;
	transient(intensity: number, sharpness: number): void;
	/** 名前のパターン（AHAP は Swift 側が持つ）。知らない名前は無視される。 */
	playPattern(name: HapticPatternName): void;
}

/**
 * このモジュールを含まない古いバイナリ（JS だけ更新された場合）と Android では `null`。そのときは
 * `src/haptics.ts` が expo-haptics で鳴らす。
 */
export const paraHapticsModule: ParaHapticsNative | null =
	Platform.OS === 'ios' ? requireOptionalNativeModule<ParaHapticsNative>('ParaHaptics') : null;
