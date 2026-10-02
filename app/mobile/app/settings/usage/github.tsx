// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { haptic } from '../../../src/haptics.js';
import { useAppStore } from '../../../src/appState.js';
import type { GithubRateLimitEntry, GithubUsageResult } from '../../../src/store.js';
import { alpha, colors, radius, space, tint, type } from '../../../src/theme.js';
import { useNow } from '../../../src/time.js';
import { updatedAtLabel } from '../../../src/usageFormat.js';
import { meterColor } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import { ratioPercent } from '../../../src/features/settings/usageSummary.js';
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
} from '../../../src/features/settings/usageDetailParts.js';

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
 * 取り方（最後に投げた要求だけを採用・PC の切り替えで捨てる）は旧画面のまま。
 */
export default function GithubUsageScreen() {
	// 画面を開いたままでもリセットまでの時間が進むよう、取得時刻ではなく今の時刻を使う
	const now = useNow();
	const { githubUsage, connection, activePcId, pcs } = useAppStore(useShallow(s => ({
		githubUsage: s.githubUsage, connection: s.connection, activePcId: s.activePcId, pcs: s.pcs,
	})));

	const [data, setData] = useState<GithubUsageResult | undefined>();
	const [loading, setLoading] = useState(false);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [windowKey, setWindowKey] = useState<GithubWindowKey>('5m');
	const [groupKey, setGroupKey] = useState<GithubGroupKey>('caller');

	// PC の切り替えと手動の更新が前後したとき、古い応答で新しい結果を上書きしないよう最後の要求だけを採る
	// （見ていない PC も接続を保つので、切り替えた後でも前の PC 向けの要求が正常に返りうる）。
	const requestSeq = useRef(0);
	const refresh = useCallback(async (bypassCache = false) => {
		if (connection !== 'online') {
			return;
		}
		const seq = ++requestSeq.current;
		setLoading(true);
		setError(undefined);
		try {
			const result = await githubUsage(bypassCache);
			if (seq !== requestSeq.current) {
				return;
			}
			setData(result);
		} catch (e) {
			if (seq !== requestSeq.current) {
				return;
			}
			setError(String(e instanceof Error ? e.message : e));
		} finally {
			if (seq === requestSeq.current) {
				setLoading(false);
			}
		}
		// activePcId: 切り替えたら取り直す（connection は online のままなので、これが無いと再取得が起きない）
	}, [githubUsage, connection, activePcId]);

	useEffect(() => { void refresh(); }, [refresh]);

	// PC を切り替えたら前の PC の数字を捨てる。
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

	const core = data?.rateLimits.find(entry => entry.resource === 'core');
	const graphql = data?.rateLimits.find(entry => entry.resource === 'graphql');
	const rows = data === undefined ? [] : groupKey === 'caller' ? githubCallerRows(data.operations, windowKey) : githubSpaceRows(data.spaces, windowKey);
	const maxValue = Math.max(1, ...rows.map(row => row.value));
	const activePc = pcs.find(pc => pc.id === activePcId);
	const subtitle = [
		pcs.length > 1 ? activePc?.name : undefined,
		data !== undefined ? updatedAtLabel(data.generatedAt, now) : undefined,
		'PC 全体の値',
	].filter((part): part is string => part !== undefined).join(' · ');

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
			{error !== undefined ? <DetailMessage tone="error">{error}</DetailMessage> : null}
			{data !== undefined && !data.ghAvailable ? (
				<DetailMessage tone="warn">GitHub CLI（gh）が見つかりません。PC で `gh auth login` を実行してください。</DetailMessage>
			) : null}
			{data?.rateLimitError !== undefined ? <DetailMessage tone="warn">レート枠を取得できませんでした: {data.rateLimitError}</DetailMessage> : null}
			{data === undefined && connection !== 'online' ? <DetailNotConnected /> : null}

			{data !== undefined ? (
				<View>
					{/* 他の使用量と同じく「使用率」で見せる（残量で見せると、満ちた棒が画面によって逆の意味になる）。 */}
					<GroupHeader title="レート枠の使用率" first />
					<StatTiles>
						{renderLimit('REST', core)}
						{renderLimit('GraphQL', graphql)}
					</StatTiles>

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
