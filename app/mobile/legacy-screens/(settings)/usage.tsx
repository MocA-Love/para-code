// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { HostSegment } from '../../src/components/hostSegment.js';
import { Meter, meterColor } from '../../src/components/meter.js';
import { ProviderLogo } from '../../src/components/providerLogo.js';
import { HeaderCircleButton, ScreenHeader } from '../../src/components/screenHeader.js';
import { SectionHeader } from '../../src/components/sectionHeader.js';
import { SettingsCard, SettingsRow } from '../../src/components/settingsRow.js';
import { StatCard } from '../../src/components/statCard.js';
import { useRelayHostSelection } from '../../src/hooks/useRelayHostSelection.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, radius, space, squircle, type } from '../../src/theme.js';
import { useNow } from '../../src/time.js';
import { hapticImpact, hapticSelection } from '../../src/haptics.js';
import { CPU_THRESHOLDS, MEMORY_THRESHOLDS, formatCpu, usageLevel, usagePercent } from '../../src/systemResources.js';
import {
	formatLimitCountdown, pickRateLimitAccount, resourceLevelColor, staleValueLabel, todayCost, updatedAtLabel, usedRatio,
} from '../../src/usageFormat.js';
import type { GithubUsageResult, RateLimitProviderSnapshot, RateLimitWindow, RateLimitsResult, UsageDashboardResult } from '../../src/store.js';

/**
 * 「使用量」のまとめ画面。設定 →「使用量」、または PC の詳細 →「使用量」から開く。
 *
 * 以前は コスト / 利用上限 / RTK の節約 / GitHub API / システム の5画面を設定の最上段に並べていて、
 * 一目で見たい値（上限にどれだけ近いか、今日いくら使ったか）を知るにも1画面ずつ開く必要があった。
 * ここでは一目で見たい値だけを上に出し、詳しい内訳は下の行から各画面へ潜る。
 *
 * **データの取り方は各詳細画面と同じものを使う**（新しい種類の通信は足さない）。利用上限と
 * コストは PC 側の TTL キャッシュから返るので、開くたびに PC で集計し直すことはない。
 * CPU・メモリは desktop state に常時乗って届く値（ドロワーと同じ）で、ここからは問い合わせない。
 * RTK の節約は一目で見たい値ではないので、この画面では取得しない（開いたときだけ取る）。
 *
 * 接続先（ローカル/SSHリモート）の切替は画面上部で1回だけ。選んだ接続先はストア
 * （`selectedHostId`）に残るので、下の行から開いた詳細画面も同じ接続先の値を出す。
 */

const USAGE_DETAIL_LINKS = [
	{ route: '/ratelimit', icon: 'speedometer-outline', title: '利用上限', desc: 'Claude Code / Codex の制限をアカウントごとに確認します' },
	{ route: '/ccusage', icon: 'cash-outline', title: 'コスト', desc: 'トークン使用量とコストを日別・モデル別に確認します' },
	{ route: '/rtk', icon: 'cut-outline', title: 'RTK の節約', desc: 'RTKがコマンド出力から削ったトークン量を確認します' },
	{ route: '/github-usage', icon: 'logo-github', title: 'GitHub API', desc: 'GitHubのレート枠と、Para Codeが送ったリクエストの内訳を確認します' },
	{ route: '/system', icon: 'hardware-chip-outline', title: 'システム', desc: 'CPU・メモリ・ディスクと、何が使っているかを確認します' },
] as const;

type SectionError = { limits?: string; cost?: string; github?: string };

function errorMessage(reason: unknown): string {
	return String(reason instanceof Error ? reason.message : reason);
}

