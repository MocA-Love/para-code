// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { HeaderCircleButton, ScreenHeader } from '../../src/components/screenHeader.js';
import { SelectablePill } from '../../src/components/selectablePill.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, radius, squircle } from '../../src/theme.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import { GITHUB_UNSCOPED_SPACE } from '../../src/store.js';
import type { GithubCallCounts, GithubOperationStat, GithubSpaceStat, GithubUsageResult } from '../../src/store.js';
import { useNow } from '../../src/time.js';

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

// counts をそのまま持たせて、失敗・レート制限・所要時間まで行に出せるようにする
// （PCからは元々届いていたが、これまでは calls しか使っていなかった）。
interface CallerRow { key: string; name: string; sub: string; resource: 'core' | 'graphql'; value: number; counts: GithubCallCounts }
interface SpaceRow { key: string; name: string; sub: string; coreRatio: number; value: number; counts: GithubCallCounts }

function callerRows(operations: GithubOperationStat[], windowKey: WindowKey): CallerRow[] {
	return operations
		.map(operation => {
			const counts = countsForWindow(operation, windowKey);
			return {
				key: operation.callSite,
				name: operation.callSite,
				sub: operation.topWorktreePath ? `most: ${spaceLabel(operation.topWorktreePath)}` : resourceLabel(operation.resource),
				resource: operation.resource,
				value: counts.calls,
				counts,
			};
		})
		.sort((a, b) => b.value - a.value);
}

function spaceRows(spaces: GithubSpaceStat[], windowKey: WindowKey): SpaceRow[] {
	return spaces
		.map(space => {
			const counts = countsForWindow(space, windowKey);
			return {
				key: space.space,
				name: spaceLabel(space.space),
				sub: space.topCallSite ? `most: ${space.topCallSite}` : '—',
				// 数値とバーの色分けが選択中の窓で食い違わないよう、coreRatioも窓に対応するものを使う
				coreRatio: windowKey === '5m' ? space.rolling5mCoreRatio : windowKey === '1h' ? space.rolling1hCoreRatio : space.coreRatio,
				value: counts.calls,
				counts,
			};
		})
		.sort((a, b) => b.value - a.value);
}

/** 所要時間が長いと言える境目（ms）。超えたら黄色にして目に留める。 */
const SLOW_CALL_MS = 1_500;

function formatCountdown(resetAt: number, now: number): string {
	const ms = resetAt - now;
	if (ms <= 0) { return 'まもなくリセット'; }
	const minutes = Math.floor(ms / 60_000);
	if (minutes >= 60) { return `${Math.floor(minutes / 60)}時間${minutes % 60}分後リセット`; }
	return `${minutes}分後リセット`;
}

export default function GithubUsageScreen() {
	const tabBarSpacer = useTabBarSpacer();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
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
			<View style={styles.screen}>
				<ScreenHeader
					title="GitHub API"
					actions={
						<HeaderCircleButton
							icon="refresh-outline"
							label="再取得"
							onPress={() => { hapticImpact('light'); void onPullRefresh(); }}
							disabled={pullRefreshing || loading}
						/>
					}
					onHeightChange={setHeaderHeight}
				/>
				<ScrollView
					style={styles.scroll}
					contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: tabBarSpacer }, column]}
					refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} progressViewOffset={headerHeight} />}
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
								{(['5m', '1h', 'session'] as WindowKey[]).map(key => {
									const active = windowKey === key;
									const label = key === '5m' ? '5分' : key === '1h' ? '1時間' : 'セッション';
									return (
										<SelectablePill
											key={key}
											active={active}
											onPress={() => { hapticSelection(); setWindowKey(key); }}
											style={styles.pill}
											hitStyle={styles.pillHit}
											accessibilityLabel={label}
										>
											<Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
										</SelectablePill>
									);
								})}
							</View>

							<Text style={styles.sectionTitle}>内訳</Text>
							<View style={styles.chipRow}>
								{([['caller', '呼び出し元'], ['space', 'スペース']] as [GroupKey, string][]).map(([key, label]) => {
									const active = groupKey === key;
									return (
										<SelectablePill
											key={key}
											active={active}
											onPress={() => { hapticSelection(); setGroupKey(key); }}
											style={styles.chip}
											hitStyle={styles.chipHit}
											activeColor={colors.accentWash}
											accessibilityLabel={label}
										>
											<Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
										</SelectablePill>
									);
								})}
							</View>

							<View style={styles.card}>
								{rows.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{rows.slice(0, MAX_ROWS).map((row, i) => {
									const corePercent = groupKey === 'caller'
										? (row as CallerRow).resource === 'core' ? 100 : 0
										: Math.round((row as SpaceRow).coreRatio * 100);
									const widthPercent = Math.max(2, (row.value / maxValue) * 100);
									const { failures, rateLimited, avgDurationMs, maxDurationMs } = row.counts;
									const failurePercent = row.value > 0 ? Math.round((failures / row.value) * 100) : 0;
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
											{/* 問題があるときだけ赤・黄が増える。平常時は所要時間だけの静かな行にする。 */}
											{row.value > 0 ? (
												<View style={styles.statRow}>
													{failures > 0 ? (
														<Text style={[styles.stat, styles.statBad]}>失敗 {failures.toLocaleString()}（{failurePercent}%）</Text>
													) : null}
													{rateLimited > 0 ? (
														<Text style={[styles.stat, styles.statWarn]}>レート制限 {rateLimited.toLocaleString()}</Text>
													) : null}
													<Text style={styles.stat}>平均 {Math.round(avgDurationMs).toLocaleString()}ms</Text>
													<Text style={[styles.stat, maxDurationMs >= SLOW_CALL_MS && styles.statWarn]}>
														最大 {Math.round(maxDurationMs).toLocaleString()}ms
													</Text>
												</View>
											) : null}
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
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 24 },
	error: { color: colors.red, fontSize: 12.5, marginTop: 8, marginBottom: 4 },
	warn: { color: colors.yellow, fontSize: 11.5, marginTop: 8, marginBottom: 4 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	kpiRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
	kpiCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, padding: 13, gap: 3 },
	kpiLabel: { color: colors.textDim, fontSize: 10.5, fontWeight: '600' },
	kpiValue: { color: colors.text, fontSize: 19, fontWeight: '800' },
	kpiSub: { color: colors.textDim, fontSize: 10 },
	kpiGauge: { height: 4, borderRadius: 2, backgroundColor: colors.surface3, marginTop: 8, overflow: 'hidden' },
	kpiGaugeFill: { height: 4, borderRadius: 2 },
	// 下の余白が2ptしかないと、押せるピル／チップと直下のカードが触れて見える。
	pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2, marginBottom: 12 },
	pill: { borderRadius: radius.pill, ...squircle },
	pillHit: { paddingVertical: 7, paddingHorizontal: 13 },
	pillText: { color: colors.textDim, fontSize: 11.5, fontWeight: '600' },
	pillTextActive: { color: colors.bg },
	chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2, marginBottom: 12 },
	chip: { borderRadius: 8, ...squircle },
	chipHit: { paddingVertical: 6, paddingHorizontal: 12 },
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
	// 失敗・レート制限・所要時間。行が長くなりすぎないよう折り返す。
	statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
	stat: { color: colors.textDim, fontSize: 9.5, fontWeight: '700', backgroundColor: colors.surface3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
	statWarn: { color: colors.yellow, backgroundColor: 'rgba(224,192,125,0.14)' },
	statBad: { color: colors.red, backgroundColor: 'rgba(244,114,114,0.14)' },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 10, paddingHorizontal: 4 },
});
