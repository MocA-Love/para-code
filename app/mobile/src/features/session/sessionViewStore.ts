// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { secureKeyStore } from '../../platform.js';
import {
	normalizeSessionViewOverrides,
	withSessionViewOverride,
	type SessionView,
	type SessionViewOverrides,
} from './sessionViewMode.js';

/**
 * タブごとの表示の上書き（`sessionViewMode.ts`）の読み書きと保存。ほかの端末ローカルの設定と同じく
 * `secureKeyStore` に JSON で置く。端末ごとの既定は `features/settings/onboardingStore.ts` が持つ。
 *
 * 読み込みは最初に使われたときに1回だけ行う（起動時の負荷に足さない）。読み込みの前に
 * 切り替えられた場合は、読み込んだ値にその切り替えを重ねて保存し直す。
 */

const STORAGE_KEY = 'sessionViewOverrides';

type Edit = (overrides: SessionViewOverrides) => SessionViewOverrides;

interface SessionViewOverrideStore {
	readonly overrides: SessionViewOverrides;
	readonly loaded: boolean;
	/** タブの表示を決める（`key` は `sessionViewKey(pcId, terminalKey)`、`defaultView` はいまの既定）。 */
	setTabView(key: string, view: SessionView, defaultView: SessionView): void;
}

/** 読み込み前に行われた変更（読み込んだ値に重ねる）。 */
let pendingEdits: Edit[] = [];
let loadStarted = false;

function save(overrides: SessionViewOverrides): void {
	secureKeyStore.setItem(STORAGE_KEY, JSON.stringify(overrides)).catch((err: unknown) => {
		console.warn('[sessionView] failed to save', err);
	});
}

export const useSessionViewOverrides = create<SessionViewOverrideStore>((set, get) => ({
	overrides: {},
	loaded: false,
	setTabView(key, view, defaultView) {
		const edit: Edit = overrides => withSessionViewOverride(overrides, key, view, defaultView);
		const next = edit(get().overrides);
		set({ overrides: next });
		if (get().loaded) {
			save(next);
		} else {
			pendingEdits.push(edit);
		}
	},
}));

/** 保存値を1回だけ読み込む。何度呼んでもよい。 */
export function ensureSessionViewOverridesLoaded(): void {
	if (loadStarted) {
		return;
	}
	loadStarted = true;
	secureKeyStore.getItem(STORAGE_KEY)
		.then(raw => {
			try {
				return normalizeSessionViewOverrides(raw !== null ? JSON.parse(raw) : undefined);
			} catch {
				return {};
			}
		})
		.catch((err: unknown): SessionViewOverrides => {
			console.warn('[sessionView] failed to load', err);
			return {};
		})
		.then(stored => {
			const edits = pendingEdits;
			pendingEdits = [];
			const next = edits.reduce((overrides, edit) => edit(overrides), stored);
			useSessionViewOverrides.setState({ overrides: next, loaded: true });
			if (edits.length > 0) {
				save(next);
			}
		});
}
