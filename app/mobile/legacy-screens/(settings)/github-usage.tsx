// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { HeaderCircleButton, ScreenHeader } from '../../src/components/screenHeader.js';
import { SelectablePill } from '../../src/components/selectablePill.js';
import { PillHitArea, hitInset } from '../../src/components/pillHitArea.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { Meter } from '../../src/components/meter.js';
import { SectionHeader } from '../../src/components/sectionHeader.js';
import { alpha, colors, radius, squircle, tint, type } from '../../src/theme.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import { GITHUB_MONITOR_SPACE, GITHUB_UNSCOPED_SPACE } from '../../src/store.js';
import type { GithubCallCounts, GithubOperationStat, GithubSpaceStat, GithubUsageResult } from '../../src/store.js';
import { useNow } from '../../src/time.js';
import { updatedAtLabel, usedRatio } from '../../src/usageFormat.js';

/**
 * GitHub API利用状況画面。設定 → 使用量 →「GitHub API」から開く。
 * PC版のGitHub API Usageダッシュボード（githubMetrics）と同じスナップショットを閲覧専用で表示する。
 *
 * 資源の色分けは Core/REST=青、GraphQL=紫。以前は GraphQL を黄で描いていたが、同じ画面の
 * 「所要時間が長い・レート制限」の警告も黄で、上の使用率のメーターも60%を超えると黄になるため、
 * 資源の区別なのか警告なのか読み分けられなかった。
 */

