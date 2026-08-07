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
import { formatRelativeTime, useNow } from '../../src/time.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import type { UsageAgent, UsageDashboardResult } from '../../src/store.js';

/** モデル・プロジェクト別バーの表示上限件数。 */
const TOP_MODELS = 6;
const TOP_PROJECTS = 6;
const TOP_SESSIONS = 10;
/** 「日別」は最近の推移を見るためのものなので、集計期間とは独立に直近7日で固定する。 */
const DAILY_WINDOW_DAYS = 7;
/** モデル別・プロジェクト別の集計期間の選択肢（PCからは90日ぶん届いている）。 */
const PERIOD_OPTIONS = [7, 30, 90] as const;
type PeriodDays = typeof PERIOD_OPTIONS[number];
/** エージェント絞り込み。'all' は絞り込みなし。 */
type AgentFilter = UsageAgent | 'all';

const AGENT_LABEL: Record<UsageAgent, string> = {
	claude: 'Claude',
	codex: 'Codex',
	gemini: 'Gemini',
	other: 'その他',
};

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

function relativeTime(ts: number | undefined, now: number): string {
	if (ts === undefined) { return '—'; }
	return formatRelativeTime(ts, now);
}

interface ModelAgg { model: string; agent: UsageAgent; cost: number; tokens: number }

/** その日のうち、選んだエージェントぶんだけのコスト合計。 */
function dayCost(day: UsageDashboardResult['days'][number], agent: AgentFilter): number {
	return day.models.reduce((sum, m) => (agent === 'all' || m.agent === agent ? sum + m.cost : sum), 0);
}

/** データに実際に出てくるエージェント（使っていないものをピルに並べても選べるだけ無駄なので）。 */
function agentsInData(data: UsageDashboardResult): UsageAgent[] {
	const seen = new Set<UsageAgent>();
	for (const day of data.days) {
		for (const slice of day.models) {
			seen.add(slice.agent);
		}
	}
	return (['claude', 'codex', 'gemini', 'other'] as const).filter(agent => seen.has(agent));
}

/** 直近 windowDays 分のモデル別合算（コスト降順）。 */
function aggregateModels(data: UsageDashboardResult, windowDays: number, agent: AgentFilter): ModelAgg[] {
	const cutoff = localDateKey(new Date(Date.now() - (windowDays - 1) * 86_400_000));
	const byModel = new Map<string, ModelAgg>();
	for (const day of data.days) {
		if (day.date < cutoff) { continue; }
		for (const slice of day.models) {
			if (agent !== 'all' && slice.agent !== agent) { continue; }
			const entry = byModel.get(slice.model) ?? { model: slice.model, agent: slice.agent, cost: 0, tokens: 0 };
			entry.cost += slice.cost;
			entry.tokens += slice.inputTokens + slice.outputTokens + slice.cacheCreationTokens + slice.cacheReadTokens;
			byModel.set(slice.model, entry);
		}
	}
	return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}

/**
 * 直近 windowDays 分のプロジェクト別合算（コスト降順）。
 * PCからは元々 `projects` が届いていたが、これまで画面では一度も使っていなかった。
 * `UsageProjectData` はエージェントの内訳を持たないので、エージェント絞り込みは効かない。
 */
function aggregateProjects(data: UsageDashboardResult, windowDays: number): { name: string; cost: number }[] {
	const cutoff = localDateKey(new Date(Date.now() - (windowDays - 1) * 86_400_000));
	return data.projects
		.map(project => ({
			name: project.name,
			cost: project.dailyCosts.reduce((sum, entry) => (entry.date >= cutoff ? sum + entry.cost : sum), 0),
		}))
		.filter(project => project.cost > 0)
		.sort((a, b) => b.cost - a.cost);
}

/** 直近 windowDays 分の日別合計コスト（日付降順＝新しい日が先頭、欠損日も0埋め）。 */
function recentDailyCosts(data: UsageDashboardResult, windowDays: number, agent: AgentFilter): { date: string; cost: number }[] {
	const byDate = new Map(data.days.map(d => [d.date, dayCost(d, agent)]));
	const out: { date: string; cost: number }[] = [];
	for (let i = 0; i < windowDays; i++) {
		const date = localDateKey(new Date(Date.now() - i * 86_400_000));
		out.push({ date, cost: byDate.get(date) ?? 0 });
	}
	return out;
}

