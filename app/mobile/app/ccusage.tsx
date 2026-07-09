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
import { hapticImpact } from '../src/haptics.js';
import type { UsageAgent, UsageDashboardResult } from '../src/store.js';

/** モデル・プロジェクト別バーの表示上限件数。 */
const TOP_MODELS = 6;
const TOP_SESSIONS = 10;
const DAILY_WINDOW_DAYS = 14;
const AGGREGATE_WINDOW_DAYS = 30;

const AGENT_COLOR: Record<UsageAgent, string> = {
	claude: colors.claude,
	codex: colors.accent,
	gemini: colors.purple,
	other: colors.textDim,
};

function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

function formatCompactTokens(tokens: number): string {
	if (tokens >= 1_000_000) { return `${(tokens / 1_000_000).toFixed(1)}M`; }
	if (tokens >= 1_000) { return `${(tokens / 1_000).toFixed(1)}K`; }
	return String(tokens);
}

/** ローカル日付の YYYY-MM-DD（PC側 daily の period と同じ形式）。 */
function localDateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function relativeTime(ts: number | undefined): string {
	if (ts === undefined) { return '—'; }
	const diffMs = Date.now() - ts;
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) { return 'たった今'; }
	if (minutes < 60) { return `${minutes}分前`; }
	const hours = Math.floor(minutes / 60);
	if (hours < 24) { return `${hours}時間前`; }
	const days = Math.floor(hours / 24);
	return `${days}日前`;
}

interface ModelAgg { model: string; agent: UsageAgent; cost: number; tokens: number }

/** 直近 windowDays 分のモデル別合算（コスト降順）。 */
function aggregateModels(data: UsageDashboardResult, windowDays: number): ModelAgg[] {
	const cutoff = localDateKey(new Date(Date.now() - (windowDays - 1) * 86_400_000));
	const byModel = new Map<string, ModelAgg>();
	for (const day of data.days) {
		if (day.date < cutoff) { continue; }
		for (const slice of day.models) {
			const entry = byModel.get(slice.model) ?? { model: slice.model, agent: slice.agent, cost: 0, tokens: 0 };
			entry.cost += slice.cost;
			entry.tokens += slice.inputTokens + slice.outputTokens + slice.cacheCreationTokens + slice.cacheReadTokens;
			byModel.set(slice.model, entry);
		}
	}
	return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}

/** 直近 windowDays 分の日別合計コスト（日付昇順、欠損日も0埋め）。 */
function recentDailyCosts(data: UsageDashboardResult, windowDays: number): { date: string; cost: number }[] {
	const byDate = new Map(data.days.map(d => [d.date, d.models.reduce((sum, m) => sum + m.cost, 0)]));
	const out: { date: string; cost: number }[] = [];
	for (let i = windowDays - 1; i >= 0; i--) {
		const date = localDateKey(new Date(Date.now() - i * 86_400_000));
		out.push({ date, cost: byDate.get(date) ?? 0 });
	}
	return out;
}