/** 期間ピル・内訳チップの見た目の高さ（最小）。当たり判定は PillHitArea で HIT_SIZE まで広げる。 */
const PILL_HEIGHT = 28;
const CHIP_HEIGHT = 26;
const PILL_INSET = hitInset(PILL_HEIGHT);
const CHIP_INSET = hitInset(CHIP_HEIGHT);
/** GraphQL の資源を示す色（上の説明のとおり、警告の黄と重ねない）。 */
const GRAPHQL_COLOR = colors.purple;

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
	if (space === GITHUB_UNSCOPED_SPACE) {
		return 'Agent Sessionsウィンドウ（worktree外）';
	}
	if (space === GITHUB_MONITOR_SPACE) {
		return '残量の取得（自動監視）';
	}
	return space;
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
	// この画面は設定モーダル内に提示されタブバーが存在しない。NativeTabs 前提の
	// tabBarSpacer を使うと約40ptの死に余白になるため、モーダル内他画面と同じ値を直接使う。
	const insets = useStableInsets();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	const { githubUsage, connection, activePcId } = useAppStore(useShallow(s => ({ githubUsage: s.githubUsage, connection: s.connection, activePcId: s.activePcId })));

	const [data, setData] = useState<GithubUsageResult | undefined>();
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [windowKey, setWindowKey] = useState<WindowKey>('5m');
	const [groupKey, setGroupKey] = useState<GroupKey>('caller');

	// 自動再取得（PC切替）と手動更新が前後したときに古い応答で新しい結果を上書きしないよう、
	// 最後に投げた要求だけを採用する（待機中の他PCも接続を保つため、切替後でも旧PC向けの
	// RPCが正常に応答しうる。system.tsx と同じ流儀）。
	const requestSeq = useRef(0);
	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') { return; }
		const seq = ++requestSeq.current;
		setLoading(true);
		setError(undefined);
		try {
			const result = await githubUsage(bypassCache);
			if (seq !== requestSeq.current) { return; }
			setData(result);
		} catch (e) {
			if (seq !== requestSeq.current) { return; }
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			if (seq === requestSeq.current) {
				setLoading(false);
			}
		}
	}, [githubUsage, connection, activePcId]);

	useEffect(() => { void refresh(); }, [refresh]);

	// PC切替時に前PCの数字を破棄する（ccusage/rtk/ratelimit と同じ扱い）。
	// 切替では connection が online のままなので refresh の再発火が起きず、
	// 破棄しないと前PCの値を今のPCの顔で見せてしまう。
	useEffect(() => {
		setData(undefined);
		setError(undefined);
	}, [activePcId]);

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
					title="GitHub API"
					// GitHub APIのレート枠はPC(マシン)単位で共有され、rtk/ccusage/rate limitと違い
					// 「どのウィンドウ（ローカル/SSHリモート）から見ても同じ値」になる。接続先セグメントは
					// 出さず、その旨をここで明示する。取得時刻は他の使用量の画面と同じ書き方で先頭に置く。
					subtitle={data ? `${updatedAtLabel(data.generatedAt, now)} · PC全体の値` : 'PC全体の値です'}
					actions={headerActions}
					onHeightChange={setHeaderHeight}
				/>
				<ScrollView
					style={styles.scroll}
					contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]}
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
							{/* 他の使用量の画面（利用上限など）と同じく「使用率」で見せる。以前は残量を
							    数字とゲージで出しており、同じ満ちたゲージが画面によって「余裕」と「逼迫」の
							    逆の意味になっていた。色は使用率から meterColor で決める。 */}
							<View style={styles.kpiRow}>
								{([['REST 使用率', core], ['GraphQL 使用率', graphql]] as const).map(([label, entry]) => {
									const ratio = entry ? usedRatio(entry.used, entry.limit) : 0;
									return (
										<View key={label} style={styles.kpiCard}>
											<Text style={styles.kpiLabel}>{label}</Text>
											<Text style={styles.kpiValue}>{entry ? `${Math.round(ratio * 100)}%` : '—'}</Text>
											{entry ? (
												<>
													<Text style={styles.kpiSub}>{entry.used.toLocaleString()} / {entry.limit.toLocaleString()} · {formatCountdown(entry.resetAt, now)}</Text>
													<Meter ratio={ratio} style={styles.kpiGauge} />
												</>
											) : null}
										</View>
									);
								})}
							</View>

							<SectionHeader title="期間" />
							<View style={styles.pillRow}>
								{(['5m', '1h', 'session'] as WindowKey[]).map(key => {
									const active = windowKey === key;
									const label = key === '5m' ? '5分' : key === '1h' ? '1時間' : 'セッション';
									const select = () => { hapticSelection(); setWindowKey(key); };
									return (
										<PillHitArea key={key} onPress={select}>
											<SelectablePill
												active={active}
												onPress={select}
												style={styles.pill}
												hitStyle={styles.pillHit}
												accessibilityLabel={label}
											>
												<Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
											</SelectablePill>
										</PillHitArea>
									);
								})}
							</View>

							<SectionHeader title="内訳" />
							<View style={styles.chipRow}>
								{([['caller', '呼び出し元'], ['space', 'スペース']] as [GroupKey, string][]).map(([key, label]) => {
									const active = groupKey === key;
									const select = () => { hapticSelection(); setGroupKey(key); };
									return (
										<PillHitArea key={key} onPress={select}>
											<SelectablePill
												active={active}
												onPress={select}
												style={styles.chip}
												hitStyle={styles.chipHit}
												activeColor={colors.accentWash}
												accessibilityLabel={label}
											>
												<Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
											</SelectablePill>
										</PillHitArea>
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
												<View style={[styles.barFill, { width: `${widthPercent * (100 - corePercent) / 100}%`, backgroundColor: GRAPHQL_COLOR }]} />
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
								棒の色は資源の内訳（青=Core/REST、紫=GraphQL）。「スペース」に切り替えるとworktreeごとの合計になり、worktreeに紐付かない呼び出し（Agent Sessionsウィンドウ自身のGitHub API利用）は1つにまとまります。
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
	error: { color: colors.red, fontSize: type.meta, marginTop: 8, marginBottom: 4 },
	warn: { color: colors.yellow, fontSize: type.meta, marginTop: 8, marginBottom: 4 },
	dim: { color: colors.textDim, fontSize: type.meta, paddingVertical: 8 },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	kpiRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
	// 使用率のゲージを抱えるため StatCard には載せられない。寸法と文字は StatCard に合わせる。
	kpiCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, padding: 14 },
	kpiLabel: { color: colors.textDim, fontSize: type.caption, fontWeight: '600', letterSpacing: 0.4 },
	kpiValue: { color: colors.text, fontSize: type.large, fontWeight: '800', marginTop: 4, fontVariant: ['tabular-nums'] },
	kpiSub: { color: colors.textDim, fontSize: type.caption, marginTop: 2 },
	// Meter の track は flex: 1 を持つので、縦に積む中では伸ばさない。
	kpiGauge: { flex: 0, marginTop: 8 },
	// 下の余白が2ptしかないと、押せるピル／チップと直下のカードが触れて見える。
	// 当たり判定（PillHitArea）が上下にはみ出すぶんを余白から引き、見た目の位置を包む前（上2・下12）に揃える。
	pillRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, marginTop: 2 - PILL_INSET, marginBottom: 12 - PILL_INSET },
	pill: { borderRadius: radius.pill, ...squircle, minHeight: PILL_HEIGHT },
	pillHit: { paddingVertical: 7, paddingHorizontal: 13 },
	pillText: { color: colors.textDim, fontSize: type.meta, fontWeight: '600' },
	pillTextActive: { color: colors.bg },
	chipRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, marginTop: 2 - CHIP_INSET, marginBottom: 12 - CHIP_INSET },
	chip: { borderRadius: radius.control, ...squircle, minHeight: CHIP_HEIGHT },
	chipHit: { paddingVertical: 6, paddingHorizontal: 12 },
	chipText: { color: colors.textDim, fontSize: type.caption, fontWeight: '600' },
	chipTextActive: { color: colors.accent },
	barRow: { paddingVertical: 9, gap: 4 },
	barSeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	barHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
	barName: { color: colors.text, fontSize: type.meta, flex: 1 },
	barSub: { color: colors.textDim, fontSize: type.badge },
	barValue: { color: colors.textDim, fontSize: type.meta, fontWeight: '600' },
	// Core と GraphQL の積み上げで Meter では描けないため、高さ・角丸だけ Meter（6 / 3）に揃える。
	barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surface3, overflow: 'hidden', flexDirection: 'row' },
	barFill: { height: 6 },
	// 失敗・レート制限・所要時間。行が長くなりすぎないよう折り返す。
	statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
	stat: { color: colors.textDim, fontSize: type.badge, fontWeight: '700', backgroundColor: colors.surface3, borderRadius: radius.key, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
	statWarn: { color: colors.yellow, backgroundColor: tint(colors.yellow, alpha.wash) },
	statBad: { color: colors.red, backgroundColor: tint(colors.red, alpha.wash) },
	note: { color: colors.textDim, fontSize: type.meta, lineHeight: 18, marginTop: 10, paddingHorizontal: 4 },
});
