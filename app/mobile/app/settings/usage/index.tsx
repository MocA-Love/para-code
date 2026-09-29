// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Activity, Cpu, Cuboid, GitPullRequest, Scissors, User } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../src/appState.js';
import { hapticSelection } from '../../../src/haptics.js';
import type { GithubUsageResult, RateLimitsResult, UsageDashboardResult } from '../../../src/store.js';
import { usagePercent } from '../../../src/systemResources.js';
import { colors, space, type } from '../../../src/theme.js';
import { useNow } from '../../../src/time.js';
import { staleValueLabel, todayCost, updatedAtLabel } from '../../../src/usageFormat.js';
import { Icon, ListGroup, ListRow, Meter, MeterRow, iconSize } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { settingsRoutes, type UsageDetailPage } from '../../../src/features/settings/settingsRoutes.js';
import { UsageHostPicker, useUsageHost } from '../../../src/features/settings/usageHost.js';
import { DetailMessage, DetailNotConnected, DetailRefreshButton } from '../../../src/features/settings/usageDetailParts.js';
import { ProviderUsageSection, UsageBigValue, UsageRow, UsageRowTitle, UsageSection } from '../../../src/features/settings/usageSections.js';
import { formatUsd, ratioPercent, recentDailyAverage, usageFootNote } from '../../../src/features/settings/usageSummary.js';

type SectionErrors = { limits?: string; cost?: string; github?: string };

function errorMessage(reason: unknown): string {
	return String(reason instanceof Error ? reason.message : reason);
}

const DETAIL_LINKS: readonly { readonly page: UsageDetailPage; readonly label: string; readonly hint: string; readonly icon: typeof Activity }[] = [
	{ page: 'cost', label: 'コスト', hint: 'トークンとコストを日別・モデル別に', icon: Activity },
	{ page: 'rtk', label: 'RTK の節約', hint: 'コマンドの出力から削ったトークン', icon: Scissors },
	{ page: 'github', label: 'GitHub API', hint: 'レート枠と、送ったリクエストの内訳', icon: GitPullRequest },
	{ page: 'system', label: 'システム', hint: 'CPU・メモリ・ディスクと、何が使っているか', icon: Cuboid },
];

/**
 * 使用量（`/settings/usage`。Orca の accounts、モックの「使用量」）。
 *
 * Claude / Codex のアカウントごとの 5時間・7日 のメーター（リセットまでの時間）、今日のコスト、
 * GitHub のレート枠、PC の CPU・メモリ・SSD を1画面にまとめ、下の行から詳しい画面へ進む。
 *
 * **データの取り方は旧「使用量」画面（`legacy-screens/(settings)/usage.tsx`）と同じ**（新しい種類の通信は足さない）:
 *  - 利用上限・コスト・GitHub の3つを並行して取る。応答が前後したとき・途中で PC を切り替えたときは古い応答を捨てる
 *  - 利用上限とコストは PC 側のキャッシュから返る。値は接続先ごとに持ち、切り替えて戻っても待たせない
 *  - CPU・メモリ・SSD は PC の状態に常に乗って届く値（ここからは問い合わせない）
 *  - 選んだ接続先が応答しないときは取得を止め、直近の値を薄く残す
 */
