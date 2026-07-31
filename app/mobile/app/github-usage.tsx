// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useTabBarSpacer } from '../src/hooks/useTabBarSpacer.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';
import { GITHUB_UNSCOPED_SPACE } from '../src/store.js';
import type { GithubCallCounts, GithubOperationStat, GithubSpaceStat, GithubUsageResult } from '../src/store.js';
import { useNow } from '../src/time.js';

/**
 * GitHub API利用状況画面。設定 →「GitHub API」から開く。
 * PC版のGitHub API Usageダッシュボード（githubMetrics）と同じスナップショットを閲覧専用で表示する。
 */

/** 内訳に出す行の表示上限件数。 */
const MAX_ROWS = 10;

type WindowKey = '5m' | '1h' | 'session';
type GroupKey = 'caller' | 'space';

function countsForWindow(stat: { session: GithubCallCounts; rolling5m: GithubCallCounts; rolling1h: GithubCallCounts }, windowKey: WindowKey): GithubCallCounts {
	switch (windowKey) {
		case '5m': return stat.rolling5m;
		case '1h': return stat.rolling1h;
		case 'session': return stat.session;
	}
}

function spaceLabel(space: string): string {
	return space === GITHUB_UNSCOPED_SPACE ? 'Agent Sessionsウィンドウ（worktree外）' : space;
}

function resourceLabel(resource: string): string {
	switch (resource) {
		case 'core': return 'REST';
		case 'graphql': return 'GraphQL';
		case 'search': return 'Search';
		default: return resource;
	}
}

interface CallerRow { key: string; name: string; sub: string; resource: 'core' | 'graphql'; value: number }
interface SpaceRow { key: string; name: string; sub: string; coreRatio: number; value: number }

function callerRows(operations: GithubOperationStat[], windowKey: WindowKey): CallerRow[] {
	return operations
		.map(operation => ({
			key: operation.callSite,
			name: operation.callSite,
			sub: operation.topWorktreePath ? `most: ${spaceLabel(operation.topWorktreePath)}` : resourceLabel(operation.resource),
			resource: operation.resource,
			value: countsForWindow(operation, windowKey).calls,
		}))
		.sort((a, b) => b.value - a.value);
}

function spaceRows(spaces: GithubSpaceStat[], windowKey: WindowKey): SpaceRow[] {
	return spaces
		.map(space => ({
			key: space.space,
			name: spaceLabel(space.space),
			sub: space.topCallSite ? `most: ${space.topCallSite}` : '—',
			// 数値とバーの色分けが選択中の窓で食い違わないよう、coreRatioも窓に対応するものを使う
			coreRatio: windowKey === '5m' ? space.rolling5mCoreRatio : windowKey === '1h' ? space.rolling1hCoreRatio : space.coreRatio,
			value: countsForWindow(space, windowKey).calls,
		}))
		.sort((a, b) => b.value - a.value);
}

function formatCountdown(resetAt: number, now: number): string {
	const ms = resetAt - now;
	if (ms <= 0) { return 'まもなくリセット'; }
	const minutes = Math.floor(ms / 60_000);
	if (minutes >= 60) { return `${Math.floor(minutes / 60)}時間${minutes % 60}分後リセット`; }
	return `${minutes}分後リセット`;
}

