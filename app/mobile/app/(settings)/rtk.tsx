// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { HostSegment } from '../../src/components/hostSegment.js';
import { HeaderCircleButton, ScreenHeader } from '../../src/components/screenHeader.js';
import { useRelayHostSelection } from '../../src/hooks/useRelayHostSelection.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, radius, squircle } from '../../src/theme.js';
import { formatRelativeTime, useNow } from '../../src/time.js';
import { hapticImpact } from '../../src/haptics.js';
import type { RtkSavingsResult } from '../../src/store.js';

/** 日別バーは最近の推移を見るためのものなので直近7日で固定する。 */
const DAILY_WINDOW_DAYS = 7;
/** コマンド別内訳・直近コマンドの表示上限件数。 */
const TOP_COMMANDS = 10;
const TOP_HISTORY = 12;

function formatTokens(tokens: number): string {
	if (!isFinite(tokens)) { return '0'; }
	if (tokens >= 1_000_000_000) { return `${(tokens / 1_000_000_000).toFixed(1)}B`; }
	if (tokens >= 1_000_000) { return `${(tokens / 1_000_000).toFixed(1)}M`; }
	if (tokens >= 1_000) { return `${(tokens / 1_000).toFixed(1)}K`; }
	return String(Math.round(tokens));
}

/** 節約率(%)。PC側と同じく「入力に対して何%削れたか」で出す。 */
function savingsPercent(savedTokens: number, inputTokens: number): number {
	return inputTokens > 0 ? (savedTokens / inputTokens) * 100 : 0;
}

/** ローカル日付の YYYY-MM-DD（PC側 days の date と同じ形式）。 */
function localDateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 直近 windowDays 分の日別節約量（日付降順＝新しい日が先頭、記録の無い日も0埋め）。 */
function recentDays(data: RtkSavingsResult, windowDays: number): { date: string; savedTokens: number }[] {
	const byDate = new Map(data.days.map(day => [day.date, day.savedTokens]));
	const out: { date: string; savedTokens: number }[] = [];
	for (let i = 0; i < windowDays; i++) {
		const date = localDateKey(new Date(Date.now() - i * 86_400_000));
		out.push({ date, savedTokens: byDate.get(date) ?? 0 });
	}
	return out;
}