export default function UsageScreen() {
	const router = useRouter();
	// リセットまでの時間と「〜前に更新」を、開いたままでも進める
	const now = useNow();
	const { rateLimits, usageDashboard, githubUsage, connection, activePcId, pcs, resources } = useAppStore(useShallow(s => ({
		rateLimits: s.rateLimits,
		usageDashboard: s.usageDashboard,
		githubUsage: s.githubUsage,
		connection: s.connection,
		activePcId: s.activePcId,
		pcs: s.pcs,
		resources: s.workspace?.resources,
	})));
	const activePc = pcs.find(pc => pc.id === activePcId);
	const host = useUsageHost();
	const hostStale = host.stale;
	const hostKey = host.key;
	const windowId = host.selectedHost?.windowId;

	const [limitsByHost, setLimitsByHost] = useState<Record<string, RateLimitsResult>>({});
	const [costByHost, setCostByHost] = useState<Record<string, UsageDashboardResult>>({});
	const [github, setGithub] = useState<GithubUsageResult | undefined>(undefined);
	const limits = limitsByHost[hostKey];
	const cost = costByHost[hostKey];
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [errors, setErrors] = useState<SectionErrors>({});

	// PC を切り替えたら前の PC の値を捨てる（'local' / 'default' は PC をまたいで同じ鍵になるため）
	useEffect(() => {
		setLimitsByHost({});
		setCostByHost({});
		setGithub(undefined);
		setErrors({});
	}, [activePcId]);

	const requestSeq = useRef(0);
	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') {
			return;
		}
		const seq = ++requestSeq.current;
		const pcAtStart = activePcId;
		setLoading(true);
		try {
			const [limitsResult, costResult, githubResult] = await Promise.allSettled([
				hostStale ? Promise.resolve(undefined) : rateLimits(bypassCache, windowId),
				hostStale ? Promise.resolve(undefined) : usageDashboard(bypassCache, windowId),
				githubUsage(bypassCache),
			]);
			if (seq !== requestSeq.current || useAppStore.getState().activePcId !== pcAtStart) {
				return;
			}
			if (limitsResult.status === 'fulfilled' && limitsResult.value !== undefined) {
				const value = limitsResult.value;
				setLimitsByHost(prev => ({ ...prev, [hostKey]: value }));
			}
			if (costResult.status === 'fulfilled' && costResult.value !== undefined) {
				const value = costResult.value;
				setCostByHost(prev => ({ ...prev, [hostKey]: value }));
			}
			if (githubResult.status === 'fulfilled') {
				setGithub(githubResult.value);
			}
			setErrors({
				limits: limitsResult.status === 'rejected' ? errorMessage(limitsResult.reason) : undefined,
				cost: costResult.status === 'rejected' ? errorMessage(costResult.reason) : undefined,
				github: githubResult.status === 'rejected' ? errorMessage(githubResult.reason) : undefined,
			});
		} finally {
			if (seq === requestSeq.current) {
				setLoading(false);
			}
		}
	}, [rateLimits, usageDashboard, githubUsage, connection, activePcId, hostStale, hostKey, windowId]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	// 副題は「どの PC の、いつの値か」。複数の値のうち最も古い時刻を出す（新しい側を出すと古い値まで新しく読める）
	const fetchedTimes = [limits?.fetchedAt, cost?.fetchedAt].filter((t): t is number => t !== undefined);
	const oldestFetchedAt = fetchedTimes.length > 0 ? Math.min(...fetchedTimes) : undefined;
	const subtitle = [
		activePc?.name,
		oldestFetchedAt !== undefined ? updatedAtLabel(oldestFetchedAt, now) : undefined,
	].filter((part): part is string => part !== undefined).join(' · ') || undefined;

	const openDetail = (page: UsageDetailPage) => {
		hapticSelection();
		router.push(settingsRoutes.usageDetail(page));
	};

	const core = github?.rateLimits.find(entry => entry.resource === 'core');
	const graphql = github?.rateLimits.find(entry => entry.resource === 'graphql');
	const average = cost !== undefined ? recentDailyAverage(cost, now) : undefined;
	const memoryPercent = resources !== undefined ? usagePercent(resources.memUsed, resources.memTotal) : undefined;
	const diskPercent = resources?.diskTotal !== undefined && resources.diskFree !== undefined
		? usagePercent(resources.diskTotal - resources.diskFree, resources.diskTotal)
		: undefined;
	const notConnected = connection !== 'online' && limits === undefined && cost === undefined && github === undefined;

	return (
		<SettingsScreen
			title="使用量"
			subtitle={subtitle}
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing || loading || connection !== 'online'} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			{notConnected ? <DetailNotConnected /> : (
				<>
					<UsageHostPicker host={host} />
					{errors.limits !== undefined ? <DetailMessage tone="error">{errors.limits}</DetailMessage> : null}
					{limits !== undefined && hostStale ? <DetailMessage tone="note">{staleValueLabel(limits.fetchedAt, now)}</DetailMessage> : null}
					<ProviderUsageSection provider="claude" title="Claude" snapshot={limits?.claude} now={now} loading={loading} dimmed={hostStale} />
					<ProviderUsageSection provider="codex" title="Codex" snapshot={limits?.codex} now={now} loading={loading} dimmed={hostStale} />

					{errors.cost !== undefined ? <DetailMessage tone="error">{errors.cost}</DetailMessage> : null}
					<UsageSection title="今日のコスト" icon={Activity} onPress={() => openDetail('cost')} dimmed={hostStale}>
						<UsageRow trailing="chevron">
							<UsageBigValue>{cost !== undefined ? formatUsd(todayCost(cost, now)) : '—'}</UsageBigValue>
							<Text style={styles.small}>
								{cost === undefined
									? (loading ? '取得しています…' : 'まだ取得していません')
									: `${average !== undefined ? `7日平均 ${formatUsd(average)} · ` : ''}すべてのエージェントの合計`}
							</Text>
						</UsageRow>
					</UsageSection>

					{errors.github !== undefined ? <DetailMessage tone="error">{errors.github}</DetailMessage> : null}
					<UsageSection title="GitHub" icon={GitPullRequest} onPress={() => openDetail('github')}>
						<UsageRow trailing="chevron">
							{core !== undefined || graphql !== undefined ? (
								<MeterRow>
									<Meter label="REST" percent={core !== undefined ? ratioPercent(core.used, core.limit) : undefined} />
									<Meter label="GraphQL" percent={graphql !== undefined ? ratioPercent(graphql.used, graphql.limit) : undefined} />
								</MeterRow>
							) : (
								<UsageRowTitle title={github === undefined ? (loading ? '取得しています…' : 'まだ取得していません') : 'レート枠を取得できませんでした'} hint={github !== undefined && !github.ghAvailable ? 'PC に gh が見つかりません' : github?.rateLimitError} />
							)}
						</UsageRow>
					</UsageSection>

					<UsageSection title={`PC の状態${activePc !== undefined && pcs.length > 1 ? `（${activePc.name}）` : ''}`} icon={Cpu} onPress={() => openDetail('system')}>
						<UsageRow trailing="chevron">
							{resources !== undefined ? (
								<>
									<MeterRow>
										<Meter label="CPU" percent={resources.cpu} />
										<Meter label="メモリ" percent={memoryPercent} />
									</MeterRow>
									<MeterRow>
										<Meter label="SSD" percent={diskPercent} />
										<View style={styles.spacer} />
									</MeterRow>
								</>
							) : (
								<UsageRowTitle title="値が届いていません" hint="この PC からはリソースの値が届いていません（PC 側の更新で出るようになります）" />
							)}
						</UsageRow>
					</UsageSection>

					<GroupHeader title="詳しく見る" first />
					<ListGroup>
						{DETAIL_LINKS.map(link => (
							<ListRow key={link.page} icon={link.icon} label={link.label} hint={link.hint} trailing="chevron" onPress={() => openDetail(link.page)} />
						))}
					</ListGroup>

					<View style={styles.foot}>
						<Icon icon={User} size={iconSize.sm} color={colors.textMuted} />
						<Text style={styles.footText}>{usageFootNote(limits?.claude)}</Text>
					</View>
				</>
			)}
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	small: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	spacer: {
		flex: 1,
	},
	foot: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm,
		marginTop: space.xl,
		paddingHorizontal: space.xs,
	},
	footText: {
		flex: 1,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
});
