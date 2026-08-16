// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { ScreenHeader } from '../../src/components/screenHeader.js';
import { SelectablePill } from '../../src/components/selectablePill.js';
import { useAppIsActive } from '../../src/hooks/useAppIsActive.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, radius, squircle } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';
import { mobileWarmLeaseOwnerRevision, MobileWarmLeaseLifecycle, shouldMaintainMobileWarmLease, type MobileDisposable, type SpaceDiskResult, type SystemResourcesResult } from '../../src/store.js';
import {
	CPU_THRESHOLDS, MEMORY_THRESHOLDS, buildProcessRows, buildScopeRows, diskLevel, formatBytes, formatCpu,
	buildSpaceDiskRows, sortRowsBy, usageLevel, usagePercent, type ResourceRow, type UsageLevel,
} from '../../src/systemResources.js';
import { formatRelativeTime, useNow } from '../../src/time.js';

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

export interface SystemSpaceDiskWarmLeaseScreenState {
	readonly focused: boolean;
	readonly appActive: boolean;
	readonly online: boolean;
	readonly volumeAxis: boolean;
	readonly activePcId: string | undefined;
	readonly controllerRevision: number;
}

/** System screen effect が所有する spaceDisk lease の全入力を一度に適用する production seam。 */
export function updateSystemSpaceDiskWarmLeaseLifecycle(
	lifecycle: MobileWarmLeaseLifecycle,
	state: SystemSpaceDiskWarmLeaseScreenState,
	acquire: () => MobileDisposable,
): void {
	lifecycle.update(shouldMaintainMobileWarmLease('spaceDisk', state), acquire,
		mobileWarmLeaseOwnerRevision(state.activePcId, state.controllerRevision));
}

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
	const tabBarSpacer = useTabBarSpacer();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const { systemResources, spaceDiskUsage, connection, activePcId, controllerRevision, acquireSpaceDiskWarmLease } = useAppStore(useShallow(s => ({
		systemResources: s.systemResources,
		spaceDiskUsage: s.spaceDisk,
		connection: s.connection,
		activePcId: s.activePcId,
		controllerRevision: s.controllerRevision,
		acquireSpaceDiskWarmLease: s.acquireSpaceDiskWarmLease,
	})));

	const [data, setData] = useState<SystemResourcesResult | undefined>();
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [axis, setAxis] = useState<AxisKey>('process');
	/**
	 * スペースごとの容量。**6秒ポーリングとは完全に別管理**にする。
	 * 計測は1周で数十秒かかるので、あちらへ混ぜると CPU/メモリの表示まで完了待ちで固まる。
	 * PC側が1時間ごとに測っておくため、ここでは通常その結果が即座に返る。
	 */
	const [spaceDisk, setSpaceDisk] = useState<SpaceDiskResult | undefined>();
	const [spaceLoading, setSpaceLoading] = useState(false);
	const [spaceError, setSpaceError] = useState<string | undefined>();
	const [openSpaces, setOpenSpaces] = useState<ReadonlySet<string>>(() => new Set());

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
	const warmLeaseLifecycle = useRef<MobileWarmLeaseLifecycle | undefined>(undefined);
	warmLeaseLifecycle.current ??= new MobileWarmLeaseLifecycle();
	useEffect(() => {
		const lifecycle = warmLeaseLifecycle.current!;
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, {
			focused: isFocused,
			appActive: isAppActive,
			online: connection === 'online',
			volumeAxis: axis === 'volume',
			activePcId,
			controllerRevision,
		}, acquireSpaceDiskWarmLease);
		return () => lifecycle.update(false, acquireSpaceDiskWarmLease);
	}, [isFocused, isAppActive, connection, axis, activePcId, controllerRevision, acquireSpaceDiskWarmLease]);
	useEffect(() => {
		if (!isFocused || !isAppActive || connection !== 'online') {
			return;
		}
		const timer = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [isFocused, isAppActive, connection, refresh]);

	/**
	 * スペースごとの容量を取りに行く。**自動更新の interval には乗せない**。
	 * `force` のときだけPC側に測り直させる（スペースの数と大きさ次第で数十秒〜数分）。
	 *
	 * 多重発火の抑止は state ではなく ref で持つ。state だとレンダー境界に依存するうえ、
	 * 「失敗した」ことを抑止条件に混ぜると、瞬断で1回失敗しただけで自動取得が二度と
	 * 走らなくなる（復旧手段が数分かかる強制再計測しか残らない）。
	 */
	const spaceInflight = useRef(false);
	const loadSpaceDisk = useCallback(async (force = false) => {
		if (connection !== 'online' || spaceInflight.current) { return; }
		spaceInflight.current = true;
		setSpaceLoading(true);
		setSpaceError(undefined);
		try {
			setSpaceDisk(await spaceDiskUsage(force));
		} catch (e) {
			const message = String(e instanceof Error ? e.message : e);
			// 旧PCはこのリクエストを知らない（PC側のフェイルセーフがこの文言で返す）
			setSpaceError(message.includes('unsupported request')
				? 'このPCのPara Codeはまだスペースごとの容量に対応していません。PC側を更新してください。'
				: message);
		} finally {
			spaceInflight.current = false;
			setSpaceLoading(false);
		}
	}, [spaceDiskUsage, connection]);

	// ボリューム軸を開いたときに取りに行く（開かない人のために測らせない）。
	// 失敗を抑止条件に入れないので、再接続すると `loadSpaceDisk` の参照が変わって取り直す。
	useEffect(() => {
		if (axis === 'volume' && spaceDisk === undefined) {
			void loadSpaceDisk(false);
		}
	}, [axis, spaceDisk, loadSpaceDisk]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			// スペース容量もPC側のキャッシュから引き直す（force はしない。
			// 引いただけで数十秒の再計測が走ると、意図しない待ちになる）。
			await Promise.all([refresh(true), loadSpaceDisk(false)]);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh, loadSpaceDisk]);

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
	// CPUとメモリは別々のリストにして、それぞれの指標で並べ替える（1行に2本のバーを重ねない）。
	const cpuRows = useMemo(() => sortRowsBy(rows, 'cpu'), [rows]);
	const memoryRows = useMemo(() => sortRowsBy(rows, 'memory'), [rows]);
	const maxCpu = useMemo(() => Math.max(1, ...rows.map(row => row.cpu)), [rows]);
	const maxMemory = useMemo(() => Math.max(1, ...rows.map(row => row.memory)), [rows]);
	// 「〇秒前に更新」を経時で進めるため、取得時刻ではなく現在時刻を使う
	const now = useNow(10_000);

	/**
	 * スペースごとの容量。worktree を持つ行は押すと内訳が開く。
	 *
	 * 本体（青）と worktree（紫）を分けて出す。実測では AZ-2 が 28.3GB のうち 21.2GB が
	 * worktree で、合計だけでは何が重いのか分からなかったため。
	 * PC側が worktree を親から引いて返すので、ここで足し引きはしない。
	 */
	const renderSpaceDisk = () => {
		const all = spaceDisk ? buildSpaceDiskRows(spaceDisk) : [];
		// プロセス/スペースの内訳と同じく上位だけ出す。リポジトリを数十個登録している人の
		// 画面が、下まで延々スクロールするリストにならないように。
		const rows = all.slice(0, MAX_ROWS);
		const max = Math.max(1, ...rows.map(row => row.totalBytes));
		const worktreeTotal = rows.reduce((sum, row) => sum + row.worktrees.reduce((a, w) => a + w.bytes, 0), 0);
		return (
			<>
				<View style={styles.spaceHead}>
					<Text style={[styles.sectionTitle, styles.spaceHeadTitle]}>スペースごとの容量</Text>
					{spaceDisk ? (
						<Text style={styles.spaceAgo}>
							{spaceLoading
								? '計測しています…'
								// formatRelativeTime は60秒未満で「今」を返すので、そのまま繋ぐと「今に計測」になる。
								: now - spaceDisk.measuredAt < 60_000
									? 'たった今 計測'
									: `${formatRelativeTime(spaceDisk.measuredAt, now)}に計測`}
						</Text>
					) : null}
					<Pressable
						style={styles.spaceRefresh}
						onPress={() => { hapticSelection(); void loadSpaceDisk(true); }}
						disabled={spaceLoading}
						accessibilityLabel="スペースの容量を測り直す"
					>
						{spaceLoading
							? <ActivityIndicator size="small" color={colors.textDim} />
							: <Ionicons name="refresh" size={14} color={colors.accent} />}
					</Pressable>
				</View>
				{spaceError ? <Text style={styles.error}>{spaceError}</Text> : null}
				{!spaceDisk && spaceLoading ? (
					<View style={styles.card}><Text style={styles.dim}>スペースごとの容量を数えています…</Text></View>
				) : null}
				{!spaceDisk && !spaceLoading && !spaceError ? (
					<View style={styles.card}>
						{/* 未接続を「PCがまだ数えていない」と書くと、PC側の都合に見えて誤誘導になる */}
						<Text style={styles.dim}>
							{connection === 'online'
								? 'このPCではまだ数えていません。まもなく裏で数え始めます。'
								: 'PCに接続すると、スペースごとの容量が出ます。'}
						</Text>
					</View>
				) : null}
				{spaceDisk ? (
					<>
						<View style={styles.card}>
							{rows.length === 0 ? <Text style={styles.dim}>スペースがありません</Text> : null}
							{all.length > MAX_ROWS ? (
								<Text style={styles.dim}>容量の大きい{MAX_ROWS}件を表示しています（全{all.length}件）</Text>
							) : null}
							{rows.map((row, i) => {
								const opened = openSpaces.has(row.key);
								const hasWorktrees = row.worktrees.length > 0;
								const wtBytes = row.worktrees.reduce((sum, w) => sum + w.bytes, 0);
								return (
									<View key={row.key} style={[styles.barRow, i > 0 && styles.barSeparator]}>
										<Pressable
											disabled={!hasWorktrees}
											onPress={() => {
												hapticSelection();
												setOpenSpaces(prev => {
													const next = new Set(prev);
													if (next.has(row.key)) { next.delete(row.key); } else { next.add(row.key); }
													return next;
												});
											}}
											// Pressable は既定で子のテキストを読み替えてしまう。ラベルに数値を入れないと、
											// この画面の主目的である容量がスクリーンリーダーに一切届かない。
											accessibilityRole={hasWorktrees ? 'button' : undefined}
											accessibilityState={hasWorktrees ? { expanded: opened } : undefined}
											accessibilityLabel={row.error
												? `${row.name} 計測できませんでした`
												: hasWorktrees
													? `${row.name} 合計 ${formatBytes(row.totalBytes)}、本体 ${formatBytes(row.ownBytes)}、worktree ${row.worktrees.length}個 ${formatBytes(wtBytes)}`
													: `${row.name} ${formatBytes(row.totalBytes)}`}
										>
											<View style={styles.barHead}>
												{hasWorktrees ? (
													<Ionicons name={opened ? 'chevron-down' : 'chevron-forward'} size={12} color={colors.textDim} />
												) : <View style={styles.spaceChevronSpacer} />}
												<Text style={styles.barName} numberOfLines={1}>{row.name}</Text>
												<Text style={styles.barValue}>{row.error ? '—' : `${row.truncated ? '約 ' : ''}${formatBytes(row.totalBytes)}`}</Text>
											</View>
											{row.error ? <Text style={styles.barSub} numberOfLines={1}>{row.error}</Text> : null}
											<View style={styles.barTrack}>
												<View style={[styles.barFill, { width: `${Math.max(1, (row.ownBytes / max) * 100)}%`, backgroundColor: colors.accent }]} />
												{hasWorktrees ? (
													<View style={[styles.barFill, { width: `${Math.max(1, (wtBytes / max) * 100)}%`, backgroundColor: colors.purple }]} />
												) : null}
											</View>
											{hasWorktrees ? (
												<Text style={styles.barSub} numberOfLines={1}>
													本体 {formatBytes(row.ownBytes)} ・ worktree {row.worktrees.length}個 {formatBytes(wtBytes)}
												</Text>
											) : null}
										</Pressable>
										{opened ? (
											<View style={styles.worktreeList}>
												{row.worktrees.map(worktree => (
													<View key={worktree.key} style={styles.worktreeRow}>
														<Text style={styles.worktreeName} numberOfLines={1}>
															{worktree.name}{worktree.outside ? '（別の場所）' : ''}
														</Text>
														{/* 失敗を落とすと「0 B」として並び、空なのか測れなかったのか分からなくなる */}
														<Text style={styles.worktreeValue}>
															{worktree.error ? '測れません' : `${worktree.truncated ? '約 ' : ''}${formatBytes(worktree.bytes)}`}
														</Text>
													</View>
												))}
											</View>
										) : null}
									</View>
								);
							})}
						</View>
						{worktreeTotal > 0 ? (
							<View style={styles.legend}>
								<View style={styles.legendItem}><View style={[styles.legendSwatch, { backgroundColor: colors.accent }]} /><Text style={styles.legendText}>本体</Text></View>
								<View style={styles.legendItem}><View style={[styles.legendSwatch, { backgroundColor: colors.purple }]} /><Text style={styles.legendText}>worktree</Text></View>
							</View>
						) : null}
						<Text style={styles.note}>
							worktreeを持つスペースは押すと内訳が開きます。worktreeが親フォルダの中にあっても外にあっても二重に数えません。
							PCが1時間ごとに裏で数えているので、開いたときにはもう出ています。
						</Text>
					</>
				) : null}
			</>
		);
	};

	/**
	 * 1つの指標ぶんの内訳。バーは1本だけで、見出しと各行の数値がその指標を名指しする
	 * （色に意味を持たせないので凡例が要らない）。
	 */
	const renderMetricSection = (title: string, sorted: ResourceRow[], metric: 'cpu' | 'memory', max: number) => (
		<>
			<Text style={styles.sectionTitle}>{title}</Text>
			<View style={styles.card}>
				{sorted.length === 0 ? <Text style={styles.dim}>データがありません</Text> : null}
				{sorted.length > MAX_ROWS ? (
					<Text style={styles.dim}>使用量の多い{MAX_ROWS}件を表示しています（全{sorted.length}件）</Text>
				) : null}
				{sorted.slice(0, MAX_ROWS).map((row, i) => (
					<View key={row.key} style={[styles.barRow, i > 0 && styles.barSeparator]}>
						<View style={styles.barHead}>
							<Text style={styles.barName} numberOfLines={1}>{row.name}</Text>
							<Text style={styles.barValue}>{metric === 'cpu' ? formatCpu(row.cpu) : formatBytes(row.memory)}</Text>
						</View>
						<Text style={styles.barSub} numberOfLines={1}>{row.sub}</Text>
						<View style={styles.barTrack}>
							<View style={[styles.barFill, { width: `${Math.max(1, (row[metric] / max) * 100)}%`, backgroundColor: metric === 'cpu' ? colors.accent : colors.purple }]} />
						</View>
					</View>
				))}
			</View>
		</>
	);

	return (
		<ConnectionGate>
			<View style={styles.screen}>
				<ScreenHeader
					title="システム"
					subtitle={data ? `${formatRelativeTime(data.host.collectedAt, now)}に更新 · ${data.host.cores}コア` : undefined}
					onHeightChange={setHeaderHeight}
				/>
				<ScrollView
					style={styles.scroll}
					contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: tabBarSpacer }, column]}
					refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} progressViewOffset={headerHeight} />}
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
								{([['process', 'プロセス'], ['scope', 'スペース'], ['volume', 'ボリューム']] as [AxisKey, string][]).map(([key, label]) => {
									const active = axis === key;
									return (
										<SelectablePill
											key={key}
											active={active}
											onPress={() => { hapticSelection(); setAxis(key); }}
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

							{axis === 'volume' ? (
								<>
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
								{renderSpaceDisk()}
								</>
							) : (
								<>
									{renderMetricSection('CPU 使用率順', cpuRows, 'cpu', maxCpu)}
									{renderMetricSection('メモリ使用量順', memoryRows, 'memory', maxMemory)}
								</>
							)}

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
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginTop: 24 },
	error: { color: colors.red, fontSize: 12.5, marginTop: 8, marginBottom: 4 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
	dim: { color: colors.textDim, fontSize: 12.5, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	rings: { flexDirection: 'row', gap: 10, marginTop: 4 },
	ringCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingVertical: 14, paddingHorizontal: 6, alignItems: 'center', gap: 7 },
	ring: { width: 78, height: 78, alignItems: 'center', justifyContent: 'center' },
	ringValue: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
	ringValueText: { fontSize: 17, fontWeight: '800', letterSpacing: -0.4 },
	ringName: { color: colors.text, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
	ringSub: { color: colors.textDim, fontSize: 9.5, textAlign: 'center', lineHeight: 13 },
	// 下の余白が2ptしかないと、チップ（押せるもの）と直下のカードが触れて見える。
	chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2, marginBottom: 12 },
	// スペースごとの容量
	spaceHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 18, marginBottom: 8 },
	spaceHeadTitle: { flex: 1, marginTop: 0, marginBottom: 0 },
	spaceAgo: { color: colors.textDim, fontSize: 10.5 },
	// alignSelf を指定しないと、親の baseline 揃えでスピナー⇔アイコンの切替時に上下へ跳ねる。
	spaceRefresh: { width: 26, height: 26, borderRadius: 8, ...squircle, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
	spaceChevronSpacer: { width: 12 },
	worktreeList: { marginTop: 6, marginLeft: 12, paddingLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
	worktreeRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingVertical: 4 },
	worktreeName: { color: colors.textDim, fontSize: 11, flex: 1, minWidth: 0 },
	worktreeValue: { color: colors.purple, fontSize: 11, fontWeight: '600' },
	legend: { flexDirection: 'row', gap: 14, marginTop: 8, paddingHorizontal: 4 },
	legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	legendSwatch: { width: 9, height: 9, borderRadius: 3 },
	legendText: { color: colors.textDim, fontSize: 10.5 },
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
	barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surface3, overflow: 'hidden', flexDirection: 'row' },
	barFill: { height: 6 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 12, paddingHorizontal: 4 },
});