export default function UsageScreen() {
	const router = useRouter();
	// 設定モーダル内の画面なのでタブバーは無い。モーダル内の他画面と同じ下余白を使う。
	const insets = useStableInsets();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	// リセットまでの残り時間と「〜前に更新」を、開いたままでも進める
	const now = useNow();
	const { rateLimits, usageDashboard, githubUsage, connection, activePcId, pcs, resources } = useAppStore(useShallow(s => ({
		rateLimits: s.rateLimits,
		usageDashboard: s.usageDashboard,
		githubUsage: s.githubUsage,
		connection: s.connection,
		activePcId: s.activePcId,
		pcs: s.pcs,
		resources: s.workspace?.resources,
	})));
	const activePc = pcs.find(pc => pc.id === activePcId);

	// 接続先の扱いは 利用上限 / コスト / RTK の節約 の各画面と同じ（hosts が空なら従来経路、
	// 選んだ接続先が消えた・応答しないときは取得を止めて直近の値を薄く残す）。
	const { hosts, effectiveHostId, selectHost } = useRelayHostSelection();
	const selectedHost = hosts.find(host => host.id === effectiveHostId);
	const hostStale = hosts.length > 0 && selectedHost?.ready !== true;
	const hostKey = effectiveHostId ?? 'default';

	// 接続先ごとに直近の値を持つ（切り替えて戻ったときに再取得を待たせない）。GitHub はPC全体の値。
	const [limitsByHost, setLimitsByHost] = useState<Record<string, RateLimitsResult>>({});
	const [costByHost, setCostByHost] = useState<Record<string, UsageDashboardResult>>({});
	const [github, setGithub] = useState<GithubUsageResult | undefined>();
	const limits = limitsByHost[hostKey];
	const cost = costByHost[hostKey];
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [errors, setErrors] = useState<SectionError>({});

	// PCを切り替えたら前のPCの値を捨てる（'local'/'default' はPCをまたいで衝突するため）。
	useEffect(() => {
		setLimitsByHost({});
		setCostByHost({});
		setGithub(undefined);
		setErrors({});
	}, [activePcId]);

	// 3つを並行して取る。応答が前後したとき・途中でPCを切り替えたときに古い応答で上書きしない
	// よう、最後に投げた要求で、かつ投げたときと同じPCのものだけを採用する。
	const requestSeq = useRef(0);
	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') { return; }
		const seq = ++requestSeq.current;
		const pcAtStart = activePcId;
		const windowId = selectedHost?.windowId;
		setLoading(true);
		try {
			const [limitsResult, costResult, githubResult] = await Promise.allSettled([
				hostStale ? Promise.resolve(undefined) : rateLimits(bypassCache, windowId),
				hostStale ? Promise.resolve(undefined) : usageDashboard(bypassCache, windowId),
				githubUsage(bypassCache),
			]);
			if (seq !== requestSeq.current || useAppStore.getState().activePcId !== pcAtStart) { return; }
			if (limitsResult.status === 'fulfilled' && limitsResult.value !== undefined) {
				const value = limitsResult.value;
				setLimitsByHost(prev => ({ ...prev, [hostKey]: value }));
			}
			if (costResult.status === 'fulfilled' && costResult.value !== undefined) {
				const value = costResult.value;
				setCostByHost(prev => ({ ...prev, [hostKey]: value }));
			}
			if (githubResult.status === 'fulfilled') {
				setGithub(githubResult.value);
			}
			setErrors({
				limits: limitsResult.status === 'rejected' ? errorMessage(limitsResult.reason) : undefined,
				cost: costResult.status === 'rejected' ? errorMessage(costResult.reason) : undefined,
				github: githubResult.status === 'rejected' ? errorMessage(githubResult.reason) : undefined,
			});
		} finally {
			if (seq === requestSeq.current) {
				setLoading(false);
			}
		}
	}, [rateLimits, usageDashboard, githubUsage, connection, activePcId, hostStale, hostKey, selectedHost?.windowId]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	// **actions は参照を安定させる**（他の使用量の画面と同じ理由）。
	const headerActions = useMemo(() => (
		<HeaderCircleButton
			icon="refresh-outline"
			label="再取得"
			onPress={() => { hapticImpact('light'); void onPullRefresh(); }}
			disabled={pullRefreshing || loading}
		/>
	), [onPullRefresh, pullRefreshing, loading]);

	// 副題は「どのPCの、いつの値か」。複数の値のうち最も古いものの時刻を出す（新しい側を出すと、
	// 古い値まで新しいように読める）。
	const oldestFetchedAt = useMemo(() => {
		const times = [limits?.fetchedAt, cost?.fetchedAt].filter((t): t is number => t !== undefined);
		return times.length > 0 ? Math.min(...times) : undefined;
	}, [limits, cost]);
	const subtitle = [
		pcs.length > 1 ? activePc?.name : undefined,
		oldestFetchedAt !== undefined ? updatedAtLabel(oldestFetchedAt, now) : undefined,
	].filter((part): part is string => part !== undefined).join(' · ') || undefined;

	const core = github?.rateLimits.find(entry => entry.resource === 'core');
	const graphql = github?.rateLimits.find(entry => entry.resource === 'graphql');
	const githubRatio = core ? usedRatio(core.used, core.limit) : undefined;
	const memoryPercent = resources ? usagePercent(resources.memUsed, resources.memTotal) : undefined;

	const renderWindow = (label: string, window: RateLimitWindow | undefined) => {
		if (window === undefined) { return null; }
		const percent = Math.min(100, Math.max(0, window.usedPercent));
		const countdown = formatLimitCountdown(window.resetsAt, now);
		return (
			<View key={label} style={styles.meterRow}>
				<Text style={styles.meterLabel}>{label}</Text>
				<Meter ratio={percent / 100} />
				<Text style={styles.meterValue}>{Math.round(percent)}%</Text>
				<Text style={styles.meterSub} numberOfLines={1}>{countdown !== undefined ? `${countdown}後` : ''}</Text>
			</View>
		);
	};

	const renderProvider = (provider: 'claude' | 'codex', title: string, snapshot: RateLimitProviderSnapshot, first: boolean) => {
		const account = pickRateLimitAccount(snapshot);
		const others = snapshot.accounts.length - 1;
		return (
			<View style={[styles.provider, !first && styles.providerSeparator]}>
				<View style={styles.providerHead}>
					<ProviderLogo provider={provider} size={15} />
					<Text style={styles.providerName}>{title}</Text>
					{/* どのアカウントの値かを添える。他のアカウントは「利用上限」で見る。 */}
					{account !== undefined ? (
						<Text style={styles.providerAccount} numberOfLines={1}>
							{account.email ?? account.homeLabel ?? account.id}{others > 0 ? `（他 ${others}）` : ''}
						</Text>
					) : null}
				</View>
				{account === undefined ? (
					<Text style={styles.dim}>{snapshot.cswapMissing ? 'claude-swap (cswap) がPCにありません' : snapshot.sourceError ?? 'アカウントが見つかりません'}</Text>
				) : account.status !== 'ok' ? (
					<Text style={styles.dim}>使用状況を取得できていません（詳しくは「利用上限」で確認できます）</Text>
				) : account.fiveHour === undefined && account.sevenDay === undefined ? (
					<Text style={styles.dim}>使用状況データがありません</Text>
				) : (
					<>
						{renderWindow('5時間', account.fiveHour)}
						{renderWindow('7日', account.sevenDay)}
					</>
				)}
			</View>
		);
	};

	return (
		<ConnectionGate>
			<View style={styles.screen}>
				<ScreenHeader
					title="使用量"
					subtitle={subtitle}
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

					<SectionHeader first title="利用上限" />
					{errors.limits ? <Text style={styles.error}>{errors.limits}</Text> : null}
					{limits && hostStale ? <Text style={styles.staleNote}>{staleValueLabel(limits.fetchedAt, now)}</Text> : null}
					<View style={[styles.card, hostStale && styles.stale]}>
						{limits ? (
							<>
								{renderProvider('claude', 'Claude', limits.claude, true)}
								{renderProvider('codex', 'Codex', limits.codex, false)}
							</>
						) : loading ? (
							<ActivityIndicator style={styles.spinner} color={colors.accent} />
						) : (
							<Text style={styles.dim}>まだ取得していません</Text>
						)}
					</View>

					<SectionHeader title="コストと GitHub" />
					{errors.cost ? <Text style={styles.error}>{errors.cost}</Text> : null}
					{errors.github ? <Text style={styles.error}>{errors.github}</Text> : null}
					<View style={styles.kpiRow}>
						<StatCard
							label="今日のコスト"
							value={cost ? `$${todayCost(cost, now).toFixed(2)}` : '—'}
							sub={cost?.block?.costPerHour !== undefined ? `いまのブロック $${cost.block.costPerHour.toFixed(2)}/時` : undefined}
							style={hostStale ? styles.stale : undefined}
						/>
						{/* GitHub のレート枠は他の画面と同じく「使用率」で出す（残量は出さない）。 */}
						<StatCard
							label="GitHub 使用率"
							value={githubRatio !== undefined ? `${Math.round(githubRatio * 100)}%` : '—'}
							valueColor={githubRatio !== undefined ? meterColor(githubRatio) : undefined}
							sub={core
								? `REST ${core.used.toLocaleString()} / ${core.limit.toLocaleString()}${graphql ? ` · GraphQL ${Math.round(usedRatio(graphql.used, graphql.limit) * 100)}%` : ''}`
								: github && !github.ghAvailable ? 'gh が見つかりません' : undefined}
						/>
					</View>

					<SectionHeader title={`PC${activePc !== undefined && pcs.length > 1 ? `（${activePc.name}）` : ''}`} />
					<View style={styles.card}>
						{resources !== undefined && memoryPercent !== undefined ? (
							<>
								{/* しきい値はシステム画面・ドロワーと同じ（CPU・メモリ用の usageLevel）。 */}
								<View style={styles.meterRow}>
									<Text style={styles.meterLabel}>CPU</Text>
									<Meter ratio={(resources.cpu ?? 0) / 100} color={resourceLevelColor(usageLevel(resources.cpu ?? 0, CPU_THRESHOLDS))} />
									<Text style={styles.meterValue}>{formatCpu(resources.cpu)}</Text>
								</View>
								<View style={styles.meterRow}>
									<Text style={styles.meterLabel}>メモリ</Text>
									<Meter ratio={memoryPercent / 100} color={resourceLevelColor(usageLevel(memoryPercent, MEMORY_THRESHOLDS))} />
									<Text style={styles.meterValue}>{Math.round(memoryPercent)}%</Text>
								</View>
							</>
						) : (
							<Text style={styles.dim}>このPCからはリソースの値が届いていません（PC側の更新で出るようになります）</Text>
						)}
					</View>

					<SectionHeader title="詳しく見る" />
					<SettingsCard>
						{USAGE_DETAIL_LINKS.map(link => (
							<SettingsRow
								key={link.route}
								icon={link.icon}
								title={link.title}
								description={link.desc}
								onPress={() => { hapticSelection(); router.push(link.route); }}
							/>
						))}
					</SettingsCard>
				</ScrollView>
			</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1, paddingHorizontal: 16 },
	spinner: { marginVertical: space.lg },
	error: { color: colors.red, fontSize: type.meta, marginBottom: space.sm, paddingHorizontal: space.xs },
	warn: { color: colors.yellow, fontSize: type.meta, lineHeight: 17, marginTop: 4, marginBottom: 4 },
	// 応答しない接続先の直近の値は薄く残し、いつの値かを staleNote で文字にする。
	stale: { opacity: 0.5 },
	staleNote: { color: colors.textDim, fontSize: type.meta, lineHeight: 17, marginBottom: space.sm, paddingHorizontal: space.xs },
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 4 },
	dim: { color: colors.textDim, fontSize: type.meta, lineHeight: 17, paddingVertical: 8 },
	provider: { paddingVertical: 8 },
	providerSeparator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	providerHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4, minWidth: 0 },
	providerName: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	providerAccount: { color: colors.textDim, fontSize: type.caption, flexShrink: 1, marginLeft: 'auto' },
	// 利用上限の画面と同じ並び（名前・メーター・使用率・リセットまで）。
	meterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
	meterLabel: { color: colors.text, fontSize: type.meta, width: 44 },
	meterValue: { color: colors.textDim, fontSize: type.meta, width: 40, textAlign: 'right', fontVariant: ['tabular-nums'] },
	meterSub: { color: colors.textDim, fontSize: type.caption, width: 64, textAlign: 'right', fontVariant: ['tabular-nums'] },
	kpiRow: { flexDirection: 'row', gap: 10 },
});
