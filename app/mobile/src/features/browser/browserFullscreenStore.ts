// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { BROWSER_FULLSCREEN_OFF, nextBrowserFullscreen, type BrowserFullscreenEvent, type BrowserFullscreenState } from '../../browserFullscreen.js';
import type { AddressDisplayMode } from '../../browserAddress.js';
import { secureKeyStore } from '../../platform.js';

/**
 * ブラウザの全画面の印（アプリに 1 つ）。セッションの画面は、これが立っていてブラウザのタブを開いている間、
 * 見出しとタブの列を高さ 0 で隠す（木の形は変えない）。出し入れの決まりは `browserFullscreen.ts`。
 * 保存はしない（アプリを開き直したら全画面ではない）。
 */
interface BrowserFullscreenStore extends BrowserFullscreenState {
	dispatch(event: BrowserFullscreenEvent): void;
}

export const useBrowserFullscreen = create<BrowserFullscreenStore>()((set, get) => ({
	...BROWSER_FULLSCREEN_OFF,
	dispatch(event) {
		const current = get();
		const next = nextBrowserFullscreen({ fullscreen: current.fullscreen, via: current.via }, event);
		if (next.fullscreen !== current.fullscreen || next.via !== current.via) {
			set(next);
		}
	},
}));

const ADDRESS_MODE_KEY = 'browserAddressMode';
let addressModeLoadStarted = false;

/**
 * アドレス欄に題名と URL のどちらを出すか（長押しで切り替え、端末に保存する）。既定は題名。
 */
interface BrowserAddressModeStore {
	readonly mode: AddressDisplayMode;
	load(): void;
	toggle(): void;
}

export const useBrowserAddressMode = create<BrowserAddressModeStore>()((set, get) => ({
	mode: 'title',
	load() {
		if (addressModeLoadStarted) {
			return;
		}
		addressModeLoadStarted = true;
		secureKeyStore.getItem(ADDRESS_MODE_KEY).then(raw => {
			if (raw === 'url' || raw === 'title') {
				set({ mode: raw });
			}
		}).catch(err => console.warn('[browser] failed to load the address display mode', err));
	},
	toggle() {
		const mode: AddressDisplayMode = get().mode === 'title' ? 'url' : 'title';
		set({ mode });
		secureKeyStore.setItem(ADDRESS_MODE_KEY, mode).catch(err => console.warn('[browser] failed to save the address display mode', err));
	},
}));
