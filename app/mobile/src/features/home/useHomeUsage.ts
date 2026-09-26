// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import type { RateLimitsResult } from '../../store.js';
import { todayCost } from '../../usageFormat.js';

/** ホームの使用量（いま見ている PC の値）。 */
export interface HomeUsage {
	/** Claude / Codex の利用上限（5時間・7日）。取れるまで undefined。 */
	readonly limits: RateLimitsResult | undefined;
	/** 今日のコスト（ccusage）。取れるまで undefined。 */
	readonly cost: number | undefined;
}

/**
 * ホームが前面に来るたびに、いま見ている PC から利用上限と今日のコストを取る（既存の
 * `rateLimits` / `usageDashboard`。PC 側がキャッシュを持つので、開くたびに取っても重くない）。
 *
 * 応答が前後したとき・途中で PC を切り替えたときに古い応答で上書きしないよう、最後に投げた要求で、
 * かつ投げたときと同じ PC のものだけを採用する（旧「使用量」画面と同じ決まり）。
 */
export function useHomeUsage(): HomeUsage {
	const { rateLimits, usageDashboard, connection, pcOnline, activePcId } = useAppStore(useShallow(s => ({
		rateLimits: s.rateLimits, usageDashboard: s.usageDashboard, connection: s.connection, pcOnline: s.pcOnline, activePcId: s.activePcId,
	})));
	const [usage, setUsage] = useState<{ readonly pcId: string | undefined; readonly limits?: RateLimitsResult; readonly cost?: number }>({ pcId: undefined });
	const seq = useRef(0);
	const online = connection === 'online' && pcOnline;
	useFocusEffect(useCallback(() => {
		if (!online) {
			return;
		}
		const mine = ++seq.current;
		const pcAtStart = activePcId;
		const stillCurrent = () => mine === seq.current && useAppStore.getState().activePcId === pcAtStart;
		rateLimits().then(limits => {
			if (stillCurrent()) {
				setUsage(prev => ({ ...(prev.pcId === pcAtStart ? prev : {}), pcId: pcAtStart, limits }));
			}
		}).catch(() => { /* 取れなければメーターを空のまま出す */ });
		usageDashboard().then(data => {
			if (stillCurrent()) {
				setUsage(prev => ({ ...(prev.pcId === pcAtStart ? prev : {}), pcId: pcAtStart, cost: todayCost(data, Date.now()) }));
			}
		}).catch(() => { /* 取れなければダッシュのまま */ });
	}, [online, activePcId, rateLimits, usageDashboard]));
	// 別の PC の値は見せない。
	return usage.pcId === activePcId ? { limits: usage.limits, cost: usage.cost } : { limits: undefined, cost: undefined };
}
