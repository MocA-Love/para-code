// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 「はじめて」（`/onboarding`）で聞くことと、その答えの読み書きの形（純関数）。
 * 保存・読み込みは `onboardingStore.ts`、画面は `app/onboarding.tsx`。
 *
 * Orca の mobile-onboarding-plan と同じく、**まだ決めていないことだけ**を順に聞く:
 *  1. セッションの開き方（チャット UI かターミナルか）— 一度選べば二度と聞かない
 *  2. 通知の許可 — OS にまだ聞いていない（`undetermined`）うえ、ここで「あとで」を選んでいないときだけ
 *
 * どちらも決まっていれば空になり、画面は何も出さずにホームへ進む。出すのはペアリングが成立した直後
 * （`app/pair.tsx`）なので、ペアリングし直すたびに出ることはない。
 */

/** セッション（エージェントのタブ）を開くときの既定の表示。 */
export type SessionView = 'chat' | 'terminal';

/** まだ選んでいないときの既定（これまでのアプリと同じく、エージェントは会話の画面で開く）。 */
export const DEFAULT_SESSION_VIEW: SessionView = 'chat';

export type OnboardingStep = 'session-view' | 'notifications';

/** 聞く順（画面の進捗の点もこの順に並ぶ）。 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = ['session-view', 'notifications'];

/** OS の通知の許可の状態（expo-notifications の `PermissionStatus` と同じ3値）。 */
export type NotificationPermissionState = 'granted' | 'denied' | 'undetermined';

export interface OnboardingAnswers {
	/** セッションの開き方を一度でも選んだか。 */
	readonly sessionViewChosen: boolean;
	readonly notificationPermission: NotificationPermissionState;
	/** 「はじめて」の通知のページで、どちらかを選んだことがあるか（「あとで」を含む）。 */
	readonly notificationsAnswered: boolean;
}

/** まだ聞いていないことだけを、聞く順に返す。 */
export function onboardingSteps(answers: OnboardingAnswers): OnboardingStep[] {
	return ONBOARDING_STEPS.filter(step => (step === 'session-view'
		? !answers.sessionViewChosen
		: answers.notificationPermission === 'undetermined' && !answers.notificationsAnswered));
}

/** 保存しておいた開き方を読み戻す。知らない値・未保存は undefined（＝まだ選んでいない）。 */
export function parseSessionView(raw: string | null | undefined): SessionView | undefined {
	return raw === 'chat' || raw === 'terminal' ? raw : undefined;
}

/** expo-notifications の `status` を3値に揃える（知らない値は「まだ聞いていない」ではなく「拒否」側に倒す）。 */
export function normalizePermissionState(status: string | undefined): NotificationPermissionState {
	return status === 'granted' || status === 'undetermined' ? status : 'denied';
}

/**
 * `/onboarding?steps=…` で渡された聞くことを読み戻す（聞く順に並べ直し、重複・知らない値は捨てる）。
 * 渡されていない・読めるものが無ければ undefined（＝保存済みの答えから決める）。
 */
export function parseOnboardingSteps(raw: string | readonly string[] | undefined): OnboardingStep[] | undefined {
	const value = typeof raw === 'string' ? raw : raw?.[0];
	if (value === undefined || value.length === 0) {
		return undefined;
	}
	const requested = new Set(value.split(','));
	const steps = ONBOARDING_STEPS.filter(step => requested.has(step));
	return steps.length > 0 ? steps : undefined;
}