export default function RtkScreen() {
	// この画面は設定モーダル内に提示されタブバーが存在しないため、モーダル内他画面と
	// 同じ下余白を直接使う（NativeTabs 前提の tabBarSpacer は約40ptの死に余白になる）。
	const insets = useStableInsets();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	// 取得時刻の相対表示を、画面を開いたままでも追従させる
	const now = useNow();
	const { rtkSavings, connection, activePcId } = useAppStore(useShallow(s => ({ rtkSavings: s.rtkSavings, connection: s.connection, activePcId: s.activePcId })));
	// 「接続先セグメント」: rtkはコマンドを実行したホストのローカルDBに記録するため、
	// PCが複数のウィンドウ（ローカル/SSHリモート）を同時に開いていると値が別物になる。
	const { hosts, effectiveHostId, selectHost } = useRelayHostSelection();
	const selectedHost = hosts.find(host => host.id === effectiveHostId);
	// hosts が空（旧PC・host未同期）のときは接続先を選べないので、常に従来経路（windowId未指定）
	// で取得する。hosts があるのに選んだホストが一覧に無い（消えた）・未readyのときだけ
	// stale扱いにする（取得を止め、直近値を薄く残す）。
	const hostStale = hosts.length > 0 && selectedHost?.ready !== true;
	// hosts が空の間は接続先という概念が無いので、単一の既定キーへ統一する。
	const hostKey = effectiveHostId ?? 'default';

	// ホストごとに直近の値を持つ。切り替えても他ホストの値は消えない。
	const [dataByHost, setDataByHost] = useState<Record<string, RtkSavingsResult>>({});
	const data = dataByHost[hostKey];
	const [loading, setLoading] = useState(false);
	// pull-to-refresh 由来の読み込みだけ RefreshControl のスピナーに紐付ける
	// （初回ロードを refreshing にすると中央の ActivityIndicator と二重表示になる）。
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();

	// PCを切り替えてもこの画面を開いたままだと、切り替え直後は前のPCの値が「今のPC」の顔で
	// 残ってしまう（hostId はPCごとの意味しか持たず、'local'/'default' はPCをまたいで衝突する）。
	useEffect(() => { setDataByHost({}); }, [activePcId]);

	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online' || hostStale) { return; }
		setLoading(true);
		setError(undefined);
		try {
			const result = await rtkSavings(bypassCache, selectedHost?.windowId);
			setDataByHost(prev => ({ ...prev, [hostKey]: result }));
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [rtkSavings, connection, hostStale, hostKey, selectedHost?.windowId]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	const today = useMemo(() => {
		if (!data) { return undefined; }
		const key = localDateKey(new Date());
		return data.days.find(day => day.date === key);
	}, [data]);
	const dailySaved = useMemo(() => data ? recentDays(data, DAILY_WINDOW_DAYS) : [], [data]);
	const maxDailySaved = useMemo(() => Math.max(1, ...dailySaved.map(d => d.savedTokens)), [dailySaved]);
	const commands = useMemo(() => (data?.commands ?? []).slice(0, TOP_COMMANDS), [data]);
	const maxCommandSaved = useMemo(() => Math.max(1, ...commands.map(c => c.savedTokens)), [commands]);
	const history = useMemo(() => (data?.history ?? []).slice(0, TOP_HISTORY), [data]);

	return (
		<ConnectionGate>
			<View style={styles.screen}>
				<ScreenHeader
					title="RTK節約状況"
					// PC側はTTL付きのキャッシュを返す。いつの数字を見ているかが分からないと
					// 「更新すべきか」を判断できないので、取得時刻を必ず添える。
					subtitle={data ? `${formatRelativeTime(data.fetchedAt, now)}に取得` : undefined}
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
					contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]}
					refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} progressViewOffset={headerHeight} />}
				>
					<HostSegment hosts={hosts} selectedId={effectiveHostId} onSelect={selectHost} />
					{hostStale ? (
						<Text style={styles.warn}>{selectedHost === undefined
							? 'この接続先のウィンドウは閉じられました。上のボタンで別の接続先を選んでください。'
							: 'この接続先のPC画面はいま応答していません。PC側でウィンドウを開き直すと再取得できます。'}</Text>
					) : null}
					{loading && !data ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
					{error ? <Text style={styles.error}>{error}</Text> : null}
					{data && data.failedReports.length > 0 ? (
						<Text style={styles.warn}>一部のレポート取得に失敗しました（{data.failedReports.join(', ')}）</Text>
					) : null}

					{data ? (
						<View style={hostStale ? styles.stale : undefined}>
							<View style={styles.kpiRow}>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>今日の節約</Text>
									<Text style={styles.kpiValue}>{formatTokens(today?.savedTokens ?? 0)}</Text>
									<Text style={styles.kpiSub}>{today ? `${today.commands}コマンド` : '記録なし'}</Text>
								</View>
								<View style={styles.kpiCard}>
									<Text style={styles.kpiLabel}>累計の節約</Text>
									<Text style={styles.kpiValue}>{formatTokens(data.totals.savedTokens)}</Text>
									<Text style={styles.kpiSub}>入力の{savingsPercent(data.totals.savedTokens, data.totals.inputTokens).toFixed(0)}%を削減</Text>
								</View>
							</View>

							<Text style={styles.sectionTitle}>日別（直近{DAILY_WINDOW_DAYS}日）</Text>
							<View style={styles.card}>
								{dailySaved.map(day => (
									<View key={day.date} style={styles.barRow}>
										<Text style={styles.barLabel} numberOfLines={1}>{day.date.slice(5)}</Text>
										<View style={styles.barTrack}>
											<View style={[styles.barFill, { width: `${Math.max(2, (day.savedTokens / maxDailySaved) * 100)}%`, backgroundColor: colors.accent }]} />
										</View>
										<Text style={styles.barValue}>{formatTokens(day.savedTokens)}</Text>
									</View>
								))}
							</View>

							<Text style={styles.sectionTitle}>コマンド別</Text>
							<View style={styles.card}>
								{commands.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{commands.map((row, i) => (
									// コマンド名は固定幅ラベルだと省略されるため、名前+節約量の行とバーの2段組にする
									// rtk は表示幅でコマンド名を切り詰めるため同名行がありうる。index も key に含める。
									<View key={`${row.command}-${i}`} style={styles.commandRow}>
										<View style={styles.commandHead}>
											<Text style={styles.commandName} numberOfLines={1}>{row.command}</Text>
											<Text style={styles.barValue}>{formatTokens(row.savedTokens)}</Text>
										</View>
										<View style={styles.barTrack}>
											<View style={[styles.barFill, { width: `${Math.max(2, (row.savedTokens / maxCommandSaved) * 100)}%`, backgroundColor: colors.accent }]} />
										</View>
										<Text style={styles.commandMeta}>{row.count}回 · 平均{row.avgSavingsPct.toFixed(0)}%削減</Text>
									</View>
								))}
							</View>

							<Text style={styles.sectionTitle}>直近のコマンド</Text>
							<View style={styles.card}>
								{history.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
								{history.map((entry, i) => (
									<View key={`${entry.timestampLabel}-${i}`} style={[styles.historyRow, i > 0 && styles.historySeparator]}>
										<View style={styles.rowBody}>
											<Text style={styles.rowTitle} numberOfLines={1}>{entry.command}</Text>
											<Text style={styles.rowDesc} numberOfLines={1}>{entry.timestampLabel} · {formatTokens(entry.tokens)} tok</Text>
										</View>
										<Text style={styles.historyPct}>-{entry.savingsPct.toFixed(0)}%</Text>
									</View>
								))}
							</View>
						</View>
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
	// オフラインの接続先を選んでいる間、直近の値をそれと分かるように薄く残す。
	stale: { opacity: 0.5 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	kpiRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
	kpiCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 4 },
	kpiLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	kpiValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
	kpiSub: { color: colors.textDim, fontSize: 11 },
	barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
	barLabel: { color: colors.text, fontSize: 11.5, width: 48 },
	barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface3, overflow: 'hidden' },
	barFill: { height: 8, borderRadius: 4 },
	barValue: { color: colors.textDim, fontSize: 11.5, width: 56, textAlign: 'right' },
	commandRow: { paddingVertical: 8, gap: 6 },
	commandHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
	commandName: { color: colors.text, fontSize: 12, flex: 1 },
	commandMeta: { color: colors.textDim, fontSize: 11 },
	historyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	historySeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: 11.5, marginTop: 2 },
	historyPct: { color: colors.text, fontSize: 13, fontWeight: '700' },
});
