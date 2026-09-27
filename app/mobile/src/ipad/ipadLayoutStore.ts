// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { secureKeyStore } from '../platform.js';
import { DOCK_DEFAULT_WIDTH, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from './ipadLayout.js';

/**
 * iPad の2列の幅（左の列とドック）。ドラッグの間は `set*` で画面だけ動かし、離したときに `commit` で保存する
 * （Keychain へ毎フレーム書かないため）。左の列を隠すかどうかは既存の `sidebarCollapsed`（`appState.ts`。
 * ブラウザのタブの「広く見る」と同じ値）を使う。
 */

const STORAGE_KEY = 'ipadColumns';

interface IpadLayoutStore {
	readonly sidebarWidth: number;
	readonly dockWidth: number;
	load(): void;
	setSidebarWidth(width: number): void;
	setDockWidth(width: number): void;
	/** いまの幅を保存する（ドラッグを離したとき）。 */
	commit(): void;
}

let loadStarted = false;

function clampDockSaved(width: number): number {
	return Number.isFinite(width) ? Math.round(Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, width))) : DOCK_DEFAULT_WIDTH;
}

export const useIpadLayout = create<IpadLayoutStore>()((set, get) => ({
	sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
	dockWidth: DOCK_DEFAULT_WIDTH,
	load() {
		if (loadStarted) {
			return;
		}
		loadStarted = true;
		secureKeyStore.getItem(STORAGE_KEY).then(raw => {
			if (raw === null) {
				return;
			}
			try {
				const parsed = JSON.parse(raw) as { sidebarWidth?: unknown; dockWidth?: unknown };
				set({
					sidebarWidth: typeof parsed.sidebarWidth === 'number' ? clampSidebarWidth(parsed.sidebarWidth) : SIDEBAR_DEFAULT_WIDTH,
					dockWidth: typeof parsed.dockWidth === 'number' ? clampDockSaved(parsed.dockWidth) : DOCK_DEFAULT_WIDTH,
				});
			} catch {
				// 壊れた保存値は既定のまま使う。
			}
		}).catch((err: unknown) => {
			loadStarted = false;
			console.warn('[ipadLayout] failed to load', err);
		});
	},
	setSidebarWidth(width) {
		set({ sidebarWidth: clampSidebarWidth(width) });
	},
	setDockWidth(width) {
		set({ dockWidth: clampDockSaved(width) });
	},
	commit() {
		const { sidebarWidth, dockWidth } = get();
		secureKeyStore.setItem(STORAGE_KEY, JSON.stringify({ sidebarWidth, dockWidth })).catch((err: unknown) => console.warn('[ipadLayout] failed to save', err));
	},
}));