export default function GithubUsageScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const tabBarSpacer = useTabBarSpacer();
	const { githubUsage, connection } = useAppStore(useShallow(s => ({ githubUsage: s.githubUsage, connection: s.connection })));

	const [data, setData] = useState<GithubUsageResult | undefined>();
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [windowKey, setWindowKey] = useState<WindowKey>('5m');
	const [groupKey, setGroupKey] = useState<GroupKey>('caller');

	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') { return; }
		setLoading(true);
		setError(undefined);
		try {
			const result = await githubUsage(bypassCache);
			setData(result);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [githubUsage, connection]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	const core = useMemo(() => data?.rateLimits.find(entry => entry.resource === 'core'), [data]);
	const graphql = useMemo(() => data?.rateLimits.find(entry => entry.resource === 'graphql'), [data]);
	const rows = useMemo(() => {
		if (!data) { return []; }
		return groupKey === 'caller' ? callerRows(data.operations, windowKey) : spaceRows(data.spaces, windowKey);
	}, [data, groupKey, windowKey]);
	const maxValue = useMemo(() => Math.max(1, ...rows.map(r => r.value)), [rows]);
	// 画面を開いたままでもリセットまでのカウントダウンが進むよう、取得時刻ではなく現在時刻を使う
	const now = useNow();

	return (
		<ConnectionGate>
			<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
				<View style={styles.header}>
					<Text style={styles.title}>GitHub API</Text>
					<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="閉じる">
						<Ionicons name="close" size={16} color={colors.textDim} />
					</Pressable>
				</View>
				<ScrollView
					style={styles.scroll}
					contentContainerStyle={{ paddingBottom: tabBarSpacer }}
					refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} />}
				>
					{loading && !data ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
					{error ? <Text style={styles.error}>{error}</Text> : null}
					{data && !data.ghAvailable ? (
						<Text style={styles.warn}>GitHub CLI(gh)が見つかりません。PC側で `gh auth login` を実行してください。</Text>
					) : null}
					{data?.rateLimitError ? <Text style={styles.warn}>レート枠を取得できませんでした: {data.rateLimitError}</Text> : null}

					{data ? (
						<>
							<View style={styles.kpiRow}>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>CORE 残量</Text>
									<Text style={styles.kpiValue}>{core ? core.remaining.toLocaleString() : '—'}</Text>
									{core ? (
										<>
											<Text style={styles.kpiSub}>/ {core.limit.toLocaleString()} · {formatCountdown(core.resetAt, now)}</Text>
											<View style={styles.kpiGauge}>
												<View style={[styles.kpiGaugeFill, { width: `${core.limit > 0 ? Math.min(100, Math.max(0, (core.remaining / core.limit) * 100)) : 0}%`, backgroundColor: colors.accent }]} />
											</View>
										</>
									) : null}
								</View>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>GRAPHQL 残量</Text>
									<Text style={[styles.kpiValue, { color: colors.yellow }]}>{graphql ? graphql.remaining.toLocaleString() : '—'}</Text>
									{graphql ? (
										<>
											<Text style={styles.kpiSub}>/ {graphql.limit.toLocaleString()} · {formatCountdown(graphql.resetAt, now)}</Text>
											<View style={styles.kpiGauge}>
												<View style={[styles.kpiGaugeFill, { width: `${graphql.limit > 0 ? Math.min(100, Math.max(0, (graphql.remaining / graphql.limit) * 100)) : 0}%`, backgroundColor: colors.yellow }]} />
											</View>
										</>
									) : null}
								</View>
							</View>

							<Text style={styles.sectionTitle}>期間</Text>
							<View style={styles.pillRow}>
								{(['5m', '1h', 'session'] as WindowKey[]).map(key => (
									<Pressable key={key} style={[styles.pill, windowKey === key && styles.pillActive]} onPress={() => { hapticSelection(); setWindowKey(key); }}>
										<Text style={[styles.pillText, windowKey === key && styles.pillTextActive]}>
											{key === '5m' ? '5分' : key === '1h' ? '1時間' : 'セッション'}
										</Text>
									</Pressable>
								))}
							</View>

							<Text style={styles.sectionTitle}>内訳</Text>
							<View style={styles.chipRow}>
								<Pressable style={[styles.chip, groupKey === 'caller' && styles.chipActive]} onPress={() => { hapticSelection(); setGroupKey('caller'); }}>
									<Text style={[styles.chipText, groupKey === 'caller' && styles.chipTextActive]}>呼び出し元</Text>
								</Pressable>
								<Pressable style={[styles.chip, groupKey === 'space' && styles.chipActive]} onPress={() => { hapticSelection(); setGroupKey('space'); }}>
									<Text style={[styles.chipText, groupKey === 'space' && styles.chipTextActive]}>スペース</Text>
								</Pressable>
							</View>

							<View style={styles.card}>
								{rows.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{rows.slice(0, MAX_ROWS).map((row, i) => {
									const corePercent = groupKey === 'caller'
										? (row as CallerRow).resource === 'core' ? 100 : 0
										: Math.round((row as SpaceRow).coreRatio * 100);
									const widthPercent = Math.max(2, (row.value / maxValue) * 100);
									return (
										<View key={row.key} style={[styles.barRow, i > 0 && styles.barSeparator]}>
											<View style={styles.barHead}>
												<Text style={styles.barName} numberOfLines={1}>{row.name}</Text>
												<Text style={styles.barValue}>{row.value.toLocaleString()}</Text>
											</View>
											<Text style={styles.barSub} numberOfLines={1}>{row.sub}</Text>
											<View style={styles.barTrack}>
												<View style={[styles.barFill, { width: `${widthPercent * corePercent / 100}%`, backgroundColor: colors.accent }]} />
												<View style={[styles.barFill, { width: `${widthPercent * (100 - corePercent) / 100}%`, backgroundColor: colors.yellow }]} />
											</View>
										</View>
									);
								})}
							</View>

							<Text style={styles.note}>
								棒の色は資源の内訳（青=Core/REST、黄=GraphQL）。「スペース」に切り替えるとworktreeごとの合計になり、worktreeに紐付かない呼び出し（Agent Sessionsウィンドウ自身のGitHub API利用）は1つにまとまります。
							</Text>
						</>
					) : null}
				</ScrollView>
			</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 10 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 24 },
	error: { color: colors.red, fontSize: 12.5, marginTop: 8, marginBottom: 4 },
	warn: { color: colors.yellow, fontSize: 11.5, marginTop: 8, marginBottom: 4 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	kpiRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
	kpiCard: { flex: 1, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 13, gap: 3 },
	kpiLabel: { color: colors.textDim, fontSize: 10.5, fontWeight: '600' },
	kpiValue: { color: colors.text, fontSize: 19, fontWeight: '800' },
	kpiSub: { color: colors.textDim, fontSize: 10 },
	kpiGauge: { height: 4, borderRadius: 2, backgroundColor: colors.surface3, marginTop: 8, overflow: 'hidden' },
	kpiGaugeFill: { height: 4, borderRadius: 2 },
	pillRow: { flexDirection: 'row', gap: 8, marginTop: 2, marginBottom: 2 },
	pill: { paddingVertical: 7, paddingHorizontal: 13, borderRadius: 999, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
	pillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
	pillText: { color: colors.textDim, fontSize: 11.5, fontWeight: '600' },
	pillTextActive: { color: colors.bg },
	chipRow: { flexDirection: 'row', gap: 8, marginTop: 2, marginBottom: 2 },
	chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
	chipActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	chipText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	chipTextActive: { color: colors.accent },
	barRow: { paddingVertical: 9, gap: 4 },
	barSeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	barHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
	barName: { color: colors.text, fontSize: 12, flex: 1 },
	barSub: { color: colors.textDim, fontSize: 10 },
	barValue: { color: colors.textDim, fontSize: 11.5, fontWeight: '600' },
	barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surface3, overflow: 'hidden', flexDirection: 'row' },
	barFill: { height: 8 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 10, paddingHorizontal: 4 },
});
