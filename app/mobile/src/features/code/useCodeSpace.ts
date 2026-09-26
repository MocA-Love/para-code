// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useAppStore } from '../../appState.js';
import { useRouteSpace } from '../../hooks/useRouteTargets.js';
import { useWorkspaceUnavailableReason } from '../../hooks/useWorkspaceUnavailableReason.js';
import { codeSpaceGate, rendererTargetOf, type CodeSpaceGate } from './spaceLink.js';

export interface CodeSpace {
	readonly pcId: string | undefined;
	readonly spaceId: string | undefined;
	readonly gate: CodeSpaceGate;
	/** スペース名とブランチ（一度表示できたら、接続が切れても最後の値を持ち続ける）。 */
	readonly name: string | undefined;
	readonly branch: string | undefined;
	/** PC へ要求を出すときのスペースの ID（表示できる状態のときだけ）。 */
	readonly wsId: string | undefined;
	/** 要求を出した先の PC 側ウィンドウ（出せないときは undefined）。応答の照合に使う。 */
	readonly rendererTarget: string | undefined;
	readonly live: boolean;
	/** 要求を出せない理由（出せるときは undefined）。琥珀のバナーに出す。 */
	readonly unavailable: string | undefined;
}

type SearchParam = string | string[] | undefined;

/**
 * ソース管理・差分・ファイルの画面の土台。ルートの PC とスペースを引き当て（PC の切り替えと
 * `selectedWs` の同期は `useRouteSpace` が行う）、要求を出せるかを決める。
 *
 * **ストアの `workspace` 全体は購読しない**（エージェントの実行中は最大 10Hz で作り直される）。
 * 購読するのは renderer の識別子（文字列）と、`useRouteSpace` が選んだスペース1件だけ。
 */
export function useCodeSpace(): CodeSpace {
	const params = useLocalSearchParams<{ pcId?: SearchParam; spaceId?: SearchParam }>();
	const route = useRouteSpace(params.pcId, params.spaceId);
	const readyNow = route.status === 'active' && route.spaceStatus === 'ready' && route.space !== undefined;
	const [everReady, setEverReady] = useState(false);
	const [label, setLabel] = useState<{ name: string; branch: string | undefined } | undefined>(undefined);
	if (readyNow && !everReady) {
		setEverReady(true);
	}
	if (readyNow && route.space !== undefined && (label?.name !== route.space.name || label.branch !== route.space.branch)) {
		setLabel({ name: route.space.name, branch: route.space.branch });
	}
	const gate = codeSpaceGate(route.status, route.spaceStatus, everReady || readyNow);
	const active = route.status === 'active';
	const wsId = gate === 'ready' ? route.spaceId : undefined;
	const rendererTarget = useAppStore(s => (active ? rendererTargetOf(s, wsId) : undefined));
	const reason = useWorkspaceUnavailableReason(wsId);
	const unavailable = rendererTarget !== undefined ? undefined : !active && gate === 'ready' ? 'PC を切り替えています' : reason ?? 'PC 側でこのスペースの画面を準備しています';
	return {
		pcId: route.pcId,
		spaceId: route.spaceId,
		gate,
		name: label?.name ?? route.space?.name,
		branch: label?.branch ?? route.space?.branch,
		wsId,
		rendererTarget,
		live: rendererTarget !== undefined,
		unavailable,
	};
}

/** いまの renderer の識別子（応答が返ったときに、要求を出した先と同じかを確かめる）。 */
export function currentRendererTarget(wsId: string | undefined): string | undefined {
	return rendererTargetOf(useAppStore.getState(), wsId);
}
