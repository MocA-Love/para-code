// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../src/appState.js';
import { hitSlopToMinimum } from '../../../src/components/hitSlop.js';
import { haptic } from '../../../src/haptics.js';
import { useAppIsActive } from '../../../src/hooks/useAppIsActive.js';
import { MobileWarmLeaseLifecycle, type SpaceDiskResult, type SystemResourcesResult } from '../../../src/store.js';
import {
	CPU_THRESHOLDS,
	MEMORY_THRESHOLDS,
	buildProcessRows,
	buildScopeRows,
	buildSpaceDiskRows,
	diskLevel,
	formatBytes,
	formatCpu,
	sortRowsBy,
	usageLevel,
	usagePercent,
	type ResourceRow,
} from '../../../src/systemResources.js';
import { colors, radius, space, type } from '../../../src/theme.js';
import { formatRelativeTime, useNow } from '../../../src/time.js';
import { resourceLevelColor, updatedAtLabel } from '../../../src/usageFormat.js';
import { Icon, SectionHeader, iconSize } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { settingsRoutes } from '../../../src/features/settings/settingsRoutes.js';
import { UsageEntryRows } from '../../../src/features/usage/usageOverviewParts.js';
import { useUsageOverview } from '../../../src/features/usage/usageStore.js';
import { useUsageScope } from '../../../src/features/usage/useUsageScope.js';
import { barPercent, unsupportedRequestMessage, updateSystemSpaceDiskWarmLeaseLifecycle } from '../../../src/features/settings/usageDetailModel.js';
import {
	Bar,
	BarItem,
	ChoiceChips,
	DetailCard,
	DetailEmptyLine,
	DetailLoading,
	DetailMessage,
	DetailNotConnected,
	DetailRefreshButton,
} from '../../../src/features/settings/usageDetailParts.js';

/** 開いている間の自動更新の間隔。PC 側は ps を叩くので、PC 版のパネル（2秒）より緩める。 */
const REFRESH_INTERVAL_MS = 6_000;
/** 内訳に出す行の上限。 */
const MAX_ROWS = 12;
/** スペースの容量の「測り直す」の見た目の大きさ（当たり判定は 44 に広げる）。 */
const REMEASURE_SIZE = 28;

type AxisKey = 'process' | 'scope' | 'volume';
const AXIS_OPTIONS: readonly { value: AxisKey; label: string }[] = [
	{ value: 'process', label: 'プロセス' },
	{ value: 'scope', label: 'スペース' },
	{ value: 'volume', label: 'ボリューム' },
];

/**
 * システム（`/settings/usage/system`）。PC の CPU・メモリ・ディスクと、何がそれを使っているかを見る
 * （旧 `legacy-screens/(settings)/system.tsx` の作り直し）。
 *
 * 数字は必ず2段で示す: 大きい値＝マシン全体、補足＝Para Code のぶん。「PC が忙しいか」と
 * 「Para Code が重いか」は別の問いなので、片方だけだと読み違える。
 *
 * 取り方は旧画面のまま: 開いている間だけ6秒ごとに取り直し（最後の要求だけを採る）、スペースごとの容量は
 * 別に管理する（1周に数十秒かかるので、6秒の取り直しへ混ぜると CPU・メモリまで待たされる）。
 * ボリュームの内訳を開いている間だけ PC 側のキャッシュを温める（warm lease）。
 */
export default function SystemScreen() {
	const { scope } = useUsageScope();
	return scope.kind === 'all' ? <SystemAllView /> : <SystemDetailView />;
}

/**
 * PC が2台以上のときの「システム」。足さずに PC ごとに1行（desktop state の CPU・メモリ・SSD だけを使い、
 * 6 秒ごとの詳細の取得は全 PC にかけない）。行を押すとその PC の詳細へ。
 */
function SystemAllView() {
	const router = useRouter();
	const now = useNow();
	const overview = useUsageOverview();
	const entries = overview.entries.filter(entry => entry.kind === 'pc');
	return (
		<SettingsScreen title="システム" subtitle={`PC ${entries.length} 台`}>
			<GroupHeader title="PC ごと" first />
			<UsageEntryRows
				entries={entries}
				values={{}}
				now={now}
				onOpen={entry => { haptic('move'); router.push(settingsRoutes.usageDetail('system', entry.key)); }}
			/>
			<DetailMessage tone="note">PC を選ぶと、何が CPU・メモリ・ディスクを使っているかを見られます。値は PC から常に届いているものです（オフラインの PC は出せません）。</DetailMessage>
		</SettingsScreen>
	);
}

