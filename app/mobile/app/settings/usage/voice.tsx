// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useAppStore } from '../../../src/appState.js';
import { haptic } from '../../../src/haptics.js';
import { colors, space, type } from '../../../src/theme.js';
import { useNow } from '../../../src/time.js';
import { staleValueLabel } from '../../../src/usageFormat.js';
import { ListGroup, ListRow, meterColor } from '../../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../../src/features/settings/settingsScaffold.js';
import {
	Bar,
	ChoiceChips,
	DetailMessage,
	DetailLoading,
	DetailNotConnected,
	DetailRefreshButton,
	StatTile,
	StatTiles,
	staleStyle,
	type ChoiceOption,
} from '../../../src/features/settings/usageDetailParts.js';
import { pcSourceKey, type UsageKind } from '../../../src/features/usage/usageAggregate.js';
import { SeenOnChips, fetchedAtPhrase } from '../../../src/features/usage/usageOverviewParts.js';
import { useUsageAutoRefresh, useUsageOverview, useUsageStore } from '../../../src/features/usage/usageStore.js';
import { useUsageScope } from '../../../src/features/usage/useUsageScope.js';
import { VoiceUsageChart, type VoiceChartBar } from '../../../src/features/usage/voiceUsageChart.js';
import {
	aivisPeriodView,
	elevenLabsPeriodView,
	elevenLabsQuota,
	formatCredits,
	groupVoiceUsage,
	initialVoiceProvider,
	voiceDayLabel,
	voiceEmptyReason,
	voiceEmptyText,
	voiceEnginesByPreference,
	voiceErrorText,
	voiceResetLabel,
	voiceShortDate,
	type VoiceKeyGroup,
	type VoicePeriod,
} from '../../../src/features/usage/voiceUsageModel.js';
import type { AivisVoiceUsage, ElevenLabsVoiceUsage, VoiceProvider } from '../../../src/features/usage/voiceUsageWire.js';

const VOICE_KINDS: readonly UsageKind[] = ['voice'];

const PROVIDER_LABEL: Record<VoiceProvider, string> = { elevenlabs: 'ElevenLabs', aivis: 'Aivis' };
const PERIOD_OPTIONS: readonly ChoiceOption<'7' | '30'>[] = [
	{ value: '7', label: '7 日' },
	{ value: '30', label: '30 日' },
];
type AivisMetric = 'requests' | 'chars' | 'credits';
const AIVIS_METRIC_OPTIONS: readonly ChoiceOption<AivisMetric>[] = [
	{ value: 'requests', label: '回数' },
	{ value: 'chars', label: '文字数' },
	{ value: 'credits', label: 'クレジット' },
];
const CHART_HINT = '棒を押すと、その日の値が出ます';

/**
 * 読み上げ（`/settings/usage/voice`）。PC の「通知の設定 → 使用量 (日別)」と同じ値を、Aivis と ElevenLabs の
 * キーがある方を両方（上の切り替えで選ぶ。最初は PC で今使っているエンジン）出す。使用量の画面の「読み上げ」の欄と、
 * 通知と音声の「読み上げの使用量」の行から開く。
 *
 * PC が複数なら、同じキーは 1 つにまとめ（PC が付けたキーの印で見分ける）、違うキーは切り替えで別々に出す。
 * 眠っている PC は最後に取れた値を薄く出す。日別の表は出さず、棒を押す（なぞる）とその日の値を上に出す。
 */
