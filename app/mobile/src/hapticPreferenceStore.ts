// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { parseHapticsEnabled, serializeHapticsEnabled } from './hapticTokens.js';

/** 保存先（アプリでは Keychain の `secureKeyStore`。テストでは手書きの偽物）。 */
export interface HapticPreferenceStorage {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
}

export const HAPTICS_ENABLED_KEY = 'haptics-enabled';

export interface HapticPreferenceState {
	/** 読み込み前もオン（既定）。 */
	readonly enabled: boolean;
	readonly loaded: boolean;
	load(): Promise<void>;
	/** 切り替えて保存する。保存に失敗したら reject（元の値へ戻す）。 */
	setEnabled(enabled: boolean): Promise<void>;
}

/**
 * 「触覚フィードバック」の設定の入れ物を作る（アプリの 1 つは `hapticPreference.ts`）。
 *
 * 読み込みと切り替えは世代で突き合わせる。読み込みの途中で切り替えたら、遅れて届いた読み込みの結果（切り替える前の
 * 保存値）は捨てる。保存に失敗して戻すときも、その後にまた切り替えられていれば戻さない。
 */
export function createHapticPreferenceStore(storage: HapticPreferenceStorage) {
	let generation = 0;
	return create<HapticPreferenceState>((set, get) => ({
		enabled: true,
		loaded: false,
		async load() {
			if (get().loaded) {
				return;
			}
			const started = generation;
			try {
				const raw = await storage.getItem(HAPTICS_ENABLED_KEY);
				if (started !== generation) {
					return;
				}
				set({ enabled: parseHapticsEnabled(raw), loaded: true });
			} catch (error) {
				// Keychain がロック中などで読めないときは既定（オン）のまま。次に設定を開いたときに読み直す。
				console.warn('[haptics] failed to load the haptics preference', error);
			}
		},
		async setEnabled(enabled) {
			const mine = ++generation;
			const previous = get().enabled;
			set({ enabled });
			try {
				await storage.setItem(HAPTICS_ENABLED_KEY, serializeHapticsEnabled(enabled));
				if (mine === generation) {
					set({ loaded: true });
				}
			} catch (error) {
				if (mine === generation) {
					set({ enabled: previous });
				}
				throw error;
			}
		},
	}));
}
