// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { haptic } from '../../../src/haptics.js';
import type { GithubRateLimitEntry } from '../../../src/store.js';
import { alpha, colors, radius, space, tint, type } from '../../../src/theme.js';
import { useNow } from '../../../src/time.js';
import { staleValueLabel, updatedAtLabel } from '../../../src/usageFormat.js';
import { meterColor } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { ratioPercent } from '../../../src/features/settings/usageSummary.js';
import { settingsRoutes } from '../../../src/features/settings/settingsRoutes.js';
import { pcSourceKey, summarizeGithub, type UsageKind } from '../../../src/features/usage/usageAggregate.js';
import { AggregatedFetchNotes, SeenOnChips, UsageEntryRows, UsageFetchNote, fetchNoteItems } from '../../../src/features/usage/usageOverviewParts.js';
import { useUsageAutoRefresh, useUsageOverview, useUsageStore } from '../../../src/features/usage/usageStore.js';
import { useUsageScope } from '../../../src/features/usage/useUsageScope.js';
import {
	SLOW_CALL_MS,
	barPercent,
	githubCallerRows,
	githubResetLabel,
	githubSpaceRows,
	type GithubGroupKey,
	type GithubWindowKey,
} from '../../../src/features/settings/usageDetailModel.js';
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
	StatTile,
	StatTiles,
	staleStyle,
} from '../../../src/features/settings/usageDetailParts.js';

const GITHUB_KINDS: readonly UsageKind[] = ['github'];
/** 内訳に出す行の上限。 */
const MAX_ROWS = 10;
/**
 * GraphQL の資源を示す色。Core（REST）は青。警告の琥珀・使用率のメーターの色と重ねないため紫にしている
 * （旧画面で GraphQL を黄で描き、警告と読み分けられなかった反省）。
 */
const CORE_COLOR = colors.blue;
const GRAPHQL_COLOR = colors.purple;

const WINDOW_OPTIONS: readonly { value: GithubWindowKey; label: string }[] = [
	{ value: '5m', label: '5分' },
	{ value: '1h', label: '1時間' },
	{ value: 'session', label: 'セッション' },
];
const GROUP_OPTIONS: readonly { value: GithubGroupKey; label: string }[] = [
	{ value: 'caller', label: '呼び出し元' },
	{ value: 'space', label: 'スペース' },
];

/**
 * GitHub API（`/settings/usage/github`）。PC 版の GitHub API Usage と同じスナップショットを見るだけの画面
 * （旧 `legacy-screens/(settings)/github-usage.tsx` の作り直し）。
 *
 * GitHub のレート枠は PC（マシン）単位で共有され、どの接続先から見ても同じ値なので、接続先の切り替えは出さない。
 * PC が2台以上なら全 PC の合計: レート枠は GitHub のアカウント（`account.login`）ごとに1つ（足さない。
 * アカウント名の届かない古い PC は PC ごと）、呼び出し件数は足す。行を押すとその PC だけの値（`?source=`）へ。
 */
