// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 起動時に 1 回だけ読み込む（`index.ts`）。PC とのセッションのフレームの AES-GCM を、ネイティブ（CryptoKit）が
 * あればそちらへ切り替える。無ければ noble のまま。副作用のためだけのモジュール。
 */

import { nativeAesGcmModule } from '../modules/para-aes-gcm/index.js';
import { installNativeAesGcm } from './nativeAesGcm.js';
import { captureMobileException } from './sentry.js';

const result = installNativeAesGcm(nativeAesGcmModule);
if (result.backend === 'noble' && result.reason === 'self-check-failed') {
	// ネイティブがあるのに noble と食い違う。noble で動き続けるが、ビルドの問題なので知らせる。
	console.warn(`[Para Code] native AES-GCM disabled: ${result.detail ?? ''}`);
	captureMobileException('relay', 'nativeAesGcmSelfCheck', new Error('native AES-GCM self-check failed'), { safe_detail: result.detail });
}
