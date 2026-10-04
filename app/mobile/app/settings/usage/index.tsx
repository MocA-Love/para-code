// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState, type ReactNode } from 'react';
import { RefreshControl, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { Activity, Cpu, Cuboid, GitPullRequest, Scissors, User } from 'lucide-react-native';
import { useAppStore, usePcResources } from '../../../src/appState.js';
import { useIsRegularWidth } from '../../../src/hooks/useSizeClass.js';
import { USAGE_PROVIDER_COLUMN_GAP, usageMetersPerRowFor, usageProviderColumnWidthFor } from '../../../src/ipad/ipadLayout.js';
import { haptic } from '../../../src/haptics.js';
import { alpha, colors, space, type } from '../../../src/theme.js';
import { useNow } from '../../../src/time.js';
import { staleValueLabel, todayCost, updatedAtLabel } from '../../../src/usageFormat.js';
import { Icon, ListGroup, ListRow, Meter, MeterRow, iconSize } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { settingsRoutes, type UsageDetailPage } from '../../../src/features/settings/settingsRoutes.js';
import { UsageHostPicker } from '../../../src/features/settings/usageHost.js';
import { DetailMessage, DetailNotConnected, DetailRefreshButton } from '../../../src/features/settings/usageDetailParts.js';
import { ProviderUsageSection, UsageBigValue, UsageRow, UsageRowTitle, UsageSection, UsageSeparator } from '../../../src/features/settings/usageSections.js';
import { formatUsd, ratioPercent, recentDailyAverage, usageFootNote } from '../../../src/features/settings/usageSummary.js';
import {
	aggregateAccounts,
	entryTitle,
	hasAnyLimits,
	isOldValue,
	latestProviderSnapshot,
	scopeCountLabel,
	summarizeCost,
	summarizeGithub,
	type UsageKind,
} from '../../../src/features/usage/usageAggregate.js';
import {
	AggregatedFetchNotes,
	AggregatedProviderSection,
	SeenOnChips,
	UsageEntryRows,
	UsageFetchNote,
	fetchNoteItems,
} from '../../../src/features/usage/usageOverviewParts.js';
import { useUsageAutoRefresh, useUsageOverview, useUsageStore } from '../../../src/features/usage/usageStore.js';
import { useUsageScope } from '../../../src/features/usage/useUsageScope.js';

const DETAIL_LINKS: readonly { readonly page: UsageDetailPage; readonly label: string; readonly hint: string; readonly icon: typeof Activity }[] = [
	{ page: 'cost', label: 'コスト', hint: 'トークンとコストを日別・モデル別に', icon: Activity },
	{ page: 'rtk', label: 'RTK の節約', hint: 'コマンドの出力から削ったトークン', icon: Scissors },
	{ page: 'github', label: 'GitHub API', hint: 'レート枠と、送ったリクエストの内訳', icon: GitPullRequest },
	{ page: 'system', label: 'システム', hint: 'CPU・メモリ・ディスクと、何が使っているか', icon: Cuboid },
];

const KINDS: readonly UsageKind[] = ['limits', 'cost', 'github'];

/**
 * 使用量（`/settings/usage`。Orca の accounts、モックの「使用量」）。
 *
 * PC が2台以上なら全 PC の合計（案 B）: Claude / Codex はアカウントごとに1行（見えている PC をチップで添える）、
 * 今日のコストは足した値、GitHub のレート枠はアカウントごと、その下に「PC ごと」の行。行を押すとその PC だけの表示
 * （`?source=`）へ進む。PC が1台なら今までどおり、その PC の値を接続先（ローカル / SSH）を選んで見る。
 *
 * 値は `usageStore.ts` が全 PC（と SSH の接続先）から集め、最後に取れた値を 7 日残す。オフラインの PC は最後の値を
 * 薄く出して合計に入れる（今日のコストは今日取れた分だけ）。CPU・メモリ・SSD は desktop state の値だけを使う。
 */
export default function UsageScreen() {
	const { scope } = useUsageScope();
	return scope.kind === 'all' ? <UsageAllView /> : <UsageSourceView />;
}

function useRefreshControl(kinds: readonly UsageKind[], sourceKeys: readonly string[] | undefined) {
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const sourcesKey = sourceKeys?.join('\u0000');
	const kindsKey = kinds.join(',');
	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await useUsageStore.getState().refresh(kindsKey.split(',') as UsageKind[], { bypassCache: true, ...(sourcesKey !== undefined ? { sourceKeys: sourcesKey.split('\u0000') } : {}) });
		} finally {
			setPullRefreshing(false);
		}
	}, [kindsKey, sourcesKey]);
	return { pullRefreshing, onPullRefresh };
}