export default function GithubUsageScreen() {
	// 画面を開いたままでもリセットまでの時間が進むよう、取得時刻ではなく今の時刻を使う
	const now = useNow();
	const router = useRouter();
	const { scope, sourceParam } = useUsageScope();
	const overview = useUsageOverview();
	// GitHub は PC の値（SSH の接続先ごとには無い）。PC が1台で接続先を選んでいても、その PC の値を出す。
	const sourceKey = scope.kind === 'source' ? (scope.pcId !== undefined ? pcSourceKey(scope.pcId) : scope.key) : undefined;
	const source = sourceKey !== undefined ? overview.sources.find(item => item.key === sourceKey) : undefined;
	useUsageAutoRefresh(GITHUB_KINDS, sourceKey !== undefined ? [sourceKey] : undefined);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [windowKey, setWindowKey] = useState<GithubWindowKey>('5m');
	const [groupKey, setGroupKey] = useState<GithubGroupKey>('caller');

	// 全 PC の合計（レート枠はアカウントごと、呼び出し件数は足したもの）か、1つの PC の値。
	const summary = scope.kind === 'all' ? summarizeGithub(overview.entries, now) : undefined;
	const timed = sourceKey !== undefined ? overview.valuesOf(sourceKey)?.github : undefined;
	const data = summary !== undefined ? summary.merged : timed?.value;
	const loading = overview.isLoading('github', sourceKey);
	const online = scope.kind === 'all' ? overview.entries.some(entry => entry.online) : source?.online === true;
	const stale = scope.kind === 'source' && !online;

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await useUsageStore.getState().refresh(GITHUB_KINDS, { bypassCache: true, ...(sourceKey !== undefined ? { sourceKeys: [sourceKey] } : {}) });
		} finally {
			setPullRefreshing(false);
		}
	}, [sourceKey]);

	const core = data?.rateLimits.find(entry => entry.resource === 'core');
	const graphql = data?.rateLimits.find(entry => entry.resource === 'graphql');
	const rows = data === undefined ? [] : groupKey === 'caller' ? githubCallerRows(data.operations, windowKey) : githubSpaceRows(data.spaces, windowKey);
	const maxValue = Math.max(1, ...rows.map(row => row.value));
	const label = scope.kind === 'all'
		? `PC ${overview.entries.filter(entry => entry.kind === 'pc').length} 台の合計`
		: sourceParam !== undefined ? source?.pcName : undefined;
	const subtitle = [
		label,
		data !== undefined ? updatedAtLabel(summary !== undefined ? data.generatedAt : (timed?.at ?? data.generatedAt), now) : undefined,
		scope.kind === 'all' ? undefined : 'PC 全体の値',
	].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');

	const renderLimit = (label: string, entry: GithubRateLimitEntry | undefined) => {
		const percent = entry !== undefined ? ratioPercent(entry.used, entry.limit) : undefined;
		return (
			<StatTile
				label={label}
				value={percent !== undefined ? `${Math.round(percent)}%` : '—'}
				sub={entry !== undefined ? `${entry.used.toLocaleString()} / ${entry.limit.toLocaleString()} · ${githubResetLabel(entry.resetAt, now)}` : undefined}
			>
				{percent !== undefined ? <Bar segments={[{ percent, color: meterColor(percent) }]} /> : null}
			</StatTile>
		);
	};

	return (
		<SettingsScreen
			title="GitHub API"
			subtitle={subtitle}
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing || loading} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { haptic('edge'); void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			{loading && data === undefined ? <DetailLoading /> : null}
			{scope.kind === 'all'
				? <AggregatedFetchNotes items={fetchNoteItems(overview, 'github')} now={now} />
				: <UsageFetchNote error={sourceKey !== undefined ? overview.errorOf(sourceKey, 'github') : undefined} hasPrevious={timed !== undefined} staleAt={timed?.value.stale === true ? timed.at : undefined} now={now} />}
			{timed !== undefined && stale ? <DetailMessage tone="note">{staleValueLabel(timed.at, now)}</DetailMessage> : null}
			{scope.kind === 'source' && data !== undefined && !data.ghAvailable ? (
				<DetailMessage tone="warn">GitHub CLI（gh）が見つかりません。PC で `gh auth login` を実行してください。</DetailMessage>
			) : null}
			{scope.kind === 'source' && data?.rateLimitError !== undefined ? <DetailMessage tone="warn">レート枠を取得できませんでした: {data.rateLimitError}</DetailMessage> : null}
			{data === undefined && !online ? <DetailNotConnected /> : null}

			{data !== undefined ? (
				<View style={stale ? staleStyle : undefined}>
					{/* 他の使用量と同じく「使用率」で見せる（残量で見せると、満ちた棒が画面によって逆の意味になる）。 */}
					{summary !== undefined ? (
						// 同じアカウントは足さずに1つ（見えている PC を添える）。アカウント名の届かない古い PC は PC ごと。
						summary.accounts.map((account, index) => (
							<View key={account.key} style={account.old ? staleStyle : undefined}>
								<GroupHeader title={`レート枠の使用率 · ${account.label}`} first={index === 0} />
								{!account.ghAvailable ? <DetailMessage tone="warn">GitHub CLI（gh）が見つかりません。PC で `gh auth login` を実行してください。</DetailMessage> : null}
								{account.rateLimitError !== undefined ? <DetailMessage tone="warn">レート枠を取得できませんでした: {account.rateLimitError}</DetailMessage> : null}
								<StatTiles>
									{renderLimit('REST', account.rateLimits.find(entry => entry.resource === 'core'))}
									{renderLimit('GraphQL', account.rateLimits.find(entry => entry.resource === 'graphql'))}
								</StatTiles>
								<SeenOnChips chips={account.seenOn} />
							</View>
						))
					) : (
						<>
							<GroupHeader title="レート枠の使用率" first />
							<StatTiles>
								{renderLimit('REST', core)}
								{renderLimit('GraphQL', graphql)}
							</StatTiles>
						</>
					)}

					{summary !== undefined && summary.rows.length > 1 ? (
						<>
							<GroupHeader title="PC ごとの呼び出し（セッション）" />
							<UsageEntryRows
								entries={overview.entries.filter(entry => entry.kind === 'pc')}
								values={Object.fromEntries(summary.rows.map(row => [row.key, { value: row.sessionCalls !== undefined ? `${row.sessionCalls.toLocaleString()} 件` : '—', at: row.at }]))}
								now={now}
								showResources={false}
								onOpen={entry => { haptic('move'); router.push(settingsRoutes.usageDetail('github', entry.key)); }}
							/>
						</>
					) : null}

					<GroupHeader title="期間" />
					<ChoiceChips options={WINDOW_OPTIONS} selected={windowKey} onSelect={setWindowKey} />

					<GroupHeader title="内訳" />
					<ChoiceChips options={GROUP_OPTIONS} selected={groupKey} onSelect={setGroupKey} />
					<DetailCard style={styles.breakdown}>
						{rows.length === 0 ? <DetailEmptyLine>データがありません</DetailEmptyLine> : null}
						{rows.slice(0, MAX_ROWS).map(row => {
							const width = barPercent(row.value, maxValue);
							const { failures, rateLimited, avgDurationMs, maxDurationMs } = row.counts;
							const failurePercent = row.value > 0 ? Math.round((failures / row.value) * 100) : 0;
							return (
								<BarItem
									key={row.key}
									name={row.name}
									value={row.value.toLocaleString()}
									sub={row.sub}
									segments={[
										{ percent: width * row.coreRatio, color: CORE_COLOR },
										{ percent: width * (1 - row.coreRatio), color: GRAPHQL_COLOR },
									]}
									footer={row.value > 0 ? (
										// 問題があるときだけ赤・琥珀が増える。平常時は所要時間だけの静かな行にする。
										<View style={styles.stats}>
											{failures > 0 ? <Text style={[styles.stat, styles.statBad]}>失敗 {failures.toLocaleString()}（{failurePercent}%）</Text> : null}
											{rateLimited > 0 ? <Text style={[styles.stat, styles.statWarn]}>レート制限 {rateLimited.toLocaleString()}</Text> : null}
											<Text style={styles.stat}>平均 {Math.round(avgDurationMs).toLocaleString()}ms</Text>
											<Text style={[styles.stat, maxDurationMs >= SLOW_CALL_MS ? styles.statWarn : undefined]}>最大 {Math.round(maxDurationMs).toLocaleString()}ms</Text>
										</View>
									) : undefined}
								/>
							);
						})}
					</DetailCard>
					<DetailMessage tone="note">
						棒の色は資源の内訳です（青 = Core / REST、紫 = GraphQL）。「スペース」にすると worktree ごとの合計になり、worktree に紐付かない呼び出し（Agent Sessions ウィンドウ自身の GitHub API の利用）は1つにまとまります。
					</DetailMessage>
				</View>
			) : null}
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	breakdown: {
		marginTop: space.sm,
	},
	stats: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.xs + 2,
		marginTop: 2,
	},
	stat: {
		fontSize: type.badge,
		fontWeight: '600',
		color: colors.textDim,
		backgroundColor: colors.raised,
		borderRadius: radius.key,
		paddingHorizontal: space.xs + 2,
		paddingVertical: 2,
		overflow: 'hidden',
	},
	statWarn: {
		color: colors.amber,
		backgroundColor: tint(colors.amber, alpha.wash),
	},
	statBad: {
		color: colors.red,
		backgroundColor: tint(colors.red, alpha.wash),
	},
});
