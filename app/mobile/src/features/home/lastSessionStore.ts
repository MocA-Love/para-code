// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { secureKeyStore } from '../../platform.js';
import { parseLastSession, sameLastSession, type LastSession } from './lastSession.js';

/**
 * ホームの「再開」カードの記録（最後に開いたセッション）を持つストア。端末に保存し、次に起動しても残す。
 *
 * 記録するのはセッションを開く導線（PC の画面の行・ホームの再開）。セッション画面の側でも
 * 開いたときに `record` を呼べば、通知から入った場合も含めて記録が追いつく。
 */

/** 保存先のキー（`homeListPreferences` と同じく secureKeyStore に置く）。 */
const STORAGE_KEY = 'lastOpenedSession';

interface LastSessionStore {
	readonly value: LastSession | undefined;
	readonly loaded: boolean;
	/** 保存された値を読む（2回目以降は何もしない）。 */
	load(): void;
	record(next: Omit<LastSession, 'at'>): void;
	/** 指している PC のペアリングを解除したときなどに消す。 */
	clear(): void;
}

let loadStarted = false;

export const useLastSession = create<LastSessionStore>()((set, get) => ({
	value: undefined,
	loaded: false,
	load() {
		if (loadStarted) {
			return;
		}
		loadStarted = true;
		secureKeyStore.getItem(STORAGE_KEY).then(raw => {
			// 読み込み中に新しく記録されていれば、そちらを残す。
			if (get().value !== undefined) {
				set({ loaded: true });
				return;
			}
			let parsed: unknown;
			try {
				parsed = raw !== null ? JSON.parse(raw) as unknown : undefined;
			} catch {
				parsed = undefined;
			}
			set({ value: parseLastSession(parsed), loaded: true });
		}).catch((err: unknown) => {
			loadStarted = false;
			console.warn('[lastSession] failed to load', err);
			set({ loaded: true });
		});
	},
	record(next) {
		// 同じ中身なら書かない（開いている間の再描画のたびに Keychain へ書かないように）。
		if (sameLastSession(get().value, next)) {
			return;
		}
		const value: LastSession = { ...next, at: Date.now() };
		set({ value });
		secureKeyStore.setItem(STORAGE_KEY, JSON.stringify(value)).catch((err: unknown) => console.warn('[lastSession] failed to save', err));
	},
	clear() {
		set({ value: undefined });
		secureKeyStore.deleteItem(STORAGE_KEY).catch((err: unknown) => console.warn('[lastSession] failed to clear', err));
	},
}));