/** 列の幅で決まる束の出し方（{@link ProviderColumns} が渡す）。 */
interface ProviderColumnLayout {
	/** リセットの期限の一覧を最初から開く（左右に並べたとき）。 */
	readonly expandResets: boolean;
	/** アカウントの行のメーターを1行に何個並べるか。 */
	readonly metersPerRow: 1 | 2;
}

/**
 * Claude と Codex の2つの束。iPad の広い幅で本文に収まるときは左右に並べ、リセットの期限の一覧を最初から開く。
 * 並べ方はスタイルだけで変え、木の形は変えない（幅は本文の実際の幅を測る。ウィンドウ幅ではない）。
 * 列の幅は `usageProviderColumnWidthFor` で決め、列の幅にメーター2つが収まらなければ1つずつ積む（`usageMetersPerRowFor`）。
 */
function ProviderColumns({ claude, codex }: { claude: (layout: ProviderColumnLayout) => ReactNode; codex: (layout: ProviderColumnLayout) => ReactNode }) {
	const regular = useIsRegularWidth();
	const [width, setWidth] = useState(0);
	const columnWidth = usageProviderColumnWidthFor(regular, width);
	const twoColumns = columnWidth !== undefined;
	const onLayout = useCallback((event: LayoutChangeEvent) => {
		const next = Math.floor(event.nativeEvent.layout.width);
		setWidth(prev => (prev === next ? prev : next));
	}, []);
	// 列には測った幅から決めた幅をそのまま当てる（flex で割ると中身の幅で押し広げられて本文の外へはみ出す）
	const columnStyle = twoColumns ? { width: columnWidth } : undefined;
	const layout: ProviderColumnLayout = { expandResets: twoColumns, metersPerRow: usageMetersPerRowFor(columnWidth) };
	return (
		<View style={twoColumns ? styles.providerRow : undefined} onLayout={onLayout}>
			<View style={columnStyle}>{claude(layout)}</View>
			<View style={columnStyle}>{codex(layout)}</View>
		</View>
	);
}

function useOpenDetail(source: string | undefined) {
	const router = useRouter();
	return (page: UsageDetailPage) => {
		haptic('move');
		router.push(settingsRoutes.usageDetail(page, source));
	};
}

// --- 全 PC の合計 ------------------------------------------------------------------

