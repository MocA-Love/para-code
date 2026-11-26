// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Clock } from 'lucide-react-native';
import { useAppStore } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { useRoutePc } from '../../hooks/useRouteTargets.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { useParaToast } from '../../paraToast.js';
import { colors, radius, space, type } from '../../theme.js';
import { formatRelativeTime, useNow } from '../../time.js';
import { Button, ConfirmDrawer, EmptyState, PickerDrawer, Screen, ScreenHeader, SectionHeader, TextInputDrawer } from '../../ui/index.js';
import { HumanAskCard } from '../humanAsks/humanAskCard.js';
import { useHumanAsks, useHumanAskSync } from '../humanAsks/humanAskStore.js';
import { botAskFor, botItemEventLine, botItemStatusLabel, botRefusalText, isBotItemClosed, newBotOpId, type BotItemAction } from './bots.js';
import { actOnBotItem, botKey, refreshBotItem, useBotPages } from './botStore.js';

const NO_ASKS: readonly never[] = [];
const HOUR = 3_600_000;

/** 後回しの期限の選択肢（今からの長さ）。 */
const SNOOZE_OPTIONS = [
	{ value: '1h', label: '1 時間', ms: HOUR },
	{ value: '4h', label: '4 時間', ms: 4 * HOUR },
	{ value: '1d', label: '明日まで', ms: 24 * HOUR },
	{ value: '1w', label: '1 週間', ms: 7 * 24 * HOUR },
] as const;

type Sheet = 'comment' | 'snooze' | 'done' | 'cancel';

/**
 * Bot の項目 1 つ（`/pc/[pcId]/bot/[botId]/item/[uid]`）。本文・問い（台帳の質問カード）・記録（新しい順）と、
 * コメント・後回し・完了・取り消し。コメントは問いへの答えにしない（答えは質問カードから）。
 */
