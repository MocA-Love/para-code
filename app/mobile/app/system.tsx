// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { useAppIsActive } from '../src/hooks/useAppIsActive.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useTabBarSpacer } from '../src/hooks/useTabBarSpacer.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';
import type { SystemResourcesResult } from '../src/store.js';
import {
	CPU_THRESHOLDS, MEMORY_THRESHOLDS, buildProcessRows, buildScopeRows, diskLevel, formatBytes, formatCpu,
	usageLevel, usagePercent, type ResourceRow, type UsageLevel,
} from '../src/systemResources.js';
import { formatRelativeTime, useNow } from '../src/time.js';

/**
 * 「システム」画面。設定 →「システム」またはワークスペースドロワーのPCカードから開く。
 * ドロワーに常時出る3値（desktop state 経由）と違い、こちらは開いている間だけPCへ問い合わせて
 * 「何がリソースを食っているか」まで見せる。
 *
 * 数字の意味を必ず2段で示す: 大きい値＝マシン全体、注記＝Para Code分。
 * 「PCが忙しいか」と「Para Codeが重いか」は別の問いなので、片方だけだと誤読される。
 */

/** 表示中の自動更新間隔。PC側は ps を叩くので、PC版パネル（2秒）より緩める。 */
const REFRESH_INTERVAL_MS = 6_000;
/** 内訳に出す行の表示上限件数。 */
const MAX_ROWS = 12;

type AxisKey = 'process' | 'scope' | 'volume';

function levelColor(level: UsageLevel, normal: string): string {
	return level === 'critical' ? colors.red : level === 'warn' ? colors.yellow : normal;
}

/** 円グラフ1つ。percent は 0〜100（undefined は未取得＝トラックだけ描く）。 */
function Ring({ percent, color }: { percent: number | undefined; color: string }) {
	const radius = 32;
	const circumference = 2 * Math.PI * radius;
	const filled = percent === undefined ? 0 : Math.min(100, Math.max(0, percent)) / 100;
	return (
		<Svg width={78} height={78}>
			<Circle cx={39} cy={39} r={radius} stroke={colors.surface3} strokeWidth={7} fill="none" />
			{filled > 0 ? (
				<Circle
					cx={39}
					cy={39}
					r={radius}
					stroke={color}
					strokeWidth={7}
					fill="none"
					strokeLinecap="round"
					strokeDasharray={`${circumference}`}
					strokeDashoffset={circumference * (1 - filled)}
					transform={`rotate(-90 39 39)`}
				/>
			) : null}
		</Svg>
	);
}

function RingCard({ name, percent, value, sub, color }: {
	name: string; percent: number | undefined; value: string; sub: string; color: string;
}) {
	return (
		<View style={styles.ringCard}>
			<View style={styles.ring}>
				<Ring percent={percent} color={color} />
				<View style={styles.ringValue}>
					<Text style={[styles.ringValueText, { color }]}>{value}</Text>
				</View>
			</View>
			<Text style={styles.ringName}>{name}</Text>
			<Text style={styles.ringSub}>{sub}</Text>
		</View>
	);
}

