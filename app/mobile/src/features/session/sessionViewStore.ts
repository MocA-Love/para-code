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
/**
 * 保存値を読めたか。読めていない間（Keychain がまだ開いていない起動直後など）は、変更を保存せずに
 * 積んでおき、次の変更のときに読み直す。読めないまま既定値で保存すると、保存済みの上書きを消してしまう。
 */
let persistReady = false;
/** 読み込みに失敗した後、変更が無くても読み直すまでの間（Keychain が開くのを待つ）。 */
const LOAD_RETRY_MS = 30_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

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
		if (persistReady) {
			save(next);
		} else {
			pendingEdits.push(edit);
			// 前の読み込みが失敗していれば読み直す（読めたら積んだ変更を重ねて保存する）。
			ensureSessionViewOverridesLoaded();
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
		.then(stored => {
			persistReady = true;
			const edits = pendingEdits;
			pendingEdits = [];
			const next = edits.reduce((overrides, edit) => edit(overrides), stored);
			useSessionViewOverrides.setState({ overrides: next, loaded: true });
			if (edits.length > 0) {
				save(next);
			}
		}, (err: unknown) => {
			// 読めなかった: 画面は既定のまま進める（loaded）が、保存はしない。次の変更か、少し待ってから読み直す。
			console.warn('[sessionView] failed to load', err);
			loadStarted = false;
			useSessionViewOverrides.setState({ loaded: true });
			if (retryTimer === undefined) {
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					ensureSessionViewOverridesLoaded();
				}, LOAD_RETRY_MS);
			}
		});
}