function UsageAllView() {
	const router = useRouter();
	const now = useNow();
	const overview = useUsageOverview();
	const entries = overview.entries;
	useUsageAutoRefresh(KINDS);
	const { pullRefreshing, onPullRefresh } = useRefreshControl(KINDS, undefined);
	const openDetail = useOpenDetail(undefined);
	const anyOnline = entries.some(entry => entry.online);

	const claude = aggregateAccounts(entries, 'claude', now);
	const codex = aggregateAccounts(entries, 'codex', now);
	const anyLimits = hasAnyLimits(entries);
	const cost = summarizeCost(entries, now);
	const github = summarizeGithub(entries, now);
	const average = cost.merged !== undefined ? recentDailyAverage(cost.merged, now) : undefined;
	const limitsLoading = overview.isLoading('limits');
	const costLoading = overview.isLoading('cost');
	const githubLoading = overview.isLoading('github');
	const onlineCount = entries.filter(entry => entry.online).length;
	const subtitle = `${scopeCountLabel(entries)}の合計${onlineCount < entries.length ? `（オフライン ${entries.length - onlineCount}）` : ''}`;
	const costValues = Object.fromEntries(cost.rows.map(row => [row.key, { value: row.today !== undefined ? formatUsd(row.today) : undefined, at: row.at }]));
	const nothing = !anyOnline && entries.every(entry => entry.values.limits === undefined && entry.values.cost === undefined && entry.values.github === undefined);

	return (
		<SettingsScreen
			title="使用量"
			subtitle={subtitle}
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing || !anyOnline} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { haptic('edge'); void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			{nothing ? <DetailNotConnected /> : (
				<>
					<AggregatedFetchNotes items={fetchNoteItems(overview, 'limits')} now={now} />
					<ProviderColumns
						claude={layout => <AggregatedProviderSection provider="claude" title="Claude" accounts={claude} emptySnapshot={latestProviderSnapshot(entries, 'claude')} anyLimits={anyLimits} loading={limitsLoading} now={now} showChips {...layout} />}
						codex={layout => <AggregatedProviderSection provider="codex" title="Codex" accounts={codex} emptySnapshot={latestProviderSnapshot(entries, 'codex')} anyLimits={anyLimits} loading={limitsLoading} now={now} showChips {...layout} />}
					/>

					<AggregatedFetchNotes items={fetchNoteItems(overview, 'cost')} now={now} />
					<UsageSection title="今日のコスト" icon={Activity} onPress={() => openDetail('cost')}>
						<UsageRow trailing="chevron">
							<UsageBigValue>{cost.today !== undefined ? formatUsd(cost.today) : '—'}</UsageBigValue>
							<Text style={styles.small}>
								{cost.today === undefined && cost.merged === undefined
									? (costLoading ? '取得しています…' : 'まだ取得していません')
									: `${average !== undefined ? `7日平均 ${formatUsd(average)} · ` : ''}全 PC・すべてのエージェントの合計`}
							</Text>
							{cost.missingToday.length > 0 && cost.missingToday.length < entries.length ? (
								<Text style={styles.small}>{`${cost.missingToday.join('・')} は今日の値を取れていないため、合計に入っていません`}</Text>
							) : null}
						</UsageRow>
					</UsageSection>

					<AggregatedFetchNotes items={fetchNoteItems(overview, 'github')} now={now} />
					<UsageSection title="GitHub" icon={GitPullRequest} onPress={() => openDetail('github')}>
						{github.accounts.length === 0 ? (
							<UsageRow trailing="chevron">
								<UsageRowTitle title={githubLoading ? '取得しています…' : 'まだ取得していません'} />
							</UsageRow>
						) : github.accounts.map((account, index) => {
							const core = account.rateLimits.find(entry => entry.resource === 'core');
							const graphql = account.rateLimits.find(entry => entry.resource === 'graphql');
							return (
								<View key={account.key}>
									{index > 0 ? <UsageSeparator /> : null}
									<UsageRow trailing={index === 0 ? 'chevron' : undefined}>
										<View style={[styles.githubBody, account.old ? styles.old : undefined]}>
											<UsageRowTitle
												title={account.label}
												hint={core === undefined && graphql === undefined
													? (!account.ghAvailable ? 'PC に gh が見つかりません' : account.rateLimitError ?? 'レート枠を取得できませんでした')
													: account.login === undefined ? 'アカウント名の届かない PC（PC ごとに表示）' : undefined}
											/>
											{core !== undefined || graphql !== undefined ? (
												<MeterRow>
													<Meter label="REST" percent={core !== undefined ? ratioPercent(core.used, core.limit) : undefined} />
													<Meter label="GraphQL" percent={graphql !== undefined ? ratioPercent(graphql.used, graphql.limit) : undefined} />
												</MeterRow>
											) : null}
										</View>
										<SeenOnChips chips={account.seenOn} />
									</UsageRow>
								</View>
							);
						})}
						{github.merged !== undefined ? (
							<>
								<UsageSeparator />
								<UsageRow>
									<Text style={styles.small}>{`直近5分の呼び出し ${github.merged.totals.rolling5mCalls.toLocaleString()} 件 · 全 PC の合計`}</Text>
								</UsageRow>
							</>
						) : null}
					</UsageSection>

					<GroupHeader title="PC ごと" first />
					<UsageEntryRows
						entries={entries}
						values={costValues}
						now={now}
						onOpen={entry => { haptic('move'); router.push(settingsRoutes.usageSource(entry.key)); }}
					/>

					<GroupHeader title="詳しく見る（全 PC）" first />
					<ListGroup>
						{DETAIL_LINKS.map(link => (
							<ListRow key={link.page} icon={link.icon} label={link.label} hint={link.hint} trailing="chevron" onPress={() => openDetail(link.page)} />
						))}
					</ListGroup>

					<View style={styles.foot}>
						<Icon icon={User} size={iconSize.sm} color={colors.textMuted} />
						<Text style={styles.footText}>同じアカウントを複数の PC で使っていても、上限は1つにまとめて出します（足しません）。オフラインの PC は最後に取れた値を薄く出します。アカウントの追加や再ログインは、PC の Para Code から行います。</Text>
					</View>
				</>
			)}
		</SettingsScreen>
	);
}

