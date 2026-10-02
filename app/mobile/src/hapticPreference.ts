// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHapticPreferenceStore } from './hapticPreferenceStore.js';
import { secureKeyStore } from './platform.js';

/**
 * 「触覚フィードバック」の設定（オン / オフ、既定オン）。この端末の中だけの設定で、PC へは送らない。
 * 保存先はほかの端末ローカルの設定と同じ Keychain（`secureKeyStore`）。読み込みは起動時（`app/_layout.tsx`）。
 * 中身（読み込みと切り替えの突き合わせ）は `hapticPreferenceStore.ts`。
 */
export const useHapticPreference = createHapticPreferenceStore(secureKeyStore);