export default function VoiceUsageScreen() {
	const now = useNow();
	const { scope } = useUsageScope();
	const activePcId = useAppStore(s => s.activePcId);
	const overview = useUsageOverview({ resources: false });
	// 読み上げは PC の値（SSH の接続先ごとには無い）。1 台の表示ならその PC だけ。
	const sourceKey = scope.kind === 'source' ? (scope.pcId !== undefined ? pcSourceKey(scope.pcId) : scope.key) : undefined;
	const entries = overview.entries.filter(entry => entry.kind === 'pc' && (sourceKey === undefined || entry.sourceKeys.includes(sourceKey)));
	useUsageAutoRefresh(VOICE_KINDS, sourceKey !== undefined ? [sourceKey] : undefined);
	const [pullRefreshing, setPullRefreshing] = useState(false);
	const [pickedProvider, setPickedProvider] = useState<VoiceProvider | undefined>(undefined);
	const [pickedKey, setPickedKey] = useState<string | undefined>(undefined);
	const [period, setPeriod] = useState<'7' | '30'>('30');
	const [aivisMetric, setAivisMetric] = useState<AivisMetric>('requests');

	const onPullRefresh = useCallback(async () => {
		setPullRefreshing(true);
		try {
			await useUsageStore.getState().refresh(VOICE_KINDS, { bypassCache: true, ...(sourceKey !== undefined ? { sourceKeys: [sourceKey] } : {}) });
		} finally {
			setPullRefreshing(false);
		}
	}, [sourceKey]);

	const groups = groupVoiceUsage(entries, now);
	const available: VoiceProvider[] = [
		...(groups.elevenLabs.length > 0 ? ['elevenlabs' as const] : []),
		...(groups.aivis.length > 0 ? ['aivis' as const] : []),
	];
	const provider = pickedProvider !== undefined && available.includes(pickedProvider)
		? pickedProvider
		: initialVoiceProvider(available, voiceEnginesByPreference(entries, activePcId));
	const providerGroups: readonly VoiceKeyGroup<ElevenLabsVoiceUsage | AivisVoiceUsage>[] = provider === 'elevenlabs' ? groups.elevenLabs : provider === 'aivis' ? groups.aivis : [];
	const group = providerGroups.find(item => item.key === pickedKey) ?? providerGroups[0];

	const errors = entries.flatMap(entry => entry.sourceKeys.map(key => overview.errorOf(key, 'voice')).filter(error => error !== undefined));
	const loading = sourceKey !== undefined ? overview.isLoading('voice', sourceKey) : overview.isLoading('voice');
	const anyValue = entries.some(entry => entry.values.voice !== undefined);
	const online = entries.some(entry => entry.online);
	const empty = voiceEmptyReason({ groups, anyValue, errors, loading });
	// 値の出ている PC とは別に、取れなかった PC の分を一行ずつ添える
	const failedNotes = entries.flatMap(entry => {
		const error = entry.sourceKeys.map(key => overview.errorOf(key, 'voice')).find(item => item !== undefined);
		return error !== undefined && empty === undefined ? [`${entry.label}: ${voiceErrorText(error, entry.values.voice !== undefined)}`] : [];
	});
	const periodDays: VoicePeriod = period === '7' ? 7 : 30;

	return (
		<SettingsScreen
			title="読み上げ"
			subtitle={scope.kind === 'all' && entries.length > 1 ? `PC ${entries.length} 台` : entries[0]?.label}
			right={<DetailRefreshButton onPress={() => { void onPullRefresh(); }} disabled={pullRefreshing || loading || !online} />}
			refreshControl={<RefreshControl refreshing={pullRefreshing} onRefresh={() => { haptic('edge'); void onPullRefresh(); }} tintColor={colors.textDim} />}
		>
			{empty === 'loading' ? <DetailLoading /> : null}
			{empty !== undefined && empty !== 'loading' ? (
				!online && !anyValue ? <DetailNotConnected /> : <DetailMessage tone={empty === 'failed' ? 'error' : 'note'}>{empty === 'failed' ? `${voiceEmptyText(empty)}: ${voiceErrorText(errors[0], false)}` : voiceEmptyText(empty)}</DetailMessage>
			) : null}
			{failedNotes.map(note => <DetailMessage key={note} tone="note">{note}</DetailMessage>)}

			{provider !== undefined && group !== undefined ? (
				<>
					{available.length > 1 ? (
						<ChoiceChips
							options={available.map(value => ({ value, label: PROVIDER_LABEL[value] }))}
							selected={provider}
							onSelect={value => { setPickedProvider(value); setPickedKey(undefined); }}
						/>
					) : null}
					{providerGroups.length > 1 ? (
						<>
							<GroupHeader title="キー" />
							<ChoiceChips options={providerGroups.map(item => ({ value: item.key, label: item.label }))} selected={group.key} onSelect={setPickedKey} />
						</>
					) : null}
					<GroupHeader title="期間" />
					<ChoiceChips options={PERIOD_OPTIONS} selected={period} onSelect={setPeriod} />

					{group.old ? <DetailMessage tone="note">{staleValueLabel(group.usage.fetchedAt, now)}</DetailMessage> : null}
					{group.usage.error !== undefined ? (
						// 前回の値があれば値を出したまま、更新に失敗したことだけを薄く添える
						group.usage.days !== undefined
							? <DetailMessage tone="note">{`更新に失敗しました。前回の値を表示しています（${group.usage.error}）`}</DetailMessage>
							: <DetailMessage tone="error">{`取得できませんでした: ${group.usage.error}`}</DetailMessage>
					) : null}

					<View style={group.old ? staleStyle : undefined}>
						{group.provider === 'elevenlabs'
							? <ElevenLabsBody usage={group.usage as ElevenLabsVoiceUsage} period={periodDays} selectionKey={`${group.key}|${period}`} />
							: <AivisBody usage={group.usage as AivisVoiceUsage} period={periodDays} metric={aivisMetric} onMetric={setAivisMetric} selectionKey={`${group.key}|${period}|${aivisMetric}`} />}
					</View>

					{group.seenOn.length > 1 ? (
						<View style={styles.seenOn}>
							<Text style={styles.note}>{`${group.label} で使用中`}</Text>
							<SeenOnChips chips={group.seenOn} />
						</View>
					) : null}
					<Text style={styles.note}>{`取得: Para Code（${group.fromPc}）・${fetchedAtPhrase(group.usage.fetchedAt, now)}`}</Text>
				</>
			) : null}
		</SettingsScreen>
	);
}

