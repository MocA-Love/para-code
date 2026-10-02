// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { haptic } from '../../../src/haptics.js';
import { colors, type } from '../../../src/theme.js';
import { useNow } from '../../../src/time.js';
import { localDateKey, staleValueLabel, updatedAtLabel } from '../../../src/usageFormat.js';
import { ListGroup, ListRow } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { UsageHostPicker } from '../../../src/features/settings/usageHost.js';
import { settingsRoutes } from '../../../src/features/settings/settingsRoutes.js';
import { scopeCountLabel, summarizeRtk, type UsageKind } from '../../../src/features/usage/usageAggregate.js';
import { AggregatedFetchNotes, UsageEntryRows, UsageFetchNote, fetchNoteItems } from '../../../src/features/usage/usageOverviewParts.js';
import { useUsageAutoRefresh, useUsageOverview, useUsageStore } from '../../../src/features/usage/usageStore.js';
import { useUsageScope } from '../../../src/features/usage/useUsageScope.js';
import { barPercent, formatTokens, recentRtkDays, savingsPercent } from '../../../src/features/settings/usageDetailModel.js';
import {
	BarItem,
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

const RTK_KINDS: readonly UsageKind[] = ['rtk'];
/** 日別の推移は直近7日で固定する。 */
const DAILY_WINDOW_DAYS = 7;
/** コマンド別・直近のコマンドの表示上限。 */
const TOP_COMMANDS = 10;
const TOP_HISTORY = 12;

/**
 * RTK の節約（`/settings/usage/rtk`）。RTK がコマンドの出力から削ったトークン量を、今日・累計・日別・
 * コマンド別・直近のコマンドで見る（旧 `legacy-screens/(settings)/rtk.tsx` の作り直し）。
 *
 * RTK はコマンドを実行したホストのローカル DB に記録するので、接続先（ローカル / SSH のリモート）ごとに
 * 値が別物になる。PC が2台以上なら全 PC（と SSH の接続先）を足した値と「PC ごと」の行を出し、行を押すと
 * その出どころだけの値（`?source=`）へ進む。PC が1台なら今までどおり接続先を選んで見る。
 */
export default function RtkScreen() {
	const now = useNow();
	const router = useRouter();
	const { scope, host, showHostPicker, sourceParam } = useUsageScope();
	const overview = useUsageOverview();
	const sourceKey = scope.kind === 'source' ? scope.key : undefined;
	const source = sourceKey !== undefined ? overview.sources.find(item => item.key === sourceKey) : undefined;
	useUsageAutoRefresh(RTK_KINDS, sourceKey !== undefined ? [sourceKey] : undefined);
	const [pullRefreshing, setPullRefreshing] = useState(false);

	// 全 PC の合計（日別・累計を足し、コマンドは名前で束ねたもの）か、1つの出どころの値。
	const summary = scope.kind === 'all' ? summarizeRtk(overview.entries, now) : undefined;
	const timed = sourceKey !== undefined ? overview.valuesOf(sourceKey)?.rtk : undefined;
	const data = summary !== undefined ? summary.merged : timed?.value;
	const fetchedAt = summary !== undefined ? summary.merged?.fetchedAt : timed?.at;
	const loading = overview.isLoading('rtk', sourceKey);
	const online = scope.kind === 'all' ? overview.entries.some(entry => entry.online) : source?.online === true;
	const stale = scope.kind === 'source' && !online;

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await useUsageStore.getState().refresh(RTK_KINDS, { bypassCache: true, ...(sourceKey !== undefined ? { sourceKeys: [sourceKey] } : {}) });
		} finally {
			setPullRefreshing(false);
		}
	}, [sourceKey]);

	const today = data?.days.find(day => day.date === localDateKey(new Date(now)));
	const dailySaved = data !== undefined ? recentRtkDays(data, DAILY_WINDOW_DAYS, now) : [];
	const maxDailySaved = Math.max(1, ...dailySaved.map(d => d.savedTokens));
	const commands = (data?.commands ?? []).slice(0, TOP_COMMANDS);
	const maxCommandSaved = Math.max(1, ...commands.map(c => c.savedTokens));
	const history = (data?.history ?? []).slice(0, TOP_HISTORY);
	const label = scope.kind === 'all'
		? `${scopeCountLabel(overview.entries)}の合計`
		: sourceParam !== undefined ? (source?.kind === 'ssh' ? source.hostLabel : source?.pcName) : undefined;
	const subtitle = [
		label,
		fetchedAt !== undefined ? updatedAtLabel(fetchedAt, now) : undefined,
	].filter((part): part is string => part !== undefined && part.length > 0).join(' · ') || undefined;

	return (
		<SettingsScreen
			title="RTK の節約"
			subtitle={subtitle}
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing || loading} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { haptic('edge'); void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			{showHostPicker ? <UsageHostPicker host={host} /> : null}
			{loading && data === undefined ? <DetailLoading /> : null}
			{scope.kind === 'all'
				? <AggregatedFetchNotes items={fetchNoteItems(overview, 'rtk')} now={now} />
				: <UsageFetchNote error={overview.errorOf(sourceKey ?? '', 'rtk')} hasPrevious={timed !== undefined} now={now} />}
			{data !== undefined && data.failedReports.length > 0 ? (
				<DetailMessage tone="warn">一部のレポートを取得できませんでした（{data.failedReports.join(', ')}）</DetailMessage>
			) : null}
			{timed !== undefined && stale ? <DetailMessage tone="note">{staleValueLabel(timed.at, now)}</DetailMessage> : null}
			{data === undefined && !online ? <DetailNotConnected /> : null}

			{data !== undefined ? (
				<View style={stale ? staleStyle : undefined}>
					<GroupHeader title="節約したトークン" first />
					<StatTiles>
						<StatTile
							label="今日"
							value={formatTokens(today?.savedTokens ?? 0)}
							sub={today !== undefined ? `${today.commands} コマンド` : '記録なし'}
						/>
						<StatTile
							label="累計"
							value={formatTokens(data.totals.savedTokens)}
							sub={`入力の ${savingsPercent(data.totals.savedTokens, data.totals.inputTokens).toFixed(0)}% を削減`}
						/>
					</StatTiles>
					{summary !== undefined && overview.entries.length > 1 ? (
						<>
							<GroupHeader title="PC ごとの今日の節約" />
							<UsageEntryRows
								entries={overview.entries}
								values={Object.fromEntries(summary.rows.map(row => [row.key, { value: row.today !== undefined ? formatTokens(row.today) : '—', at: row.at }]))}
								now={now}
								showResources={false}
								onOpen={entry => { haptic('move'); router.push(settingsRoutes.usageDetail('rtk', entry.key)); }}
							/>
						</>
					) : null}

					<GroupHeader title={`日別（直近${DAILY_WINDOW_DAYS}日）`} />
					<DetailCard>
						{dailySaved.map(day => (
							<InlineBarRow
								key={day.date}
								label={day.date.slice(5)}
								value={formatTokens(day.savedTokens)}
								percent={barPercent(day.savedTokens, maxDailySaved)}
								color={colors.blue}
							/>
						))}
					</DetailCard>

					<GroupHeader title="コマンド別" />
					<DetailCard>
						{commands.length === 0 ? <DetailEmptyLine>データがありません</DetailEmptyLine> : null}
						{commands.map((row, index) => (
							// RTK は表示幅でコマンド名を切り詰めるので同じ名前の行がありうる。index も鍵に含める。
							<BarItem
								key={`${row.command}-${index}`}
								name={row.command}
								value={formatTokens(row.savedTokens)}
								segments={[{ percent: barPercent(row.savedTokens, maxCommandSaved), color: colors.blue }]}
								footer={<Text style={styles.meta}>{row.count} 回 · 平均 {row.avgSavingsPct.toFixed(0)}% 削減</Text>}
							/>
						))}
					</DetailCard>

					<GroupHeader title="直近のコマンド" />
					{history.length === 0 ? (
						<DetailCard><DetailEmptyLine>データがありません</DetailEmptyLine></DetailCard>
					) : (
						<ListGroup>
							{history.map((entry, index) => (
								<ListRow
									key={`${entry.timestampLabel}-${index}`}
									label={entry.command}
									hint={`${entry.timestampLabel} · ${formatTokens(entry.tokens)} tok`}
									value={`-${entry.savingsPct.toFixed(0)}%`}
								/>
							))}
						</ListGroup>
					)}
				</View>
			) : null}
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	meta: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
