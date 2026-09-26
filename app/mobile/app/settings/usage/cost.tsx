// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../src/appState.js';
import { useAppIsActive } from '../../../src/hooks/useAppIsActive.js';
import { MobileWarmLeaseLifecycle, type UsageAgent, type UsageDashboardResult } from '../../../src/store.js';
import { colors } from '../../../src/theme.js';
import { formatRelativeTime, useNow } from '../../../src/time.js';
import { localDateKey, dayCost, staleValueLabel, updatedAtLabel } from '../../../src/usageFormat.js';
import { ListGroup, ListRow } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { UsageHostPicker, useUsageHost } from '../../../src/features/settings/usageHost.js';
import { formatUsd } from '../../../src/features/settings/usageSummary.js';
import {
	AGENT_LABEL,
	agentsInData,
	aggregateModels,
	aggregateProjects,
	barPercent,
	formatCompactTokens,
	recentDailyCosts,
	updateCostWarmLeaseLifecycle,
	type AgentFilter,
} from '../../../src/features/settings/usageDetailModel.js';
import {
	BarItem,
	ChoiceChips,
	DetailCard,
	DetailEmptyLine,
	DetailLoading,
	DetailMessage,
	DetailNotConnected,
	DetailRefreshButton,
	InlineBarRow,
	StatTile,
	StatTiles,
	staleStyle,
} from '../../../src/features/settings/usageDetailParts.js';

/** モデル・プロジェクト・セッションの表示上限。 */
const TOP_MODELS = 6;
const TOP_PROJECTS = 6;
const TOP_SESSIONS = 10;
/** 「日別」は最近の推移を見るためのものなので、集計期間とは別に直近7日で固定する。 */
const DAILY_WINDOW_DAYS = 7;
/** モデル別・プロジェクト別の集計期間（PC からは90日ぶん届いている）。 */
type PeriodDays = '7' | '30' | '90';
const PERIOD_OPTIONS: readonly { value: PeriodDays; label: string }[] = [
	{ value: '7', label: '7日' },
	{ value: '30', label: '30日' },
	{ value: '90', label: '90日' },
];

/** モデルの棒の色（エージェントを見分ける。同じ画面では他の意味に使わない）。 */
const AGENT_COLOR: Record<UsageAgent, string> = {
	claude: colors.claude,
	codex: colors.blue,
	gemini: colors.purple,
	other: colors.textDim,
};

/**
 * コスト（`/settings/usage/cost`）。ccusage が集計したトークンとコストを、日別・モデル別・
 * プロジェクト別・直近のセッションで見る（旧 `legacy-screens/(settings)/ccusage.tsx` の作り直し）。
 *
 * 取り方は旧画面のまま: 開いている間だけ PC 側のキャッシュを温め（warm lease）、接続先
 * （ローカル / SSH のリモート）ごとに直近の値を持ち、PC を切り替えたら前の PC の値を捨てる。
 */
