// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { useNavigationContainerRef, useRouter } from 'expo-router';
import { useDetailColumn } from '../../ipad/detailColumn.js';
import type { RouteHref } from '../../routes.js';
import { pcTargetOf, planPcOpen, type NavStateLike } from './pcOpenPlan.js';

type Router = ReturnType<typeof useRouter>;
type NavigationContainer = ReturnType<typeof useNavigationContainerRef>;

/**
 * PC の外から PC の中の画面を開く（OS の通知のタップ・通知の一覧・起動中に届いたリンクの中継）。
 * どう開くかは `pcOpenPlan.ts` の規則で決める（同じ PC の器は1枚だけ・既にあればそこまで閉じて戻る）。
 *
 * - `focus`: いま前面の画面から開く
 * - `overlay`: ルートの Stack の一番上にいる呼び出し元の画面（通知の一覧・中継の画面）を閉じて開く
 *
 * 閉じる操作はその場で dispatch し、開く操作（`router.push`）は Expo Router の順番待ちに入れる。
 * 開く先はその時点の状態から決まるので、閉じた後の器の中へ入る。
 */
export function openPcRoute(router: Router, container: NavigationContainer, href: RouteHref, from: 'focus' | 'overlay'): void {
	const target = pcTargetOf(href);
	const root = container.isReady() ? container.getRootState() as unknown as NavStateLike | undefined : undefined;
	// 2列の間だけ、器の根が詳細の列を置いている（`detailColumn.ts`）。
	const twoColumn = useDetailColumn.getState().entries.length > 0;
	const plan = target !== undefined && root !== undefined ? planPcOpen(root, target, from, twoColumn) : { kind: 'new-stack' as const };
	if (plan.kind === 'new-stack') {
		// withAnchor: PC の中の Stack の根（1列では PC の画面、2列では「エージェントが開かれていません」）を下に敷く。
		if (from === 'focus') {
			router.push(href, { withAnchor: true });
		} else {
			router.replace(href, { withAnchor: true });
		}
		return;
	}
	if (plan.closeOverlay !== undefined) {
		container.dispatch({ type: 'POP', payload: { count: 1 }, target: plan.closeOverlay.rootKey });
	}
	if (plan.popPcs !== undefined) {
		container.dispatch({ type: 'POP', payload: { count: plan.popPcs.count }, target: plan.popPcs.stackKey });
	}
	if (plan.popInner !== undefined) {
		container.dispatch({ type: 'POP_TO_TOP', target: plan.popInner.stackKey });
	}
	if (plan.setParams !== undefined) {
		container.dispatch({ type: 'SET_PARAMS', payload: { params: plan.setParams.params }, source: plan.setParams.routeKey, target: plan.setParams.stackKey });
	}
	if (plan.push) {
		router.push(href, { withAnchor: true });
	}
}
