// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../src/appState.js';
import type { RtkSavingsResult } from '../../../src/store.js';
import { colors, type } from '../../../src/theme.js';
import { useNow } from '../../../src/time.js';
import { localDateKey, staleValueLabel, updatedAtLabel } from '../../../src/usageFormat.js';
import { ListGroup, ListRow } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { UsageHostPicker, useUsageHost } from '../../../src/features/settings/usageHost.js';
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
 * 値が別物になる。取り方（接続先ごとに直近の値を持つ・PC の切り替えで捨てる）は旧画面のまま。
 */
export default function RtkScreen() {
	const now = useNow();
	const { rtkSavings, connection, activePcId, pcs } = useAppStore(useShallow(s => ({
		rtkSavings: s.rtkSavings, connection: s.connection, activePcId: s.activePcId, pcs: s.pcs,
	})));
	const host = useUsageHost();
	const windowId = host.selectedHost?.windowId;

	const [dataByHost, setDataByHost] = useState<Record<string, RtkSavingsResult>>({});
	const data = dataByHost[host.key];
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();

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
			const result = await rtkSavings(bypassCache, windowId);
			setDataByHost(prev => ({ ...prev, [key]: result }));
		} catch (e) {
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}, [rtkSavings, connection, host.stale, host.key, windowId]);

	useEffect(() => { void refresh(); }, [refresh]);

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await refresh(true);
		} finally {
			setPullRefreshing(false);
		}
	}, [refresh]);

	const today = data?.days.find(day => day.date === localDateKey(new Date(now)));
	const dailySaved = data !== undefined ? recentRtkDays(data, DAILY_WINDOW_DAYS, now) : [];
	const maxDailySaved = Math.max(1, ...dailySaved.map(d => d.savedTokens));
	const commands = (data?.commands ?? []).slice(0, TOP_COMMANDS);
	const maxCommandSaved = Math.max(1, ...commands.map(c => c.savedTokens));
	const history = (data?.history ?? []).slice(0, TOP_HISTORY);
	const activePc = pcs.find(pc => pc.id === activePcId);
	const subtitle = [
		pcs.length > 1 ? activePc?.name : undefined,
		data !== undefined ? updatedAtLabel(data.fetchedAt, now) : undefined,
	].filter((part): part is string => part !== undefined).join(' · ') || undefined;

	return (
		<SettingsScreen
			title="RTK の節約"
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
			{data !== undefined && host.stale ? <DetailMessage tone="note">{staleValueLabel(data.fetchedAt, now)}</DetailMessage> : null}
			{data === undefined && connection !== 'online' ? <DetailNotConnected /> : null}

			{data !== undefined ? (
				<View style={host.stale ? staleStyle : undefined}>
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

					<GroupHeader title={`日別（直近${DAILY_WINDOW_DAYS}日）`} />
					<DetailCard>
						{dailySaved.map(day => (
							<InlineBarRow
								key={day.date}
								label={day.date.slice(5)}
								value={formatTokens(day.savedTokens)}
								percent={barPercent(day.savedTokens, maxDailySaved)}
								color={colors.accent}
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
								segments={[{ percent: barPercent(row.savedTokens, maxCommandSaved), color: colors.accent }]}
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