export default function CostScreen() {
	const now = useNow();
	const { usageDashboard, connection, warmLeaseReady, activePcId, controllerRevision, acquireUsageWarmLease, pcs } = useAppStore(useShallow(s => ({
		usageDashboard: s.usageDashboard,
		connection: s.connection,
		warmLeaseReady: s.connection === 'online' && s.pcOnline && s.sessionProtocolReady,
		activePcId: s.activePcId,
		controllerRevision: s.controllerRevision,
		acquireUsageWarmLease: s.acquireUsageWarmLease,
		pcs: s.pcs,
	})));
	const isFocused = useIsFocused();
	const isAppActive = useAppIsActive();
	const host = useUsageHost();
	const windowId = host.selectedHost?.windowId;

	const warmLeaseLifecycle = useRef<MobileWarmLeaseLifecycle | undefined>(undefined);
	warmLeaseLifecycle.current ??= new MobileWarmLeaseLifecycle();
	useEffect(() => {
		const lifecycle = warmLeaseLifecycle.current;
		if (lifecycle === undefined) {
			return undefined;
		}
		updateCostWarmLeaseLifecycle(lifecycle, {
			focused: isFocused,
			appActive: isAppActive,
			online: warmLeaseReady,
			activePcId,
			controllerRevision,
		}, () => acquireUsageWarmLease(windowId));
		// active=false の update は factory を呼ばない（既存の lease を手放すだけ）ので、何も取らないものを渡す。
		return () => lifecycle.update(false, () => ({ dispose: () => { } }));
	}, [isFocused, isAppActive, warmLeaseReady, activePcId, controllerRevision, acquireUsageWarmLease, windowId]);

	// 接続先ごとに直近の値を持つ（切り替えても他の接続先の値は消えない）。
	const [dataByHost, setDataByHost] = useState<Record<string, UsageDashboardResult>>({});
	const data = dataByHost[host.key];
	const [loading, setLoading] = useState(false);
	// 引っ張って更新したときだけ RefreshControl のくるくるを出す（初回の読み込みと二重に出さない）。
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [periodDays, setPeriodDays] = useState<PeriodDays>('30');
	const [agentFilter, setAgentFilter] = useState<AgentFilter>('all');

	// PC を切り替えたら前の PC の値を捨てる（'local' / 'default' は PC をまたいで同じ鍵になる）。
	useEffect(() => { setDataByHost({}); }, [activePcId]);

	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online' || host.stale) {
			return;
		}
		const key = host.key;
		setLoading(true);
		setError(undefined);
		try {
			const result = await usageDashboard(bypassCache, windowId);
			setDataByHost(prev => ({ ...prev, [key]: result }));
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [usageDashboard, connection, host.stale, host.key, windowId]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	const availableAgents = useMemo(() => (data !== undefined ? agentsInData(data) : []), [data]);
	// データからそのエージェントが消える（90日の縁など）と選択肢が出なくなる。選択だけが残ると
	// 全部 0 円の画面から戻れなくなるので「すべて」へ落とす。
	useEffect(() => {
		if (agentFilter !== 'all' && data !== undefined && !availableAgents.includes(agentFilter)) {
			setAgentFilter('all');
		}
	}, [agentFilter, availableAgents, data]);

	const period = Number(periodDays);
	const todayCost = data !== undefined
		? (() => {
			const row = data.days.find(d => d.date === localDateKey(new Date(now)));
			return row !== undefined ? dayCost(row, agentFilter) : 0;
		})()
		: undefined;
	const dailyCosts = data !== undefined ? recentDailyCosts(data, DAILY_WINDOW_DAYS, agentFilter, now) : [];
	const maxDailyCost = Math.max(0.01, ...dailyCosts.map(d => d.cost));
	const models = data !== undefined ? aggregateModels(data, period, agentFilter, now).slice(0, TOP_MODELS) : [];
	const maxModelCost = Math.max(0.01, ...models.map(m => m.cost));
	const projects = data !== undefined ? aggregateProjects(data, period, now).slice(0, TOP_PROJECTS) : [];
	const maxProjectCost = Math.max(0.01, ...projects.map(p => p.cost));
	const sessions = (data?.sessions ?? []).slice(0, TOP_SESSIONS);
	const agentFiltered = agentFilter !== 'all';
	const activePc = pcs.find(pc => pc.id === activePcId);

	// PC 側は30分ごとに裏で集計し直す。いつの数字かが分からないと更新すべきか判断できないので、取得時刻を必ず添える。
	const subtitle = [
		pcs.length > 1 ? activePc?.name : undefined,
		data !== undefined ? updatedAtLabel(data.fetchedAt, now) : undefined,
	].filter((part): part is string => part !== undefined).join(' · ') || undefined;

	return (
		<SettingsScreen
			title="コスト"
			subtitle={subtitle}
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing || loading} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			<UsageHostPicker host={host} />
			{loading && data === undefined ? <DetailLoading /> : null}
			{error !== undefined ? <DetailMessage tone="error">{error}</DetailMessage> : null}
			{data !== undefined && data.failedReports.length > 0 ? (
				<DetailMessage tone="warn">一部のレポートを取得できませんでした（{data.failedReports.join(', ')}）</DetailMessage>
			) : null}
			{/* 薄くするだけだと読み込み中と見分けが付かないので、いつの値かを文字で添える。 */}
			{data !== undefined && host.stale ? <DetailMessage tone="note">{staleValueLabel(data.fetchedAt, now)}</DetailMessage> : null}
			{data === undefined && connection !== 'online' ? <DetailNotConnected /> : null}

			{data !== undefined ? (
				<View style={host.stale ? staleStyle : undefined}>
					{/* 絞り込みは、それが効く数字より先に出す（後ろに置くと、押しても上の数字が変わったことに気づけない）。 */}
					{availableAgents.length > 1 ? (
						<>
							<GroupHeader title="エージェント" first />
							<ChoiceChips
								options={[{ value: 'all' as AgentFilter, label: 'すべて' }, ...availableAgents.map(agent => ({ value: agent as AgentFilter, label: AGENT_LABEL[agent] }))]}
								selected={agentFilter}
								onSelect={setAgentFilter}
							/>
						</>
					) : null}

					<GroupHeader title="今日" first={availableAgents.length <= 1} />
					<StatTiles>
						<StatTile
							label="今日のコスト"
							value={formatUsd(todayCost ?? 0)}
							sub={agentFiltered ? `${AGENT_LABEL[agentFilter]}のみ` : undefined}
						/>
						{data.block !== undefined ? (
							<StatTile
								label="いまのブロック"
								value={formatUsd(data.block.costUSD)}
								// ブロックはエージェント別の内訳を持たないので、絞り込み中は隣と集計範囲が違うことを書く。
								sub={agentFiltered
									? 'すべてのエージェント'
									: data.block.costPerHour !== undefined ? `${formatUsd(data.block.costPerHour)}/時` : undefined}
							/>
						) : null}
					</StatTiles>

					<GroupHeader title={`日別（直近${DAILY_WINDOW_DAYS}日）`} />
					<DetailCard>
						{dailyCosts.map(day => (
							<InlineBarRow
								key={day.date}
								label={day.date.slice(5)}
								value={formatUsd(day.cost)}
								percent={barPercent(day.cost, maxDailyCost)}
								color={colors.blue}
							/>
						))}
					</DetailCard>

					<GroupHeader title="集計期間" />
					<ChoiceChips options={PERIOD_OPTIONS} selected={periodDays} onSelect={setPeriodDays} />

					<GroupHeader title={`モデル別（直近${period}日）`} />
					<DetailCard>
						{models.length === 0 ? <DetailEmptyLine>データがありません</DetailEmptyLine> : null}
						{models.map(model => (
							<BarItem
								key={model.model}
								name={model.model}
								value={formatUsd(model.cost)}
								sub={`${AGENT_LABEL[model.agent]} · ${formatCompactTokens(model.tokens)} tok`}
								segments={[{ percent: barPercent(model.cost, maxModelCost), color: AGENT_COLOR[model.agent] }]}
							/>
						))}
					</DetailCard>

					<GroupHeader title={`プロジェクト別（直近${period}日）`} />
					<DetailCard>
						{projects.length === 0 ? <DetailEmptyLine>データがありません</DetailEmptyLine> : null}
						{projects.map(project => (
							<BarItem
								key={project.name}
								name={project.name}
								value={formatUsd(project.cost)}
								segments={[{ percent: barPercent(project.cost, maxProjectCost), color: colors.blue }]}
							/>
						))}
					</DetailCard>
					{agentFiltered && projects.length > 0 ? (
						<DetailMessage tone="note">プロジェクト別はエージェントの内訳を持たないため、すべてのエージェントの合計を出しています。</DetailMessage>
					) : null}

					{/* セッションは PC が「直近のもの」を選んで送ってくるので、期間もエージェントも効かない。 */}
					<GroupHeader title={`直近のセッション${agentFiltered ? '（すべてのエージェント）' : ''}`} />
					{sessions.length === 0 ? (
						<DetailCard><DetailEmptyLine>データがありません</DetailEmptyLine></DetailCard>
					) : (
						<ListGroup>
							{sessions.map((session, index) => (
								<ListRow
									key={`${session.rawProject}-${index}`}
									label={session.project}
									hint={`${session.models.join(', ') || '—'} · ${formatCompactTokens(session.totalTokens)} tok · ${session.lastActivity !== undefined ? formatRelativeTime(session.lastActivity, now) : '—'}`}
									value={formatUsd(session.totalCost)}
								/>
							))}
						</ListGroup>
					)}
				</View>
			) : null}
		</SettingsScreen>
	);
}
