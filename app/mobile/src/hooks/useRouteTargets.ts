// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type PcSummary } from '../appState.js';
import {
	findPc,
	findSpace,
	pcRouteStatus,
	resolveSessionTab,
	spaceRouteStatus,
	spaceTerminals,
	type PcRouteStatus,
	type ResolvedSessionTab,
	type SpaceRouteStatus,
	type SpaceTerminal,
} from '../navigationTargets.js';
import { firstParam, parseSessionTab, type SessionTab } from '../routes.js';
import type { WorkspaceState } from '../store.js';

/**
 * ルート（`/pc/[pcId]/...`）の ID を、ストアのデータへ引き当てるフック。
 * 判定そのものは純関数（`src/navigationTargets.ts`）にあり、ここは購読と副作用だけを持つ。
 *
 * 購読の注意: PC から届く `workspace` 全体はエージェントの実行中に最大 10Hz で作り直される。
 * ここでは**必要な部分だけ**を選んで購読している（スペース1件・そのスペースのターミナルの並び）。
 * `workspaceIdentity.ts` が変わっていない要素の参照を据え置くので、中身が同じなら再描画されない。
 */

const NO_TERMINALS: SpaceTerminal[] = [];

type SearchParam = string | string[] | undefined;

export interface RoutePc {
	readonly pcId: string | undefined;
	readonly pc: PcSummary | undefined;
	readonly status: PcRouteStatus;
}

/**
 * ルートの PC。**画面が前面に来たとき、その PC がいま見ている PC でなければ切り替える**
 * （ストアが中身を持つのは見ている PC の分だけなので）。台帳に無い PC なら何もしない
 * （`status: 'unknown'` を見て「見つかりません」を出す）。
 */
export function useRoutePc(pcIdParam: SearchParam): RoutePc {
	const pcId = firstParam(pcIdParam);
	const { pcs, activePcId, switchPc } = useAppStore(useShallow(s => ({ pcs: s.pcs, activePcId: s.activePcId, switchPc: s.switchPc })));
	const status = pcRouteStatus(pcs, activePcId, pcId);
	useFocusEffect(useCallback(() => {
		if (status === 'inactive' && pcId !== undefined) {
			switchPc(pcId);
		}
	}, [status, pcId, switchPc]));
	return { pcId, pc: findPc(pcs, pcId), status };
}

export interface RouteSpace extends RoutePc {
	readonly spaceId: string | undefined;
	readonly space: WorkspaceState['workspaces'][number] | undefined;
	/** PC が切り替わるまでは `loading`。 */
	readonly spaceStatus: SpaceRouteStatus;
	/** このスペースのターミナル（エージェントを含む）。PC から届いた順。 */
	readonly terminals: readonly SpaceTerminal[];
}

/**
 * ルートの PC とスペース。画面が前面に来たとき、既存の選択（`selectedWs`）もこのスペースに合わせる
 * （旧来の部品やストアの操作が `selectedWs` を既定の対象にしているため）。
 */
export function useRouteSpace(pcIdParam: SearchParam, spaceIdParam: SearchParam): RouteSpace {
	const routePc = useRoutePc(pcIdParam);
	const spaceId = firstParam(spaceIdParam);
	const active = routePc.status === 'active';
	const space = useAppStore(s => (active ? findSpace(s.workspace, spaceId) : undefined));
	const spaceStatus = useAppStore(s => (active ? spaceRouteStatus(s.workspace, spaceId) : 'loading'));
	const terminals = useAppStore(useShallow(s => (active ? spaceTerminals(s.workspace, spaceId) : NO_TERMINALS)));
	const setSelectedWs = useAppStore(s => s.setSelectedWs);
	useFocusEffect(useCallback(() => {
		if (!active || spaceStatus !== 'ready' || spaceId === undefined) {
			return;
		}
		// setSelectedWs は選択中のターミナルも外すので、同じスペースなら呼ばない。
		if (useAppStore.getState().selectedWs !== spaceId) {
			setSelectedWs(spaceId);
		}
	}, [active, spaceStatus, spaceId, setSelectedWs]));
	return { ...routePc, spaceId, space, spaceStatus, terminals };
}

export interface SessionRoute extends RouteSpace {
	/** クエリで指定されたタブ（指定なしなら undefined）。 */
	readonly requestedTab: SessionTab | undefined;
	/** 実際に開くタブ（見つからない・読み込み中も含む）。 */
	readonly tab: ResolvedSessionTab;
	/** 「新しく開いた」印（`shouldHandleLatestEntry` に渡す）。 */
	readonly latest: string | undefined;
}

/**
 * セッション画面（`/pc/[pcId]/session/[spaceId]?tab=…&latest=…`）のルートを読む。
 * タブの切り替えは `router.setParams({ tab: encodeSessionTab(next) })` で行えば、戻る操作の履歴を
 * 増やさずにクエリだけが変わる。
 */
export function useSessionRoute(): SessionRoute {
	const params = useLocalSearchParams<{ pcId?: string; spaceId?: string; tab?: string; latest?: string }>();
	const route = useRouteSpace(params.pcId, params.spaceId);
	const requestedTab = parseSessionTab(params.tab);
	const active = route.status === 'active';
	const tab = useAppStore(useShallow((s): ResolvedSessionTab => (
		active ? resolveSessionTab(s.workspace, route.spaceId, requestedTab) : { status: 'loading' }
	)));
	return { ...route, requestedTab, tab, latest: firstParam(params.latest) };
}
