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
import { Meter } from '../../src/components/meter.js';
import { SectionHeader } from '../../src/components/sectionHeader.js';
import { StatCard } from '../../src/components/statCard.js';
import { colors, radius, squircle, type } from '../../src/theme.js';
import { useNow } from '../../src/time.js';
import { localDateKey, staleValueLabel, updatedAtLabel } from '../../src/usageFormat.js';
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

	// **actions は参照を安定させる。** インライン JSX のままだと毎レンダー新しい要素になり、
	// ScreenHeader 内の headerRight→options が毎回切れてバーの全項目付け替えが走る。
	// screenHeader.tsx は自ら「参照を安定させる」と明言しており、呼び出し側がそれを崩していた形
	// （deps は useCallback 済みの onPullRefresh とプリミティブだけ）。
	const headerActions = useMemo(() => (
		<HeaderCircleButton
			icon="refresh-outline"
			label="再取得"
			onPress={() => { hapticImpact('light'); void onPullRefresh(); }}
			disabled={pullRefreshing || loading}
		/>
	), [onPullRefresh, pullRefreshing, loading]);

	return (
		<ConnectionGate>
			<View style={styles.screen}>
				<ScreenHeader
					title="RTK の節約"
					// PC側はTTL付きのキャッシュを返す。いつの数字を見ているかが分からないと
					// 「更新すべきか」を判断できないので、取得時刻を必ず添える（書き方は使用量の各画面で共通）。
					subtitle={data ? updatedAtLabel(data.fetchedAt, now) : undefined}
					actions={headerActions}
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

					{/* 薄くするだけだと読み込み中と見分けが付かないので、いつの値かを文字で添える。 */}
					{data && hostStale ? <Text style={styles.staleNote}>{staleValueLabel(data.fetchedAt, now)}</Text> : null}
					{data ? (
						<View style={hostStale ? styles.stale : undefined}>
							<View style={styles.kpiRow}>
								<StatCard
									label="今日の節約"
									value={formatTokens(today?.savedTokens ?? 0)}
									sub={today ? `${today.commands}コマンド` : '記録なし'}
								/>
								<StatCard
									label="累計の節約"
									value={formatTokens(data.totals.savedTokens)}
									sub={`入力の${savingsPercent(data.totals.savedTokens, data.totals.inputTokens).toFixed(0)}%を削減`}
								/>
							</View>

							<SectionHeader title={`日別（直近${DAILY_WINDOW_DAYS}日）`} />
							<View style={styles.card}>
								{dailySaved.map(day => (
									<View key={day.date} style={styles.barRow}>
										<Text style={styles.barLabel} numberOfLines={1}>{day.date.slice(5)}</Text>
										<Meter ratio={Math.max(0.02, day.savedTokens / maxDailySaved)} color={colors.accent} />
										<Text style={styles.barValue}>{formatTokens(day.savedTokens)}</Text>
									</View>
								))}
							</View>

							<SectionHeader title="コマンド別" />
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
										<Meter ratio={Math.max(0.02, row.savedTokens / maxCommandSaved)} color={colors.accent} />
										<Text style={styles.commandMeta}>{row.count}回 · 平均{row.avgSavingsPct.toFixed(0)}%削減</Text>
									</View>
								))}
							</View>

							<SectionHeader title="直近のコマンド" />
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
	error: { color: colors.red, fontSize: type.meta, marginTop: 8, marginBottom: 4 },
	warn: { color: colors.yellow, fontSize: type.meta, marginTop: 8, marginBottom: 4 },
	// オフラインの接続先を選んでいる間、直近の値をそれと分かるように薄く残す。
	stale: { opacity: 0.5 },
	staleNote: { color: colors.textDim, fontSize: type.meta, lineHeight: 17, marginTop: 4, marginBottom: 4 },
	dim: { color: colors.textDim, fontSize: type.meta, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	kpiRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
	barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
	barLabel: { color: colors.text, fontSize: type.meta, width: 48 },
	barValue: { color: colors.textDim, fontSize: type.meta, width: 56, textAlign: 'right' },
	commandRow: { paddingVertical: 8, gap: 6 },
	commandHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
	commandName: { color: colors.text, fontSize: type.meta, flex: 1 },
	commandMeta: { color: colors.textDim, fontSize: type.caption },
	historyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	historySeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: type.meta, marginTop: 2 },
	historyPct: { color: colors.text, fontSize: type.body, fontWeight: '700' },
});
