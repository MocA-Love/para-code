// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { effectiveSessionView, useSessionViewPreference } from '../settings/onboardingStore.js';
import { resolveSessionView, sessionViewKey, type SessionView } from './sessionViewMode.js';
import { ensureSessionViewOverridesLoaded, useSessionViewOverrides } from './sessionViewStore.js';

/**
 * 開き方の設定（端末ごとの既定）とタブごとの上書きを読み込む。何度呼んでもよい。
 *
 * **起動時にルートレイアウトから呼ぶ。** セッション画面を開いたときに初めて読むと、コールドスタート
 * （通知から直接開いたときなど）で既定の会話表示を出した後にターミナル表示へ作り直すことになる。
 */
export function loadSessionViewSettings(): void {
	ensureSessionViewOverridesLoaded();
	void useSessionViewPreference.getState().load();
}

/** 開き方の設定と上書きを読み終えたか（読めなかった場合も含む）。 */
export function useSessionViewReady(): boolean {
	const preferenceSettled = useSessionViewPreference(s => s.settled);
	const overridesLoaded = useSessionViewOverrides(s => s.loaded);
	return preferenceSettled && overridesLoaded;
}

/**
 * エージェントのタブの表示（会話表示かターミナル表示か）を読み書きする。
 * 既定は端末ごとの設定（`useSessionViewPreference`）、タブごとの上書きは `useSessionViewOverrides`。
 * 読み込み（`loadSessionViewSettings`）は起動時に済ませてある前提で、ここでは読まない。
 * 読み終えたかは `useSessionViewReady()` で見る。
 */
export function useSessionView(pcId: string | undefined, terminalKey: string | undefined): {
	readonly view: SessionView;
	readonly setView: (view: SessionView) => void;
} {
	const defaultView = useSessionViewPreference(effectiveSessionView);
	const key = pcId !== undefined && terminalKey !== undefined ? sessionViewKey(pcId, terminalKey) : undefined;
	const view = useSessionViewOverrides(s => resolveSessionView(defaultView, s.overrides, key));
	const setTabView = useSessionViewOverrides(s => s.setTabView);
	return {
		view,
		setView: next => {
			if (key !== undefined) {
				setTabView(key, next, defaultView);
			}
		},
	};
}