export default function CcusageScreen() {
	const tabBarSpacer = useTabBarSpacer();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	// 相対時刻表示（セッションの最終アクティビティ）を画面を開いたままでも追従させる
	const now = useNow();
	const { usageDashboard, connection } = useAppStore(useShallow(s => ({ usageDashboard: s.usageDashboard, connection: s.connection })));

	const [data, setData] = useState<UsageDashboardResult | undefined>();
	const [loading, setLoading] = useState(false);
	// pull-to-refresh 由来の読み込みだけ RefreshControl のスピナーに紐付ける
	// （初回ロードを refreshing にすると中央の ActivityIndicator と二重表示になる）。
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [periodDays, setPeriodDays] = useState<PeriodDays>(30);
	const [agentFilter, setAgentFilter] = useState<AgentFilter>('all');

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
		return row ? dayCost(row, agentFilter) : 0;
	}, [data, agentFilter]);

	const availableAgents = useMemo(() => data ? agentsInData(data) : [], [data]);
	const dailyCosts = useMemo(() => data?.days ? recentDailyCosts(data, DAILY_WINDOW_DAYS, agentFilter) : [], [data, agentFilter]);
	const maxDailyCost = useMemo(() => Math.max(0.01, ...dailyCosts.map(d => d.cost)), [dailyCosts]);
	const models = useMemo(
		() => data?.days ? aggregateModels(data, periodDays, agentFilter).slice(0, TOP_MODELS) : [],
		[data, periodDays, agentFilter],
	);
	const maxModelCost = useMemo(() => Math.max(0.01, ...models.map(m => m.cost)), [models]);
	const projects = useMemo(() => data ? aggregateProjects(data, periodDays).slice(0, TOP_PROJECTS) : [], [data, periodDays]);
	const maxProjectCost = useMemo(() => Math.max(0.01, ...projects.map(p => p.cost)), [projects]);
	const sessions = useMemo(() => (data?.sessions ?? []).slice(0, TOP_SESSIONS), [data]);
	const agentFiltered = agentFilter !== 'all';

	// データ側からそのエージェントが消える（90日窓の縁など）とピル自体が出なくなる。
	// 選択だけが残ると全部0円の画面から戻れなくなるので、「すべて」へ落とす。
	useEffect(() => {
		if (agentFilter !== 'all' && data !== undefined && !availableAgents.includes(agentFilter)) {
			setAgentFilter('all');
		}
	}, [agentFilter, availableAgents, data]);

	return (
		<ConnectionGate>
			<View style={styles.screen}>
				<ScreenHeader
					title="Ccusage"
					// PC側は30分ごとに裏で集計し直す。いつの数字を見ているかが分からないと
					// 「更新すべきか」を判断できないので、取得時刻を必ず添える。
					subtitle={data ? `${relativeTime(data.fetchedAt, now)}に取得` : undefined}
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
					{data && (data.failedReports?.length ?? 0) > 0 ? (
						<Text style={styles.warn}>一部のレポート取得に失敗しました（{data.failedReports.join(', ')}）</Text>
					) : null}

					{data ? (
						<>
							{/* 絞り込みは、それが効く数字より先に出す。後ろに置くと、押しても
							    上の数字が変わったことに気づけない。 */}
							{availableAgents.length > 1 ? (
								<>
									<Text style={styles.sectionTitle}>エージェント</Text>
									<View style={styles.pillRow}>
										{(['all', ...availableAgents] as AgentFilter[]).map(key => {
											const active = agentFilter === key;
											const label = key === 'all' ? 'すべて' : AGENT_LABEL[key];
											return (
												<SelectablePill
													key={key}
													active={active}
													onPress={() => { hapticSelection(); setAgentFilter(key); }}
													style={styles.pill}
													hitStyle={styles.pillHit}
													accessibilityLabel={label}
												>
													<Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
												</SelectablePill>
											);
										})}
									</View>
								</>
							) : null}

							<View style={styles.kpiRow}>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>今日のコスト</Text>
									<Text style={styles.kpiValue}>{formatCost(todayCost ?? 0)}</Text>
									{agentFiltered ? <Text style={styles.kpiSub}>{AGENT_LABEL[agentFilter as UsageAgent]}のみ</Text> : null}
								</View>
								{data.block ? (
									<View style={styles.kpiCard}>
										<Text style={styles.kpiLabel}>アクティブブロック</Text>
										<Text style={styles.kpiValue}>{formatCost(data.block.costUSD)}</Text>
										{/* ブロックはエージェント別の内訳を持たないので、絞り込み中は
										    隣のカードと集計範囲が違うことを明示する。 */}
										{agentFiltered
											? <Text style={styles.kpiSub}>すべてのエージェント</Text>
											: data.block.costPerHour !== undefined
												? <Text style={styles.kpiSub}>{formatCost(data.block.costPerHour)}/時</Text>
												: null}
									</View>
								) : null}
							</View>

							<Text style={styles.sectionTitle}>日別（直近{DAILY_WINDOW_DAYS}日）</Text>
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

							<Text style={styles.sectionTitle}>集計期間</Text>
							<View style={styles.pillRow}>
								{PERIOD_OPTIONS.map(days => {
									const active = periodDays === days;
									return (
										<SelectablePill
											key={days}
											active={active}
											onPress={() => { hapticSelection(); setPeriodDays(days); }}
											style={styles.pill}
											hitStyle={styles.pillHit}
											accessibilityLabel={`${days}日`}
										>
											<Text style={[styles.pillText, active && styles.pillTextActive]}>{days}日</Text>
										</SelectablePill>
									);
								})}
							</View>

							<Text style={styles.sectionTitle}>モデル別（直近{periodDays}日）</Text>
							<View style={styles.card}>
								{models.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{models.map(m => (
									// モデル名は固定幅ラベルだと省略されるため、名前+金額の行とバーの2段組にする
									<View key={m.model} style={styles.modelRow}>
										<View style={styles.modelHead}>
											<Text style={styles.modelName} numberOfLines={1}>{m.model}</Text>
											<Text style={styles.barValue}>{formatCost(m.cost)}</Text>
										</View>
										<View style={styles.barTrack}>
											<View style={[styles.barFill, { width: `${Math.max(2, (m.cost / maxModelCost) * 100)}%`, backgroundColor: AGENT_COLOR[m.agent] }]} />
										</View>
									</View>
								))}
							</View>

							<Text style={styles.sectionTitle}>プロジェクト別（直近{periodDays}日）</Text>
							<View style={styles.card}>
								{projects.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{projects.map(p => (
									<View key={p.name} style={styles.modelRow}>
										<View style={styles.modelHead}>
											<Text style={styles.modelName} numberOfLines={1}>{p.name}</Text>
											<Text style={styles.barValue}>{formatCost(p.cost)}</Text>
										</View>
										<View style={styles.barTrack}>
											<View style={[styles.barFill, { width: `${Math.max(2, (p.cost / maxProjectCost) * 100)}%`, backgroundColor: colors.accent }]} />
										</View>
									</View>
								))}
							</View>
							{agentFiltered && projects.length > 0 ? (
								<Text style={styles.note}>プロジェクト別はエージェントの内訳を持たないため、すべてのエージェントの合計を出しています。</Text>
							) : null}

							{/* セッションはPCが「直近のもの」を選んで送ってくるので、期間もエージェントも効かない。 */}
							<Text style={styles.sectionTitle}>直近セッション{agentFiltered ? '（すべてのエージェント）' : ''}</Text>
							<View style={styles.card}>
								{sessions.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{sessions.map((s, i) => (
									<View key={`${s.rawProject}-${i}`} style={[styles.sessionRow, i > 0 && styles.sessionSeparator]}>
										<View style={styles.rowBody}>
											<Text style={styles.rowTitle} numberOfLines={1}>{s.project}</Text>
											<Text style={styles.rowDesc} numberOfLines={1}>
												{s.models.join(', ') || '—'} · {formatCompactTokens(s.totalTokens)} tok · {relativeTime(s.lastActivity, now)}
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
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 24 },
	error: { color: colors.red, fontSize: 12.5, marginTop: 8, marginBottom: 4 },
	warn: { color: colors.yellow, fontSize: 11.5, marginTop: 8, marginBottom: 4 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	// 押せるピルと直下のカードが触れて見えないよう、下に余白を残す。
	pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2, marginBottom: 12 },
	pill: { borderRadius: radius.pill, ...squircle },
	pillHit: { paddingVertical: 7, paddingHorizontal: 13 },
	pillText: { color: colors.textDim, fontSize: 11.5, fontWeight: '600' },
	pillTextActive: { color: colors.bg },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 },
	kpiRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
	kpiCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 4 },
	kpiLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	kpiValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
	kpiSub: { color: colors.textDim, fontSize: 11 },
	barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
	barLabel: { color: colors.text, fontSize: 11.5, width: 72 },
	modelRow: { paddingVertical: 8, gap: 6 },
	modelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
	modelName: { color: colors.text, fontSize: 12, flex: 1 },
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