function chartEnds(days: readonly { readonly date: string }[]): { firstLabel: string | undefined; lastLabel: string | undefined } {
	const first = days[0];
	const last = days[days.length - 1];
	return { firstLabel: first !== undefined ? voiceShortDate(first.date) : undefined, lastLabel: last !== undefined ? voiceShortDate(last.date) : undefined };
}

/** 内訳の見出し（7 日を見ていて 30 日の内訳しか無ければ、期間を添える）。 */
function breakdownTitle(title: string, period: VoicePeriod, breakdownDays: VoicePeriod): string {
	return breakdownDays !== period ? `${title}（${breakdownDays} 日）` : title;
}

function ElevenLabsBody({ usage, period, selectionKey }: { usage: ElevenLabsVoiceUsage; period: VoicePeriod; selectionKey: string }) {
	if (usage.days === undefined) {
		return null;
	}
	const view = elevenLabsPeriodView(usage, period);
	const quota = usage.subscription !== undefined ? elevenLabsQuota(usage.subscription) : undefined;
	const reset = usage.subscription !== undefined ? voiceResetLabel(usage.subscription.resetAt) : undefined;
	const bars: VoiceChartBar[] = view.days.map(day => ({ key: day.date, value: day.chars, dayLabel: voiceDayLabel(day.date), valueLabel: `${day.chars.toLocaleString()} 文字` }));
	return (
		<>
			<StatTiles>
				<StatTile label="文字数" value={view.chars.toLocaleString()} sub={`${period} 日の合計`} />
				<StatTile label="上限" value={usage.subscription !== undefined ? usage.subscription.limit.toLocaleString() : '—'} sub={usage.subscription !== undefined ? `今の期間 ${usage.subscription.used.toLocaleString()} 使用` : '取得できませんでした'} />
				<StatTile label="残り" value={quota !== undefined ? quota.remaining.toLocaleString() : '—'} sub={reset !== undefined ? `${reset} に戻る` : undefined}>
					{quota !== undefined ? <Bar segments={[{ percent: quota.usedRatio * 100, color: meterColor(quota.usedRatio * 100) }]} /> : null}
				</StatTile>
			</StatTiles>
			{usage.subscriptionUnavailable === 'missing-permissions' ? <DetailMessage tone="note">PC の ElevenLabs の API キーに user_read の権限を付けると、上限と残りが出ます。</DetailMessage> : null}
			<View style={styles.chart}>
				<VoiceUsageChart bars={bars} emptyHint={CHART_HINT} selectionKey={selectionKey} {...chartEnds(view.days)} />
			</View>
			<Breakdown title={breakdownTitle('モデル別', period, view.breakdownDays)} rows={view.byModel.map(row => ({ label: row.label, value: `${row.chars.toLocaleString()} 文字` }))} />
			<Breakdown title={breakdownTitle('声別', period, view.breakdownDays)} rows={view.byVoice.map(row => ({ label: row.label, value: `${row.chars.toLocaleString()} 文字` }))} />
			<Text style={styles.note}>ElevenLabs は UTC で日を区切って集計します。</Text>
		</>
	);
}

