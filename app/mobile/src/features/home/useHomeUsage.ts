// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { useNow } from '../../time.js';
import { aggregateAccounts, hasAnyLimits, homeAccounts, todayCostTotal, type AggregatedAccount } from '../usage/usageAggregate.js';
import { USAGE_HOME_MAX_AGE_MS, useUsageAutoRefresh, useUsageOverview } from '../usage/usageStore.js';

/** ホームの使用量（全 PC の合計）。 */
export interface HomeUsage {
	/** Claude のアカウント（全 PC で束ね、カードに出す順に並べたもの。カードは先頭の数件だけ出す）。 */
	readonly claude: readonly AggregatedAccount[];
	readonly codex: readonly AggregatedAccount[];
	/** どこかの PC から上限を1度でも取れたか（取れるまでは「読み込み中」）。 */
	readonly anyLimits: boolean;
	/** 今日のコスト（今日取れた PC の合計）。どこからも取れていなければ undefined。 */
	readonly cost: number | undefined;
	/** 出どころ（PC・SSH の接続先）が2つ以上（アカウントに見えている PC のチップを添える）。 */
	readonly multiple: boolean;
}

const HOME_KINDS = ['limits', 'cost'] as const;
/** ホームは成功から 5 分は送り直さず、SSH の接続先は取らない（保存済みの値を合計に使う。取るのは使用量の画面だけ）。 */
const HOME_REFRESH = { maxAgeMs: USAGE_HOME_MAX_AGE_MS, includeSsh: false } as const;

/**
 * ホームが前面に来るたびに、全 PC（と SSH の接続先）から利用上限と今日のコストを取る（`usageStore.ts`。
 * PC 側がキャッシュを持つので、開くたびに取っても重くない）。
 *
 * カードは常に全 PC の合計: Claude / Codex はアカウントごとに束ね（同じアカウントを2台で使っても1行）、今日の
 * コストは今日取れた PC の分だけ足す。オフラインの PC は最後に取れた値を使う（7日まで）。
 */
export function useHomeUsage(): HomeUsage {
	const now = useNow();
	// ホームは CPU・メモリ・SSD を使わないので購読しない（揺れのたびに描き直さない）
	const overview = useUsageOverview({ resources: false });
	useUsageAutoRefresh(HOME_KINDS, undefined, HOME_REFRESH);
	return useMemo(() => {
		const entries = overview.entries;
		return {
			claude: homeAccounts(aggregateAccounts(entries, 'claude', now), now),
			codex: homeAccounts(aggregateAccounts(entries, 'codex', now), now),
			anyLimits: hasAnyLimits(entries),
			cost: todayCostTotal(entries, now),
			multiple: entries.length > 1,
		};
	}, [overview, now]);
}