export default function SystemScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const tabBarSpacer = useTabBarSpacer();
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const { systemResources, connection } = useAppStore(useShallow(s => ({ systemResources: s.systemResources, connection: s.connection })));

	const [data, setData] = useState<SystemResourcesResult | undefined>();
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [axis, setAxis] = useState<AxisKey>('process');

	// 自動更新（6秒）に対しPC側は ps と statfs を直列に走らせるため、所要が間隔を超えることがある。
	// 応答が前後したときに古い結果で新しい結果を上書きしないよう、最後に投げた要求だけを採用する。
	const requestSeq = useRef(0);
	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') { return; }
		const seq = ++requestSeq.current;
		setLoading(true);
		setError(undefined);
		try {
			const result = await systemResources(bypassCache);
			if (seq !== requestSeq.current) { return; }
			setData(result);
		} catch (e) {
			if (seq !== requestSeq.current) { return; }
			const message = String(e instanceof Error ? e.message : e);
			// 旧PCはこのリクエストを知らない（PC側のフェイルセーフがこの文言で返す）
			setError(message.includes('unsupported request')
				? 'このPCのPara Codeはまだこの画面に対応していません。PC側を更新してください。'
				: message);
		} finally {
			if (seq === requestSeq.current) {
				setLoading(false);
			}
		}
	}, [systemResources, connection]);

	useEffect(() => { void refresh(); }, [refresh]);

	// 表示中だけ自動更新する。リソースは数秒で意味が変わる値なので、開きっぱなしの画面が
	// 固まった数字を出し続けないようにする（画面を離れる・アプリが背面に回ったら止める）。
	const isFocused = useIsFocused();
	const isAppActive = useAppIsActive();
	useEffect(() => {
		if (!isFocused || !isAppActive || connection !== 'online') {
			return;
		}
		const timer = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [isFocused, isAppActive, connection, refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	const primaryDisk = data?.host.disks[0];
	const memoryPercent = data ? usagePercent(data.host.memory.used, data.host.memory.total) : 0;
	const diskPercent = primaryDisk ? usagePercent(primaryDisk.total - primaryDisk.free, primaryDisk.total) : 0;
	const cpuLevel = usageLevel(data?.host.cpu ?? 0, CPU_THRESHOLDS);
	const memoryLevel = usageLevel(memoryPercent, MEMORY_THRESHOLDS);
	const volumeLevel = primaryDisk ? diskLevel(primaryDisk.total, primaryDisk.free) : 'normal';

	const rows: ResourceRow[] = useMemo(() => {
		if (!data) { return []; }
		return axis === 'process' ? buildProcessRows(data) : axis === 'scope' ? buildScopeRows(data) : [];
	}, [data, axis]);
	const maxCpu = useMemo(() => Math.max(1, ...rows.map(row => row.cpu)), [rows]);
	const maxMemory = useMemo(() => Math.max(1, ...rows.map(row => row.memory)), [rows]);
	// 「〇秒前に更新」を経時で進めるため、取得時刻ではなく現在時刻を使う
	const now = useNow(10_000);

	return (
		<ConnectionGate>
			<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
				<View style={styles.header}>
					<View style={styles.headerBody}>
						<Text style={styles.title}>システム</Text>
						{data ? <Text style={styles.subtitle}>{formatRelativeTime(data.host.collectedAt, now)}に更新 · {data.host.cores}コア</Text> : null}
					</View>
					<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="閉じる">
						<Ionicons name="close" size={16} color={colors.textDim} />
					</Pressable>
				</View>
				<ScrollView
					style={styles.scroll}
					contentContainerStyle={[{ paddingBottom: tabBarSpacer }, column]}
					refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} />}
				>
					{loading && !data ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
					{error ? <Text style={styles.error}>{error}</Text> : null}

					{data ? (
						<>
							<View style={styles.rings}>
								<RingCard
									name="CPU"
									percent={data.host.cpu}
									value={formatCpu(data.host.cpu)}
									sub={`Para Code ${formatCpu(data.host.cores > 0 ? data.snapshot.app.cpu / data.host.cores : undefined)}`}
									color={levelColor(cpuLevel, colors.accent)}
								/>
								<RingCard
									name="RAM"
									percent={memoryPercent}
									value={`${Math.round(memoryPercent)}%`}
									sub={`${formatBytes(data.host.memory.used)} / ${formatBytes(data.host.memory.total)}`}
									color={levelColor(memoryLevel, colors.yellow)}
								/>
								<RingCard
									name="SSD"
									percent={primaryDisk ? diskPercent : undefined}
									value={primaryDisk ? `${Math.round(diskPercent)}%` : '—'}
									sub={primaryDisk ? `空き ${formatBytes(primaryDisk.free)}` : '取得できません'}
									color={levelColor(volumeLevel, colors.green)}
								/>
							</View>

							<Text style={styles.sectionTitle}>内訳</Text>
							<View style={styles.chipRow}>
								{([['process', 'プロセス'], ['scope', 'スペース'], ['volume', 'ボリューム']] as [AxisKey, string][]).map(([key, label]) => (
									<Pressable key={key} style={[styles.chip, axis === key && styles.chipActive]} onPress={() => { hapticSelection(); setAxis(key); }}>
										<Text style={[styles.chipText, axis === key && styles.chipTextActive]}>{label}</Text>
									</Pressable>
								))}
							</View>

							{axis === 'volume' ? (
								<View style={styles.card}>
									{data.host.disks.length === 0 ? <Text style={styles.dim}>ボリュームを取得できませんでした</Text> : null}
									{data.host.disks.map((disk, i) => {
										const used = Math.max(0, disk.total - disk.free);
										const percent = usagePercent(used, disk.total);
										const level = diskLevel(disk.total, disk.free);
										return (
											<View key={disk.path} style={[styles.barRow, i > 0 && styles.barSeparator]}>
												<View style={styles.barHead}>
													<Text style={styles.barName} numberOfLines={1}>{disk.label}</Text>
													<Text style={styles.barValue}>{Math.round(percent)}%</Text>
												</View>
												<Text style={styles.barSub} numberOfLines={1}>空き {formatBytes(disk.free)} / {formatBytes(disk.total)}</Text>
												<View style={styles.barTrack}>
													<View style={[styles.barFill, { width: `${Math.max(2, percent)}%`, backgroundColor: levelColor(level, colors.green) }]} />
												</View>
											</View>
										);
									})}
								</View>
							) : (
								<View style={styles.card}>
									{rows.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
									{rows.length > MAX_ROWS ? (
										<Text style={styles.dim}>使用量の多い{MAX_ROWS}件を表示しています（全{rows.length}件）</Text>
									) : null}
									{rows.slice(0, MAX_ROWS).map((row, i) => (
										<View key={row.key} style={[styles.barRow, i > 0 && styles.barSeparator]}>
											<View style={styles.barHead}>
												<Text style={styles.barName} numberOfLines={1}>{row.name}</Text>
												<Text style={styles.barValue}>{formatCpu(row.cpu)} · {formatBytes(row.memory)}</Text>
											</View>
											<Text style={styles.barSub} numberOfLines={1}>{row.sub}</Text>
											<View style={styles.barTrack}>
												<View style={[styles.barFill, { width: `${Math.max(1, (row.cpu / maxCpu) * 100)}%`, backgroundColor: colors.accent }]} />
											</View>
											<View style={styles.barTrack}>
												<View style={[styles.barFill, { width: `${Math.max(1, (row.memory / maxMemory) * 100)}%`, backgroundColor: colors.yellow }]} />
											</View>
										</View>
									))}
								</View>
							)}

							{axis !== 'volume' ? (
								<View style={styles.legend}>
									<View style={styles.legendItem}><View style={[styles.legendSwatch, { backgroundColor: colors.accent }]} /><Text style={styles.legendText}>CPU</Text></View>
									<View style={styles.legendItem}><View style={[styles.legendSwatch, { backgroundColor: colors.yellow }]} /><Text style={styles.legendText}>メモリ</Text></View>
								</View>
							) : null}

							<Text style={styles.note}>
								上の3つはPC全体の使用量です。内訳に出るのは Para Code 本体と、Para Code が開いているターミナルのぶんだけなので、
								合計はPC全体と一致しません（他のアプリぶんが差になります）。内訳のCPUはマルチコアの合計なので、1つのターミナルでも100%を超えることがあります（上の丸い表示は全コアの平均です）。
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
	headerBody: { flex: 1, minWidth: 0 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
	subtitle: { color: colors.textDim, fontSize: 11, marginTop: 2 },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 24 },
	error: { color: colors.red, fontSize: 12.5, marginTop: 8, marginBottom: 4 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	rings: { flexDirection: 'row', gap: 10, marginTop: 4 },
	ringCard: { flex: 1, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingVertical: 14, paddingHorizontal: 6, alignItems: 'center', gap: 7 },
	ring: { width: 78, height: 78, alignItems: 'center', justifyContent: 'center' },
	ringValue: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
	ringValueText: { fontSize: 17, fontWeight: '800', letterSpacing: -0.4 },
	ringName: { color: colors.text, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
	ringSub: { color: colors.textDim, fontSize: 9.5, textAlign: 'center', lineHeight: 13 },
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
	barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surface3, overflow: 'hidden', flexDirection: 'row' },
	barFill: { height: 6 },
	legend: { flexDirection: 'row', gap: 14, marginTop: 8, paddingHorizontal: 4 },
	legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	legendSwatch: { width: 9, height: 9, borderRadius: 3 },
	legendText: { color: colors.textDim, fontSize: 10.5 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 12, paddingHorizontal: 4 },
});