function AivisBody({ usage, period, metric, onMetric, selectionKey }: { usage: AivisVoiceUsage; period: VoicePeriod; metric: AivisMetric; onMetric: (metric: AivisMetric) => void; selectionKey: string }) {
	if (usage.days === undefined) {
		return null;
	}
	const view = aivisPeriodView(usage, period);
	const bars: VoiceChartBar[] = view.days.map(day => ({
		key: day.date,
		value: metric === 'requests' ? day.requests : metric === 'chars' ? day.chars : day.credits,
		dayLabel: voiceDayLabel(day.date),
		valueLabel: metric === 'requests' ? `${day.requests.toLocaleString()} 回` : metric === 'chars' ? `${day.chars.toLocaleString()} 文字` : `${formatCredits(day.credits)} クレジット`,
	}));
	return (
		<>
			<StatTiles>
				<StatTile label="回数" value={view.requests.toLocaleString()} sub={view.requests > 0 ? `平均 ${(view.chars / view.requests).toFixed(1)} 文字/回` : undefined} />
				<StatTile label="文字数" value={view.chars.toLocaleString()} sub={`${period} 日の合計`} />
				<StatTile label="クレジット" value={formatCredits(view.credits)} sub={typeof usage.creditBalance === 'number' ? `残高 ${usage.creditBalance.toLocaleString()}` : undefined} />
			</StatTiles>
			<View style={styles.chart}>
				<View style={styles.metric}>
					<ChoiceChips options={AIVIS_METRIC_OPTIONS} selected={metric} onSelect={onMetric} />
				</View>
				<VoiceUsageChart bars={bars} emptyHint={CHART_HINT} selectionKey={selectionKey} {...chartEnds(view.days)} />
			</View>
			<Breakdown
				title={breakdownTitle(`API キー別（${view.byApiKey.length} 個）`, period, view.breakdownDays)}
				rows={view.byApiKey.map(row => ({ label: row.name, value: `${row.requests.toLocaleString()} 回・${formatCredits(row.credits)}` }))}
			/>
		</>
	);
}

function Breakdown({ title, rows }: { title: string; rows: readonly { readonly label: string; readonly value: string }[] }) {
	if (rows.length === 0) {
		return null;
	}
	return (
		<>
			<GroupHeader title={title} />
			<ListGroup>
				{rows.map((row, index) => <ListRow key={`${index}:${row.label}`} label={row.label} value={row.value} />)}
			</ListGroup>
		</>
	);
}

const styles = StyleSheet.create({
	chart: {
		marginTop: space.md,
	},
	metric: {
		marginBottom: space.sm,
	},
	seenOn: {
		marginTop: space.sm,
		gap: space.xs,
	},
	note: {
		marginTop: space.md,
		paddingHorizontal: space.xs,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
	},
});