function SystemDetailView() {
	const { scope } = useUsageScope();
	const { activeConnection, warmLeaseReady, activePcId, controllerRevision, acquireSpaceDiskWarmLease, pcs } = useAppStore(useShallow(s => ({
		activeConnection: s.connection,
		warmLeaseReady: s.connection === 'online' && s.pcOnline && s.sessionProtocolReady,
		activePcId: s.activePcId,
		controllerRevision: s.controllerRevision,
		acquireSpaceDiskWarmLease: s.acquireSpaceDiskWarmLease,
		pcs: s.pcs,
	})));
	// 「PC ごと」の行から来たときはその PC、PC が1台なら見ている PC。要求はその PC のコントローラへ送る。
	const targetPcId = scope.kind === 'source' && scope.pcId !== undefined ? scope.pcId : activePcId;
	const isActivePc = targetPcId === activePcId;
	const targetPc = pcs.find(pc => pc.id === targetPcId);
	const connection = isActivePc ? activeConnection : targetPc?.connection === 'online' && targetPc.pcOnline ? 'online' : 'offline';
	const systemResources = useCallback((bypassCache?: boolean) => {
		const requester = targetPcId !== undefined ? useAppStore.getState().usageRequesterFor(targetPcId) : undefined;
		return requester !== undefined ? requester.systemResources(bypassCache) : Promise.reject(new Error('not initialized'));
	}, [targetPcId]);
	const spaceDiskUsage = useCallback((bypassCache?: boolean) => {
		const requester = targetPcId !== undefined ? useAppStore.getState().usageRequesterFor(targetPcId) : undefined;
		return requester !== undefined ? requester.spaceDisk(bypassCache) : Promise.reject(new Error('not initialized'));
	}, [targetPcId]);

	const [data, setData] = useState<SystemResourcesResult | undefined>();
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [axis, setAxis] = useState<AxisKey>('process');
	const [spaceDisk, setSpaceDisk] = useState<SpaceDiskResult | undefined>();
	const [spaceLoading, setSpaceLoading] = useState(false);
	const [spaceError, setSpaceError] = useState<string | undefined>();
	const [openSpaces, setOpenSpaces] = useState<ReadonlySet<string>>(() => new Set());

	// 自動更新（6秒）に対し PC 側の処理が間隔を超えることがある。古い結果で新しい結果を上書きしないよう、
	// 最後に投げた要求だけを採る。
	const requestSeq = useRef(0);
	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') {
			return;
		}
		const seq = ++requestSeq.current;
		setLoading(true);
		setError(undefined);
		try {
			const result = await systemResources(bypassCache);
			if (seq !== requestSeq.current) {
				return;
			}
			setData(result);
		} catch (e) {
			if (seq !== requestSeq.current) {
				return;
			}
			setError(unsupportedRequestMessage(e, 'この PC の Para Code はまだこの画面に対応していません。PC 側を更新してください。'));
		} finally {
			if (seq === requestSeq.current) {
				setLoading(false);
			}
		}
		// targetPcId: 切り替えたら取り直す（connection は online のままなので、これが無いと再取得が起きない）
	}, [systemResources, connection, targetPcId]);

	useEffect(() => { void refresh(); }, [refresh]);

	/**
	 * スペースごとの容量。自動更新には乗せない。`force` のときだけ PC に測り直させる（数十秒〜数分）。
	 * 重複の抑止は ref の世代で持つ（state にすると、瞬断で1回失敗しただけで自動取得が二度と走らなくなる）。
	 * PC の切り替えで世代を進めるので、計測中に切り替えても新しい PC への取得は止まらず、前の PC の応答は捨てる。
	 */
	const spaceRequestGen = useRef(0);
	const spaceLoadingGen = useRef(-1);
	const loadSpaceDisk = useCallback(async (force = false) => {
		if (connection !== 'online' || spaceLoadingGen.current === spaceRequestGen.current) {
			return;
		}
		const gen = ++spaceRequestGen.current;
		spaceLoadingGen.current = gen;
		setSpaceLoading(true);
		setSpaceError(undefined);
		try {
			const result = await spaceDiskUsage(force);
			if (gen !== spaceRequestGen.current) {
				return;
			}
			setSpaceDisk(result);
		} catch (e) {
			if (gen !== spaceRequestGen.current) {
				return;
			}
			setSpaceError(unsupportedRequestMessage(e, 'この PC の Para Code はまだスペースごとの容量に対応していません。PC 側を更新してください。'));
		} finally {
			if (gen === spaceRequestGen.current) {
				setSpaceLoading(false);
			}
			if (spaceLoadingGen.current === gen) {
				spaceLoadingGen.current = -1;
			}
		}
	}, [spaceDiskUsage, connection]);

	// PC を切り替えたら前の PC の数字を捨て、スペースの容量の取得世代を進める。
	useEffect(() => {
		setData(undefined);
		setSpaceDisk(undefined);
		setOpenSpaces(new Set());
		setError(undefined);
		setSpaceError(undefined);
		spaceRequestGen.current++;
	}, [targetPcId]);

	// 表示中だけ自動更新する（画面を離れる・アプリが背面に回ったら止める）。
	const isFocused = useIsFocused();
	const isAppActive = useAppIsActive();
	const warmLeaseLifecycle = useRef<MobileWarmLeaseLifecycle | undefined>(undefined);
	warmLeaseLifecycle.current ??= new MobileWarmLeaseLifecycle();
	useEffect(() => {
		const lifecycle = warmLeaseLifecycle.current;
		if (lifecycle === undefined) {
			return undefined;
		}
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, {
			focused: isFocused,
			appActive: isAppActive,
			// 温めの要求は見ている PC にだけ送る（見ていない PC の詳細はキャッシュのまま測る）
			online: warmLeaseReady && isActivePc,
			volumeAxis: axis === 'volume',
			activePcId,
			controllerRevision,
		}, acquireSpaceDiskWarmLease);
		return () => lifecycle.update(false, acquireSpaceDiskWarmLease);
	}, [isFocused, isAppActive, warmLeaseReady, isActivePc, axis, activePcId, controllerRevision, acquireSpaceDiskWarmLease]);
	useEffect(() => {
		if (!isFocused || !isAppActive || connection !== 'online') {
			return undefined;
		}
		const timer = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [isFocused, isAppActive, connection, refresh]);

	// ボリュームの内訳を開いたときに取りに行く（開かない人のために測らせない）。
	useEffect(() => {
		if (axis === 'volume' && spaceDisk === undefined) {
			void loadSpaceDisk(false);
		}
	}, [axis, spaceDisk, loadSpaceDisk]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			// スペースの容量は PC 側のキャッシュから引き直すだけにする（測り直すと数十秒待たせる）。
			await Promise.all([refresh(true), loadSpaceDisk(false)]);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh, loadSpaceDisk]);

	// 「〇秒前に更新」を進めるため、取得時刻ではなく今の時刻を使う
	const now = useNow(10_000);
	const primaryDisk = data?.host.disks[0];
	const memoryPercent = data !== undefined ? usagePercent(data.host.memory.used, data.host.memory.total) : 0;
	const diskPercent = primaryDisk !== undefined ? usagePercent(primaryDisk.total - primaryDisk.free, primaryDisk.total) : 0;
	const rows: ResourceRow[] = data === undefined ? [] : axis === 'process' ? buildProcessRows(data) : axis === 'scope' ? buildScopeRows(data) : [];
	// CPU とメモリは別々の一覧にして、それぞれの指標で並べる（1行に2本の棒を重ねない）。
	const cpuRows = sortRowsBy(rows, 'cpu');
	const memoryRows = sortRowsBy(rows, 'memory');
	const maxCpu = Math.max(1, ...rows.map(row => row.cpu));
	const maxMemory = Math.max(1, ...rows.map(row => row.memory));
	const subtitle = [
		pcs.length > 1 ? targetPc?.name : undefined,
		data !== undefined ? `${updatedAtLabel(data.host.collectedAt, now)} · ${data.host.cores}コア` : undefined,
	].filter((part): part is string => part !== undefined).join(' · ') || undefined;

	const toggleSpace = (key: string) => {
		haptic('move');
		setOpenSpaces(prev => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	/** 1つの指標ぶんの内訳。棒は1本だけで、見出しと各行の数値がその指標を名指しする。 */
	const renderMetric = (title: string, sorted: ResourceRow[], metric: 'cpu' | 'memory', max: number) => (
		<>
			<GroupHeader title={title} />
			<DetailCard>
				{sorted.length === 0 ? <DetailEmptyLine>データがありません</DetailEmptyLine> : null}
				{sorted.length > MAX_ROWS ? <DetailEmptyLine>{`使用量の多い ${MAX_ROWS} 件を表示しています（全 ${sorted.length} 件）`}</DetailEmptyLine> : null}
				{sorted.slice(0, MAX_ROWS).map(row => (
					<BarItem
						key={row.key}
						name={row.name}
						value={metric === 'cpu' ? formatCpu(row.cpu) : formatBytes(row.memory)}
						sub={row.sub}
						segments={[{ percent: barPercent(row[metric], max, 1), color: colors.blue }]}
					/>
				))}
			</DetailCard>
		</>
	);

	/**
	 * スペースごとの容量。worktree を持つ行は押すと内訳が開く。本体（青）と worktree（紫）を分けて出す
	 * （合計だけでは何が重いのか分からないため）。PC 側が worktree を親から引いて返すので、ここで足し引きはしない。
	 */
	const renderSpaceDisk = () => {
		const all = spaceDisk !== undefined ? buildSpaceDiskRows(spaceDisk) : [];
		// 上位だけを出す（リポジトリを数十個登録していても延々と続く一覧にしない）。
		const spaceRows = all.slice(0, MAX_ROWS);
		const max = Math.max(1, ...spaceRows.map(row => row.totalBytes));
		const worktreeTotal = spaceRows.reduce((sum, row) => sum + row.worktrees.reduce((a, w) => a + w.bytes, 0), 0);
		const measuredLabel = spaceDisk === undefined ? undefined
			: spaceLoading ? '計測しています…'
				// formatRelativeTime は60秒未満で「今」を返すので、そのまま繋ぐと「今に計測」になる。
				: now - spaceDisk.measuredAt < 60_000 ? 'たった今 計測' : `${formatRelativeTime(spaceDisk.measuredAt, now)}に計測`;
		return (
			<>
				<SectionHeader
					title="スペースごとの容量"
					style={styles.spaceHeader}
					right={(
						<View style={styles.spaceHeaderRight}>
							{measuredLabel !== undefined ? <Text style={styles.measured}>{measuredLabel}</Text> : null}
							<Pressable
								style={({ pressed }) => [styles.remeasure, pressed ? styles.remeasurePressed : undefined]}
								hitSlop={hitSlopToMinimum(REMEASURE_SIZE, REMEASURE_SIZE)}
								onPress={() => { haptic('commit'); void loadSpaceDisk(true); }}
								disabled={spaceLoading}
								accessibilityRole="button"
								accessibilityLabel="スペースの容量を測り直す"
							>
								{spaceLoading ? <ActivityIndicator size="small" color={colors.textDim} /> : <Icon icon={RefreshCw} size={iconSize.sm} color={colors.textDim} />}
							</Pressable>
						</View>
					)}
				/>
				{spaceError !== undefined ? <DetailMessage tone="error">{spaceError}</DetailMessage> : null}
				{spaceDisk === undefined && spaceLoading ? <DetailCard><DetailEmptyLine>スペースごとの容量を数えています…</DetailEmptyLine></DetailCard> : null}
				{spaceDisk === undefined && !spaceLoading && spaceError === undefined ? (
					<DetailCard>
						{/* 未接続を「PC がまだ数えていない」と書くと、PC 側の都合に見えて誤解される */}
						<DetailEmptyLine>
							{connection === 'online' ? 'この PC ではまだ数えていません。まもなく裏で数え始めます。' : 'PC に接続すると、スペースごとの容量が出ます。'}
						</DetailEmptyLine>
					</DetailCard>
				) : null}
				{spaceDisk !== undefined ? (
					<>
						<DetailCard>
							{spaceRows.length === 0 ? <DetailEmptyLine>スペースがありません</DetailEmptyLine> : null}
							{all.length > MAX_ROWS ? <DetailEmptyLine>{`容量の大きい ${MAX_ROWS} 件を表示しています（全 ${all.length} 件）`}</DetailEmptyLine> : null}
							{spaceRows.map(row => {
								const opened = openSpaces.has(row.key);
								const hasWorktrees = row.worktrees.length > 0;
								const worktreeBytes = row.worktrees.reduce((sum, w) => sum + w.bytes, 0);
								return (
									<View key={row.key} style={styles.spaceRow}>
										<Pressable
											disabled={!hasWorktrees}
											onPress={() => toggleSpace(row.key)}
											style={({ pressed }) => (pressed ? styles.spacePressed : undefined)}
											// 既定では子の文字を読み替えてしまうので、容量をラベルに入れる（この画面の主目的が読み上げに届くように）。
											accessibilityRole={hasWorktrees ? 'button' : undefined}
											accessibilityState={hasWorktrees ? { expanded: opened } : undefined}
											accessibilityLabel={row.error !== undefined
												? `${row.name} 計測できませんでした`
												: hasWorktrees
													? `${row.name} 合計 ${formatBytes(row.totalBytes)}、本体 ${formatBytes(row.ownBytes)}、worktree ${row.worktrees.length}個 ${formatBytes(worktreeBytes)}`
													: `${row.name} ${formatBytes(row.totalBytes)}`}
										>
											<View style={styles.spaceHead}>
												{hasWorktrees
													? <Icon icon={opened ? ChevronDown : ChevronRight} size={iconSize.xs} color={colors.textMuted} />
													: <View style={styles.chevronSpacer} />}
												<Text style={styles.spaceName} numberOfLines={1}>{row.name}</Text>
												<Text style={styles.spaceValue}>{row.error !== undefined ? '—' : `${row.truncated === true ? '約 ' : ''}${formatBytes(row.totalBytes)}`}</Text>
											</View>
											{row.error !== undefined ? <Text style={styles.spaceSub} numberOfLines={1}>{row.error}</Text> : null}
											<Bar
												segments={[
													{ percent: barPercent(row.ownBytes, max, 1), color: colors.blue },
													...(hasWorktrees ? [{ percent: barPercent(worktreeBytes, max, 1), color: colors.purple }] : []),
												]}
											/>
											{hasWorktrees ? (
												<Text style={styles.spaceSub} numberOfLines={1}>本体 {formatBytes(row.ownBytes)} · worktree {row.worktrees.length}個 {formatBytes(worktreeBytes)}</Text>
											) : null}
										</Pressable>
										{opened ? (
											<View style={styles.worktrees}>
												{row.worktrees.map(worktree => (
													<View key={worktree.key} style={styles.worktreeRow}>
														<Text style={styles.worktreeName} numberOfLines={1}>{worktree.name}{worktree.outside ? '（別の場所）' : ''}</Text>
														{/* 失敗を落とすと「0 B」として並び、空なのか測れなかったのか分からなくなる */}
														<Text style={styles.worktreeValue}>{worktree.error !== undefined ? '測れません' : `${worktree.truncated === true ? '約 ' : ''}${formatBytes(worktree.bytes)}`}</Text>
													</View>
												))}
											</View>
										) : null}
									</View>
								);
							})}
						</DetailCard>
						{worktreeTotal > 0 ? (
							<View style={styles.legend}>
								<View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.blue }]} /><Text style={styles.legendText}>本体</Text></View>
								<View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.purple }]} /><Text style={styles.legendText}>worktree</Text></View>
							</View>
						) : null}
						<DetailMessage tone="note">
							worktree を持つスペースは押すと内訳が開きます。worktree が親フォルダの中にあっても外にあっても二重には数えません。PC が1時間ごとに裏で数えているので、開いたときにはもう出ています。
						</DetailMessage>
					</>
				) : null}
			</>
		);
	};

	return (
		<SettingsScreen
			title="システム"
			subtitle={subtitle}
			// 6秒ごとの自動更新で loading は常に揺れるので、無効にするのは手動の再取得中だけ（点滅させない）。
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { haptic('edge'); void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			{loading && data === undefined ? <DetailLoading /> : null}
			{error !== undefined ? <DetailMessage tone="error">{error}</DetailMessage> : null}
			{data === undefined && connection !== 'online' ? <DetailNotConnected /> : null}

			{data !== undefined ? (
				<View>
					<GroupHeader title="PC 全体" first />
					<DetailCard>
						<BarItem
							name="CPU"
							value={formatCpu(data.host.cpu)}
							sub={`Para Code ${formatCpu(data.host.cores > 0 ? data.snapshot.app.cpu / data.host.cores : undefined)}`}
							segments={[{ percent: data.host.cpu ?? 0, color: resourceLevelColor(usageLevel(data.host.cpu ?? 0, CPU_THRESHOLDS)) }]}
						/>
						<BarItem
							name="メモリ"
							value={`${Math.round(memoryPercent)}%`}
							sub={`${formatBytes(data.host.memory.used)} / ${formatBytes(data.host.memory.total)}`}
							segments={[{ percent: memoryPercent, color: resourceLevelColor(usageLevel(memoryPercent, MEMORY_THRESHOLDS)) }]}
						/>
						<BarItem
							name="SSD"
							value={primaryDisk !== undefined ? `${Math.round(diskPercent)}%` : '—'}
							sub={primaryDisk !== undefined ? `空き ${formatBytes(primaryDisk.free)}` : '取得できません'}
							// 色は使用率ではなく空き容量のしきい値（diskLevel）でも決まる
							segments={primaryDisk !== undefined ? [{ percent: diskPercent, color: resourceLevelColor(diskLevel(primaryDisk.total, primaryDisk.free)) }] : []}
						/>
					</DetailCard>

					<GroupHeader title="内訳" />
					<ChoiceChips options={AXIS_OPTIONS} selected={axis} onSelect={setAxis} />

					{axis === 'volume' ? (
						<>
							<GroupHeader title="ボリューム" />
							<DetailCard>
								{data.host.disks.length === 0 ? <DetailEmptyLine>ボリュームを取得できませんでした</DetailEmptyLine> : null}
								{data.host.disks.map(disk => {
									const percent = usagePercent(Math.max(0, disk.total - disk.free), disk.total);
									return (
										<BarItem
											key={disk.path}
											name={disk.label}
											value={`${Math.round(percent)}%`}
											sub={`空き ${formatBytes(disk.free)} / ${formatBytes(disk.total)}`}
											segments={[{ percent, color: resourceLevelColor(diskLevel(disk.total, disk.free)) }]}
										/>
									);
								})}
							</DetailCard>
							{renderSpaceDisk()}
						</>
					) : (
						<>
							{renderMetric('CPU の使用率順', cpuRows, 'cpu', maxCpu)}
							{renderMetric('メモリの使用量順', memoryRows, 'memory', maxMemory)}
						</>
					)}

					<DetailMessage tone="note">
						「PC 全体」は PC 全体の使用量です。内訳に出るのは Para Code 本体と、Para Code が開いているターミナルのぶんだけなので、合計は PC 全体と一致しません（ほかのアプリのぶんが差になります）。内訳の CPU はマルチコアの合計なので、1つのターミナルでも 100% を超えることがあります（「PC 全体」の CPU は全コアの平均です）。
					</DetailMessage>
				</View>
			) : null}
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	spaceHeader: {
		marginTop: space.xl,
		marginBottom: space.xs,
	},
	spaceHeaderRight: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	measured: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	remeasure: {
		width: REMEASURE_SIZE,
		height: REMEASURE_SIZE,
		borderRadius: radius.button,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	remeasurePressed: {
		opacity: 0.7,
	},
	spaceRow: {
		paddingVertical: space.sm + 2,
	},
	spacePressed: {
		opacity: 0.7,
	},
	spaceHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
		marginBottom: space.xs,
	},
	chevronSpacer: {
		width: iconSize.xs,
	},
	spaceName: {
		flex: 1,
		minWidth: 0,
		fontSize: type.label,
		fontWeight: '500',
		color: colors.text,
	},
	spaceValue: {
		fontSize: type.meta,
		color: colors.textDim,
		fontVariant: ['tabular-nums'],
	},
	spaceSub: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginTop: space.xs,
	},
	worktrees: {
		marginTop: space.sm,
		marginLeft: space.md,
		paddingLeft: space.sm + 2,
		borderLeftWidth: StyleSheet.hairlineWidth,
		borderLeftColor: colors.border,
	},
	worktreeRow: {
		flexDirection: 'row',
		alignItems: 'baseline',
		gap: space.sm,
		paddingVertical: space.xs,
	},
	worktreeName: {
		flex: 1,
		minWidth: 0,
		fontSize: type.caption,
		color: colors.textDim,
	},
	worktreeValue: {
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.purple,
	},
	legend: {
		flexDirection: 'row',
		gap: space.md + 2,
		marginTop: space.sm,
		marginHorizontal: space.xs,
	},
	legendItem: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
	},
	legendDot: {
		width: space.sm,
		height: space.sm,
		borderRadius: radius.pill,
	},
	legendText: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
