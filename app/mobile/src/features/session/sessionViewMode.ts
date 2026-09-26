// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { SessionView } from '../settings/onboardingPlan.js';

export type { SessionView };

/**
 * エージェントのタブを「会話表示」と「ターミナル表示」のどちらで見るか。
 *
 * - 端末ごとの既定: 「はじめて」の画面・設定で選ぶもの。持ち主は `features/settings/onboardingStore.ts`
 *   の `useSessionViewPreference`（ここでは受け取るだけ）
 * - タブごとの上書き: タブの長押しメニューで切り替えたもの。このファイルとストア（`sessionViewStore.ts`）が持つ
 *
 * 上書きは「その時点の既定と違う」ときだけ持つ。既定と同じ値へ戻したら消すので、あとで既定を
 * 変えたときに、触っていないタブは一緒に変わる。上書きの鍵は PC とターミナルの組
 * （`sessionViewKey`）。ターミナルが閉じても鍵は残るので、件数に上限を設けて古いものから捨てる。
 *
 * 画面から切り離した純関数にして、組み合わせをテストで固定する（`sessionViewMode.test.ts`）。
 */

export type SessionViewOverrides = Readonly<Record<string, SessionView>>;

/** 覚えておく上書きの上限。 */
export const MAX_SESSION_VIEW_OVERRIDES = 200;

/** 上書きの鍵。ターミナルの鍵は PC ごとの採番なので PC の ID と組にする。 */
export function sessionViewKey(pcId: string, terminalKey: string): string {
	return `${pcId}\n${terminalKey}`;
}

function isSessionView(value: unknown): value is SessionView {
	return value === 'chat' || value === 'terminal';
}

/** そのタブで使う表示。 */
export function resolveSessionView(defaultView: SessionView, overrides: SessionViewOverrides, key: string | undefined): SessionView {
	const override = key !== undefined ? overrides[key] : undefined;
	return override ?? defaultView;
}

/** 表示の反対側。 */
export function otherSessionView(view: SessionView): SessionView {
	return view === 'chat' ? 'terminal' : 'chat';
}

/**
 * タブの表示を決める。いまの既定と同じなら上書きを消す。
 * 上書きは末尾へ移し、上限を超えたら先頭（古いもの）から捨てる。
 */
export function withSessionViewOverride(overrides: SessionViewOverrides, key: string, view: SessionView, defaultView: SessionView): SessionViewOverrides {
	const entries = Object.entries(overrides).filter(([existing]) => existing !== key);
	if (view !== defaultView) {
		entries.push([key, view]);
	}
	return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_SESSION_VIEW_OVERRIDES)));
}

/** 保存値を読み戻す（壊れている項目は捨てる）。 */
export function normalizeSessionViewOverrides(stored: unknown): SessionViewOverrides {
	if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
		return {};
	}
	const entries = Object.entries(stored as Record<string, unknown>)
		.filter((entry): entry is [string, SessionView] => isSessionView(entry[1]));
	return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_SESSION_VIEW_OVERRIDES)));
}
