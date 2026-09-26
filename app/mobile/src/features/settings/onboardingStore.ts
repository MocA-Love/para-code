// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as Notifications from 'expo-notifications';
import { create } from 'zustand';
import { secureKeyStore } from '../../platform.js';
import {
	DEFAULT_SESSION_VIEW,
	normalizePermissionState,
	onboardingSteps,
	parseSessionView,
	type NotificationPermissionState,
	type OnboardingStep,
	type SessionView,
} from './onboardingPlan.js';

/**
 * 「はじめて」の答えの保存先（Keychain。ほかの端末ローカルの設定と同じ `secureKeyStore`）。
 * 形の判定は `onboardingPlan.ts`。
 */
const SESSION_VIEW_KEY = 'session-view-default';
const NOTIFICATIONS_ANSWERED_KEY = 'onboarding-notifications-answered';

interface SessionViewPreferenceState {
	/** 選んだ開き方。まだ選んでいない・読み込み前は undefined（使う側は `effectiveSessionView` で既定に倒す）。 */
	readonly chosen: SessionView | undefined;
	readonly loaded: boolean;
	/**
	 * 読み込みを1度試し終えたか（読めなかった場合も true）。セッション画面はこれが立つまで
	 * ペインを出さない（既定で会話表示を出してからターミナル表示に作り直すのを避ける）。
	 */
	readonly settled: boolean;
	load(): Promise<void>;
	/** 選んだ開き方を保存する。保存に失敗したら reject（はじめての画面は選び直してもらう）。 */
	save(view: SessionView): Promise<void>;
}

/**
 * セッションを開くときの既定の表示（チャット UI かターミナルか）。
 *
 * **セッション画面（段階4）はここを読む**: `useSessionViewPreference(s => effectiveSessionView(s))`。
 * 読み込みは起動時（ルートレイアウトの `loadSessionViewSettings`）に始める。セッション画面は
 * `settled` が立つまでペインを出さない。
 */
export const useSessionViewPreference = create<SessionViewPreferenceState>((set, get) => ({
	chosen: undefined,
	loaded: false,
	settled: false,
	async load() {
		if (get().loaded) {
			return;
		}
		try {
			const raw = await secureKeyStore.getItem(SESSION_VIEW_KEY);
			set({ chosen: parseSessionView(raw), loaded: true, settled: true });
		} catch (error) {
			// Keychain がロック中などで読めないときは、未選択のまま既定で動かす（次の画面で読み直す）。
			console.warn('[onboarding] failed to load the session view preference', error);
			set({ settled: true });
		}
	},
	async save(view) {
		await secureKeyStore.setItem(SESSION_VIEW_KEY, view);
		set({ chosen: view, loaded: true, settled: true });
	},
}));

/** 使う側が見る開き方（未選択なら既定）。 */
export function effectiveSessionView(state: Pick<SessionViewPreferenceState, 'chosen'>): SessionView {
	return state.chosen ?? DEFAULT_SESSION_VIEW;
}

/** OS の通知の許可の状態。読めなければ「拒否」扱い（はじめての画面で聞き直さない）。 */
export async function readNotificationPermission(): Promise<NotificationPermissionState> {
	try {
		const settings = await Notifications.getPermissionsAsync();
		return normalizePermissionState(settings.status);
	} catch {
		return 'denied';
	}
}

/** いま聞くべきこと（空ならはじめての画面は出さない）。 */
export async function loadOnboardingSteps(): Promise<OnboardingStep[]> {
	const store = useSessionViewPreference.getState();
	await store.load();
	const [notificationPermission, notificationsAnswered] = await Promise.all([
		readNotificationPermission(),
		secureKeyStore.getItem(NOTIFICATIONS_ANSWERED_KEY).then(raw => raw !== null).catch(() => true),
	]);
	return onboardingSteps({
		sessionViewChosen: useSessionViewPreference.getState().chosen !== undefined,
		notificationPermission,
		notificationsAnswered,
	});
}

/** はじめての通知のページでどちらかを選んだ（「あとで」を含む）ことを残す。 */
export async function markNotificationsAnswered(): Promise<void> {
	await secureKeyStore.setItem(NOTIFICATIONS_ANSWERED_KEY, '1');
}
