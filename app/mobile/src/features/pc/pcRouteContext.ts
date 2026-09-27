// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { firstParam } from '../../routes.js';

/**
 * PC の中の画面（`app/pc/[pcId]/_layout.tsx` の中）が、どの PC の画面かを受け取るための文脈。
 *
 * 通知やホームの「再開」からセッションへ直接入ると、詳細の列の根（`index.tsx`）は `withAnchor` で下に
 * 敷かれるだけで、そのルートの引数には `pcId` が入らない。器（レイアウト）は自分の引数に必ず `pcId` を
 * 持っているので、ここから渡す。
 */
export const PcRouteContext = createContext<string | undefined>(undefined);

/** いまの PC の ID（器から渡されたもの。無ければルートの引数）。 */
export function usePcRouteId(): string | undefined {
	const fromLayout = useContext(PcRouteContext);
	const fromRoute = firstParam(useLocalSearchParams<{ pcId?: string | string[] }>().pcId);
	return fromLayout ?? fromRoute;
}
