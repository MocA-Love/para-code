// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { Volume2 } from 'lucide-react-native';
import { alpha, colors, space, type } from '../../theme.js';
import { meterColor } from '../../ui/index.js';
import { Bar } from '../settings/usageDetailParts.js';
import { UsageRow, UsageRowTitle, UsageSection } from '../settings/usageSections.js';
import type { UsageEntry } from './usageAggregate.js';
import type { UsageOverview } from './usageStore.js';
import { aivisPeriodView, elevenLabsQuota, groupVoiceUsage, voiceEmptyReason, voiceEmptyText, voiceResetLabel } from './voiceUsageModel.js';

/**
 * 使用量の画面の「読み上げ」の欄（Claude・Codex・コスト・GitHub と同じ並び）。ElevenLabs は月の上限の残りと戻る日、
 * Aivis は 30 日の回数とクレジットの残高。押すと詳しい画面（`/settings/usage/voice`）へ進む。
 * `entries` には出したい PC の行だけを渡す（全 PC の合計なら全部、1 台の表示ならその PC）。
 */
export function VoiceUsageSection({ entries, overview, now, onPress, dimmed = false }: {
	entries: readonly UsageEntry[];
	overview: UsageOverview;
	now: number;
	onPress: () => void;
	dimmed?: boolean;
}) {
	const pcEntries = entries.filter(entry => entry.kind === 'pc');
	const groups = groupVoiceUsage(pcEntries, now);
	const errors = pcEntries.flatMap(entry => entry.sourceKeys.map(key => overview.errorOf(key, 'voice')).filter(error => error !== undefined));
	const loading = pcEntries.some(entry => entry.sourceKeys.some(key => overview.isLoading('voice', key)));
	const empty = voiceEmptyReason({ groups, anyValue: pcEntries.some(entry => entry.values.voice !== undefined), errors, loading });
	const showGroupLabel = (count: number) => count > 1 || pcEntries.length > 1;
	const rows = [
		...groups.elevenLabs.map(group => {
			const subscription = group.usage.subscription;
			const quota = subscription !== undefined ? elevenLabsQuota(subscription) : undefined;
			const reset = subscription !== undefined ? voiceResetLabel(subscription.resetAt) : undefined;
			const title = showGroupLabel(groups.elevenLabs.length) ? `ElevenLabs（${group.label}）` : 'ElevenLabs';
			return (
				<View key={group.key} style={group.old ? styles.old : undefined}>
					<View style={styles.line}>
						<Text style={styles.name} numberOfLines={1}>{title}</Text>
						<Text style={styles.value}>{quota !== undefined ? `残り ${quota.remaining.toLocaleString()} 文字` : '—'}</Text>
					</View>
					{quota !== undefined ? <Bar segments={[{ percent: quota.usedRatio * 100, color: meterColor(quota.usedRatio * 100) }]} /> : null}
					{group.usage.error !== undefined
						? <Text style={styles.hint}>{group.usage.days !== undefined ? '更新に失敗しました（前回の値）' : group.usage.error}</Text>
						: reset !== undefined ? (
							<View style={styles.line}>
								<Text style={styles.hint}>上限に戻る日</Text>
								<Text style={styles.hint}>{reset}</Text>
							</View>
						) : quota === undefined ? <Text style={styles.hint}>残りを取得できませんでした</Text> : null}
				</View>
			);
		}),
		...groups.aivis.map(group => {
			const view = group.usage.days !== undefined ? aivisPeriodView(group.usage, 30) : undefined;
			const balance = typeof group.usage.creditBalance === 'number' ? `残高 ${group.usage.creditBalance.toLocaleString()}` : undefined;
			const title = showGroupLabel(groups.aivis.length) ? `Aivis（30 日・${group.label}）` : 'Aivis（30 日）';
			return (
				<View key={group.key} style={group.old ? styles.old : undefined}>
					<View style={styles.line}>
						<Text style={styles.name} numberOfLines={1}>{title}</Text>
						<Text style={styles.value}>{view !== undefined ? [`${view.requests.toLocaleString()} 回`, balance].filter(part => part !== undefined).join('・') : '—'}</Text>
					</View>
					{group.usage.error !== undefined ? <Text style={styles.hint}>{view !== undefined ? '更新に失敗しました（前回の値）' : group.usage.error}</Text> : null}
				</View>
			);
		}),
	];
	return (
		<UsageSection title="読み上げ" icon={Volume2} onPress={onPress} dimmed={dimmed}>
			<UsageRow trailing="chevron">
				{empty !== undefined ? (
					<UsageRowTitle title={voiceEmptyText(empty)} />
				) : (
					<View style={styles.body}>
						<Text style={styles.hint}>ElevenLabs は月の上限、Aivis はクレジットの残高</Text>
						{rows}
					</View>
				)}
			</UsageRow>
		</UsageSection>
	);
}

const styles = StyleSheet.create({
	body: {
		gap: space.md,
	},
	line: {
		flexDirection: 'row',
		alignItems: 'baseline',
		justifyContent: 'space-between',
		gap: space.sm,
		marginBottom: space.xs,
	},
	name: {
		flexShrink: 1,
		fontSize: type.label,
		fontWeight: '500',
		color: colors.text,
	},
	value: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	hint: {
		fontSize: type.meta,
		color: colors.textDim,
		fontVariant: ['tabular-nums'],
		marginTop: space.xs,
	},
	old: {
		opacity: alpha.strong,
	},
});