// --- 1つの出どころ ---------------------------------------------------------------

function UsageSourceView() {
	const now = useNow();
	const { scope, host, showHostPicker, sourceParam } = useUsageScope();
	const key = scope.kind === 'source' ? scope.key : '';
	const pcs = useAppStore(s => s.pcs);
	// CPU・メモリ・SSD は一覧（PcSummary）に載せず、使用量の画面だけがこの別の値を読む
	const resourcesByPc = usePcResources(s => s.byPc);
	const overview = useUsageOverview();
	const source = overview.sources.find(item => item.key === key);
	const entry = overview.entries.find(item => item.sourceKeys.includes(key));
	const pc = pcs.find(item => item.id === source?.pcId);
	const values = overview.valuesOf(key);
	const online = source?.online === true;
	const isPc = source?.kind !== 'ssh';
	const kinds: readonly UsageKind[] = isPc ? KINDS : ['limits', 'cost'];
	useUsageAutoRefresh(kinds, [key]);
	const { pullRefreshing, onPullRefresh } = useRefreshControl(kinds, [key]);
	const openDetail = useOpenDetail(sourceParam);

	const limits = values?.limits;
	const cost = values?.cost;
	const github = isPc ? values?.github : undefined;
	// 取りに行けない出どころ（オフラインの PC・応答しない接続先）の値は薄く残す。
	const dimmed = !online;
	const fetchedTimes = [limits?.at, cost?.at].filter((t): t is number => t !== undefined);
	const oldestFetchedAt = fetchedTimes.length > 0 ? Math.min(...fetchedTimes) : undefined;
	const label = source?.kind === 'ssh' ? `${source.hostLabel ?? ''}（${source.pcName} から SSH）` : entry !== undefined ? entryTitle(entry) : source?.pcName;
	const subtitle = [
		pcs.length > 1 || sourceParam !== undefined ? label : pc?.name,
		oldestFetchedAt !== undefined ? updatedAtLabel(oldestFetchedAt, now) : undefined,
	].filter((part): part is string => part !== undefined && part.length > 0).join(' · ') || undefined;

	const core = github?.value.rateLimits.find(item => item.resource === 'core');
	const graphql = github?.value.rateLimits.find(item => item.resource === 'graphql');
	const average = cost !== undefined ? recentDailyAverage(cost.value, now) : undefined;
	const resources = isPc && source !== undefined ? resourcesByPc[source.pcId] : undefined;
	const loadingLimits = overview.isLoading('limits', key);
	const loadingCost = overview.isLoading('cost', key);
	const loadingGithub = overview.isLoading('github', key);
	const notConnected = !online && limits === undefined && cost === undefined && github === undefined;
	const staleNote = (value: { value: { stale?: boolean }; at: number } | undefined) => (value?.value.stale === true ? value.at : undefined);

	return (
		<SettingsScreen
			title="使用量"
			subtitle={subtitle}
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing || !online} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { haptic('edge'); void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			{notConnected ? <DetailNotConnected /> : (
				<>
					{showHostPicker ? <UsageHostPicker host={host} /> : null}
					<UsageFetchNote error={overview.errorOf(key, 'limits')} hasPrevious={limits !== undefined} staleAt={staleNote(limits)} now={now} />
					{limits !== undefined && dimmed ? <DetailMessage tone="note">{staleValueLabel(limits.at, now)}</DetailMessage> : null}
					<ProviderColumns
						claude={layout => <ProviderUsageSection provider="claude" title="Claude" snapshot={limits?.value.claude} now={now} loading={loadingLimits} dimmed={dimmed || (entry !== undefined && isOldValue(entry, limits, now))} {...layout} />}
						codex={layout => <ProviderUsageSection provider="codex" title="Codex" snapshot={limits?.value.codex} now={now} loading={loadingLimits} dimmed={dimmed || (entry !== undefined && isOldValue(entry, limits, now))} {...layout} />}
					/>

					<UsageFetchNote error={overview.errorOf(key, 'cost')} hasPrevious={cost !== undefined} staleAt={staleNote(cost)} now={now} />
					<UsageSection title="今日のコスト" icon={Activity} onPress={() => openDetail('cost')} dimmed={dimmed}>
						<UsageRow trailing="chevron">
							<UsageBigValue>{cost !== undefined ? formatUsd(todayCost(cost.value, now)) : '—'}</UsageBigValue>
							<Text style={styles.small}>
								{cost === undefined
									? (loadingCost ? '取得しています…' : 'まだ取得していません')
									: `${average !== undefined ? `7日平均 ${formatUsd(average)} · ` : ''}すべてのエージェントの合計`}
							</Text>
						</UsageRow>
					</UsageSection>

					{isPc ? (
						<>
							<UsageFetchNote error={overview.errorOf(key, 'github')} hasPrevious={github !== undefined} staleAt={staleNote(github)} now={now} />
							<UsageSection title="GitHub" icon={GitPullRequest} onPress={() => openDetail('github')} dimmed={dimmed}>
								<UsageRow trailing="chevron">
									{core !== undefined || graphql !== undefined ? (
										<MeterRow>
											<Meter label="REST" percent={core !== undefined ? ratioPercent(core.used, core.limit) : undefined} />
											<Meter label="GraphQL" percent={graphql !== undefined ? ratioPercent(graphql.used, graphql.limit) : undefined} />
										</MeterRow>
									) : (
										<UsageRowTitle
											title={github === undefined ? (loadingGithub ? '取得しています…' : 'まだ取得していません') : 'レート枠を取得できませんでした'}
											hint={github !== undefined && !github.value.ghAvailable ? 'PC に gh が見つかりません' : github?.value.rateLimitError}
										/>
									)}
								</UsageRow>
							</UsageSection>

							<UsageSection title={`PC の状態${pc !== undefined && pcs.length > 1 ? `（${pc.name}）` : ''}`} icon={Cpu} onPress={() => openDetail('system')} dimmed={dimmed}>
								<UsageRow trailing="chevron">
									{resources !== undefined ? (
										<>
											<MeterRow>
												<Meter label="CPU" percent={resources.cpu} />
												<Meter label="メモリ" percent={resources.memPercent} />
											</MeterRow>
											<MeterRow>
												<Meter label="SSD" percent={resources.diskPercent} />
												<View style={styles.spacer} />
											</MeterRow>
										</>
									) : (
										<UsageRowTitle title="値が届いていません" hint="この PC からはリソースの値が届いていません（PC 側の更新で出るようになります）" />
									)}
								</UsageRow>
							</UsageSection>
						</>
					) : null}

					<GroupHeader title="詳しく見る" first />
					<ListGroup>
						{DETAIL_LINKS.filter(link => isPc || link.page === 'cost' || link.page === 'rtk').map(link => (
							<ListRow key={link.page} icon={link.icon} label={link.label} hint={link.hint} trailing="chevron" onPress={() => openDetail(link.page)} />
						))}
					</ListGroup>

					<View style={styles.foot}>
						<Icon icon={User} size={iconSize.sm} color={colors.textMuted} />
						<Text style={styles.footText}>{usageFootNote(limits?.value.claude)}</Text>
					</View>
				</>
			)}
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	small: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	old: {
		opacity: alpha.strong,
	},
	githubBody: {
		gap: space.xs,
	},
	spacer: {
		flex: 1,
	},
	providerRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: USAGE_PROVIDER_COLUMN_GAP,
	},
	foot: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm,
		marginTop: space.xl,
		paddingHorizontal: space.xs,
	},
	footText: {
		flex: 1,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
});
