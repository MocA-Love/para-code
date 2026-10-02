// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { NativeAesGcmModule } from '../../src/nativeAesGcm.js';

/**
 * CryptoKit の AES-256-GCM（`ios/ParaAesGcmModule.swift`）。同期の `open` / `seal` を持つ。
 *
 * このモジュールを含まない古いバイナリ（JS だけ更新された場合）と Android では `null`。そのときは
 * `@para/protocol` の既定（@noble/ciphers）のまま動く。登録は `src/nativeAesGcm.ts` の `installNativeAesGcm`。
 */
export const nativeAesGcmModule: NativeAesGcmModule | null =
	Platform.OS === 'ios' ? requireOptionalNativeModule<NativeAesGcmModule>('ParaAesGcm') : null;