export default function CcusageScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const tabBarSpacer = useTabBarSpacer();
	const { usageDashboard, connection } = useAppStore(useShallow(s => ({ usageDashboard: s.usageDashboard, connection: s.connection })));

	const [data, setData] = useState<UsageDashboardResult | undefined>();
	const [loading, setLoading] = useState(false);
	// pull-to-refresh 由来の読み込みだけ RefreshControl のスピナーに紐付ける
	// （初回ロードを refreshing にすると中央の ActivityIndicator と二重表示になる）。
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') { return; }
		setLoading(true);
		setError(undefined);
		try {
			const result = await usageDashboard(bypassCache);
			setData(result);
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [usageDashboard, connection]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	const todayCost = useMemo(() => {
		if (!data?.days) { return undefined; }
		const today = localDateKey(new Date());
		const row = data.days.find(d => d.date === today);
		return row ? row.models.reduce((sum, m) => sum + m.cost, 0) : 0;
	}, [data]);

	const dailyCosts = useMemo(() => data?.days ? recentDailyCosts(data, DAILY_WINDOW_DAYS) : [], [data]);
	const maxDailyCost = useMemo(() => Math.max(0.01, ...dailyCosts.map(d => d.cost)), [dailyCosts]);
	const models = useMemo(() => data?.days ? aggregateModels(data, AGGREGATE_WINDOW_DAYS).slice(0, TOP_MODELS) : [], [data]);
	const maxModelCost = useMemo(() => Math.max(0.01, ...models.map(m => m.cost)), [models]);
	const sessions = useMemo(() => (data?.sessions ?? []).slice(0, TOP_SESSIONS), [data]);

	return (
		<ConnectionGate>
			<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
				<View style={styles.header}>
					<Text style={styles.title}>Ccusage</Text>
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
					{data && (data.failedReports?.length ?? 0) > 0 ? (
						<Text style={styles.warn}>一部のレポート取得に失敗しました（{data.failedReports.join(', ')}）</Text>
					) : null}

					{data ? (
						<>
							<View style={styles.kpiRow}>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>今日のコスト</Text>
									<Text style={styles.kpiValue}>{formatCost(todayCost ?? 0)}</Text>
								</View>
								{data.block ? (
									<View style={styles.kpiCard}>
										<Text style={styles.kpiLabel}>アクティブブロック</Text>
										<Text style={styles.kpiValue}>{formatCost(data.block.costUSD)}</Text>
										{data.block.costPerHour !== undefined ? (
											<Text style={styles.kpiSub}>{formatCost(data.block.costPerHour)}/時</Text>
										) : null}
									</View>
								) : null}
							</View>

							<Text style={styles.sectionTitle}>直近{DAILY_WINDOW_DAYS}日</Text>
							<View style={styles.card}>
								{dailyCosts.map(d => (
									<View key={d.date} style={styles.barRow}>
										<Text style={styles.barLabel} numberOfLines={1}>{d.date.slice(5)}</Text>
										<View style={styles.barTrack}>
											<View style={[styles.barFill, { width: `${Math.max(2, (d.cost / maxDailyCost) * 100)}%`, backgroundColor: colors.accent }]} />
										</View>
										<Text style={styles.barValue}>{formatCost(d.cost)}</Text>
									</View>
								))}
							</View>

							<Text style={styles.sectionTitle}>モデル別（直近{AGGREGATE_WINDOW_DAYS}日）</Text>
							<View style={styles.card}>
								{models.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{models.map(m => (
									<View key={m.model} style={styles.barRow}>
										<Text style={styles.barLabel} numberOfLines={1}>{m.model}</Text>
										<View style={styles.barTrack}>
											<View style={[styles.barFill, { width: `${Math.max(2, (m.cost / maxModelCost) * 100)}%`, backgroundColor: AGENT_COLOR[m.agent] }]} />
										</View>
										<Text style={styles.barValue}>{formatCost(m.cost)}</Text>
									</View>
								))}
							</View>

							<Text style={styles.sectionTitle}>直近セッション</Text>
							<View style={styles.card}>
								{sessions.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{sessions.map((s, i) => (
									<View key={`${s.rawProject}-${i}`} style={[styles.sessionRow, i > 0 && styles.sessionSeparator]}>
										<View style={styles.rowBody}>
											<Text style={styles.rowTitle} numberOfLines={1}>{s.project}</Text>
											<Text style={styles.rowDesc} numberOfLines={1}>
												{s.models.join(', ') || '—'} · {formatCompactTokens(s.totalTokens)} tok · {relativeTime(s.lastActivity)}
											</Text>
										</View>
										<Text style={styles.sessionCost}>{formatCost(s.totalCost)}</Text>
									</View>
								))}
							</View>
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
	kpiCard: { flex: 1, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 4 },
	kpiLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	kpiValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
	kpiSub: { color: colors.textDim, fontSize: 11 },
	barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
	barLabel: { color: colors.text, fontSize: 11.5, width: 72 },
	barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface3, overflow: 'hidden' },
	barFill: { height: 8, borderRadius: 4 },
	barValue: { color: colors.textDim, fontSize: 11.5, width: 56, textAlign: 'right' },
	sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	sessionSeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: 11.5, marginTop: 2 },
	sessionCost: { color: colors.text, fontSize: 13, fontWeight: '700' },
});