export function BotItemScreen() {
	const params = useLocalSearchParams<{ pcId?: string; botId?: string; uid?: string }>();
	const { pcId, pc, status } = useRoutePc(params.pcId);
	const botId = typeof params.botId === 'string' ? params.botId : undefined;
	const uid = typeof params.uid === 'string' ? params.uid : undefined;
	const insets = useStableInsets();
	const column = useContentColumnStyle();
	const now = useNow();
	const page = useBotPages(s => (pcId !== undefined && uid !== undefined ? s.pages[botKey(pcId, uid)] : undefined));
	// 一覧の行が動いたら（Bot が書き足した・答えが届いた）ページも取り直す
	const row = useBotPages(s => (pcId !== undefined && botId !== undefined ? s.items[botKey(pcId, botId)]?.find(candidate => candidate.uid === uid) : undefined));
	const pcs = useMemo(() => (pc !== undefined ? [pc] : []), [pc]);
	useHumanAskSync(pcs);
	const asks = useHumanAsks(s => (pc?.humanAskSupported === true && pcId !== undefined ? s.byPc[pcId]?.asks : undefined) ?? NO_ASKS);
	const active = status === 'active';
	const connected = useAppStore(s => s.pcs.find(candidate => candidate.id === pcId)?.connection === 'online');
	const [failed, setFailed] = useState<string | undefined>(undefined);
	const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
	const [sending, setSending] = useState(false);

	useEffect(() => {
		if (pcId === undefined || uid === undefined || !active || !connected) {
			return;
		}
		void refreshBotItem(pcId, uid).then(result => setFailed(result.ok ? undefined : result.code ?? 'unavailable'));
	}, [pcId, uid, active, connected, row?.lastActivityAt, row?.status]);

	const act = async (action: BotItemAction) => {
		if (pcId === undefined || botId === undefined || uid === undefined) {
			return;
		}
		setSending(true);
		const result = await actOnBotItem(pcId, botId, uid, action, newBotOpId());
		setSending(false);
		if (!result.ok) {
			useParaToast.getState().show({ key: `bot-item-${uid}`, text: '送れませんでした', sub: botRefusalText(result.code), icon: 'alert-circle-outline', tone: 'warn' }, 3_500);
			return;
		}
		haptic('success');
	};

	const ask = page !== undefined ? botAskFor(asks, page.uid) : undefined;
	const closed = page !== undefined && isBotItemClosed(page);
	const snoozed = page?.snoozedUntil !== undefined && page.snoozedUntil > now;
	const canAct = page !== undefined && !page.locked && !closed && !sending;

	const body = (() => {
		if (page === undefined) {
			return <EmptyState title={failed !== undefined ? '開けませんでした' : '読み込んでいます…'} {...(failed !== undefined ? { body: botRefusalText(failed) } : {})} />;
		}
		return (
			<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]} keyboardShouldPersistTaps="handled">
				<Text style={styles.title}>{page.title}</Text>
				<Text style={styles.meta}>{`${botItemStatusLabel(page.status)} · ${formatRelativeTime(page.lastActivityAt, now)}${snoozed && page.snoozedUntil !== undefined ? ` · 後回し（${formatRelativeTime(page.snoozedUntil, now)}まで）` : ''}`}</Text>
				{page.description !== undefined ? <Text style={styles.text} selectable>{page.description}</Text> : null}
				{page.doneMeans !== undefined ? (
					<View style={styles.box}>
						<Text style={styles.boxLabel}>完了の条件</Text>
						<Text style={styles.text} selectable>{page.doneMeans}</Text>
					</View>
				) : null}
				{ask !== undefined && pcId !== undefined ? <HumanAskCard pcId={pcId} ask={ask} now={now} /> : page.waits ? <Text style={styles.note}>この項目は質問への答えを待っています。PC か要対応から答えてください。</Text> : null}
				{page.closeNote !== undefined ? <Text style={styles.note}>{`閉じた理由: ${page.closeNote}`}</Text> : null}
				{page.links.length > 0 ? (
					<View style={styles.group}>
						<SectionHeader title="リンク" count={page.links.length} />
						{page.links.map(link => <Text key={`${link.kind}:${link.ref}`} style={styles.link} selectable numberOfLines={2}>{link.ref}</Text>)}
					</View>
				) : null}
				{page.locked ? <Text style={styles.note}>この項目は PC の新しい Para Code で書かれたため、ここでは変えられません。</Text> : null}
				{!closed && !page.locked ? (
					<View style={styles.actions}>
						<Button label="コメント" size="sm" variant="secondary" style={styles.flex} disabled={!canAct} onPress={() => setSheet('comment')} />
						<Button
							label={snoozed ? '後回しを解く' : '後回し'}
							size="sm"
							variant="secondary"
							icon={Clock}
							style={styles.flex}
							disabled={!canAct}
							onPress={() => (snoozed ? void act({ action: 'unsnooze' }) : setSheet('snooze'))}
						/>
					</View>
				) : null}
				{!closed && !page.locked ? (
					<View style={styles.actions}>
						<Button label="完了にする" size="sm" variant="outline" style={styles.flex} disabled={!canAct} onPress={() => setSheet('done')} />
						<Button label="取り消す" size="sm" variant="outline" style={styles.flex} disabled={!canAct} onPress={() => setSheet('cancel')} />
					</View>
				) : null}
				<View style={styles.group}>
					<SectionHeader title="記録" count={page.events.length} />
					{[...page.events].reverse().map(event => (
						<View key={event.id} style={styles.event}>
							<Text style={styles.eventText} selectable>{botItemEventLine(event)}</Text>
							<Text style={styles.eventTime}>{formatRelativeTime(event.at, now)}</Text>
						</View>
					))}
				</View>
			</ScrollView>
		);
	})();

	return (
		<Screen>
			<ScreenHeader title={page !== undefined ? `項目 #${page.number}` : '項目'} />
			<View style={styles.fill}>{body}</View>
			<TextInputDrawer
				visible={sheet === 'comment'}
				title="コメント"
				message="Bot に伝えます。質問への答えにはなりません（答えは質問のカードから）。"
				submitLabel="送る"
				maxLength={8000}
				onSubmit={text => { setSheet(undefined); if (text.trim().length > 0) { void act({ action: 'comment', text }); } }}
				onClose={() => setSheet(undefined)}
			/>
			<PickerDrawer<string>
				visible={sheet === 'snooze'}
				title="後回しにする"
				message="期限まで一覧の「後回し」に移します。状態は変わりません。"
				options={SNOOZE_OPTIONS.map(option => ({ value: option.value, label: option.label, icon: Clock }))}
				selected=""
				onSelect={value => {
					const option = SNOOZE_OPTIONS.find(candidate => candidate.value === value);
					if (option !== undefined) {
						void act({ action: 'snooze', until: Date.now() + option.ms });
					}
				}}
				onClose={() => setSheet(undefined)}
			/>
			<ConfirmDrawer
				visible={sheet === 'done' || sheet === 'cancel'}
				title={sheet === 'done' ? 'この項目を完了にしますか' : 'この項目を取り消しますか'}
				message="Bot に知らせます。"
				confirmLabel={sheet === 'done' ? '完了にする' : '取り消す'}
				destructive={sheet === 'cancel'}
				onConfirm={() => { const action = sheet === 'done' ? 'done' : 'cancel'; setSheet(undefined); void act({ action }); }}
				onClose={() => setSheet(undefined)}
			/>
		</Screen>
	);
}

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	content: {
		paddingHorizontal: space.lg,
		paddingTop: space.md,
		gap: space.md,
	},
	title: {
		fontSize: type.heading,
		fontWeight: '700',
		color: colors.text,
	},
	meta: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	text: {
		fontSize: type.label,
		color: colors.text,
	},
	box: {
		gap: space.xs,
		padding: space.md,
		borderRadius: radius.group,
		borderWidth: 1,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	boxLabel: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	note: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	group: {
		gap: space.sm,
	},
	link: {
		fontSize: type.caption,
		color: colors.accent,
	},
	actions: {
		flexDirection: 'row',
		gap: space.sm,
	},
	flex: {
		flex: 1,
	},
	event: {
		flexDirection: 'row',
		gap: space.sm,
		paddingVertical: space.xs,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	eventText: {
		flex: 1,
		minWidth: 0,
		fontSize: type.caption,
		color: colors.textDim,
	},
	eventTime: {
		fontSize: type.badge,
		color: colors.textMuted,
	},
});
