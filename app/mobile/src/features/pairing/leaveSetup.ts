// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { useRouter } from 'expo-router';
import { useAppStore } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { useParaToast } from '../../paraToast.js';
import { routes } from '../../routes.js';
import { loadOnboardingSteps } from '../settings/onboardingStore.js';

type Router = ReturnType<typeof useRouter>;

/**
 * ペアリング・はじめての画面を抜けてホームへ戻る。下にホームが積まれていればそこまで畳み
 * （設定 → PC → ペアリング と来ても、戻る操作で読み取りの画面へ戻らないように）、
 * 無ければ（リンクからいきなり開いた）ホームに置き換える。
 */
export function leaveToHome(router: Router): void {
	if (router.canDismiss()) {
		router.dismissTo(routes.home());
	} else {
		router.replace(routes.home());
	}
}

/**
 * ペアリングが成立した後の行き先。まだ聞いていないこと（開き方・通知）があれば「はじめて」へ、
 * 無ければホームへ（モックの `pairDone`: ホームへ戻して「〜とペアリングしました」）。
 */
export async function continueAfterPairing(router: Router): Promise<void> {
	haptic('success');
	const state = useAppStore.getState();
	const pc = state.pcs.find(item => item.id === state.activePcId);
	useParaToast.getState().show({
		key: `paired:${pc?.id ?? ''}`,
		text: pc !== undefined ? `${pc.name} とペアリングしました` : 'ペアリングしました',
		icon: 'checkmark-circle-outline',
		tone: 'done',
	}, 2_500);
	const steps = await loadOnboardingSteps().catch(() => []);
	if (steps.length > 0) {
		router.replace(routes.onboarding());
		return;
	}
	leaveToHome(router);
}
