// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react-native';
import { formatToolName } from '../../agentToolMeta.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { useAppIsActive } from '../../hooks/useAppIsActive.js';
import { useQuickReplyList } from '../settings/quickRepliesStore.js';
import type { PendingAgentMessage } from '../../pendingAgentMessages.js';
import type { AgentLiveState } from '../../store.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { BottomDrawer, DrawerCaption, DrawerTitle, Icon, iconSize } from '../../ui/index.js';

/** 行の中の小さな操作（見た目 28）。当たり判定は 44 に広げる。 */
const SMALL_SLOP = hitSlopToMinimum(28);
/** 3つの点（モックの `.dots i`: 5×5）。 */
const DOT = 5;

/**
 * 会話とコンポーザーの間の行（モックの `.chromerow`）。
 * 左に「エージェントが作業中」と3つの点（Orca の MobileAgentWorkingIndicator）と経過時間・いまの段階、
 * その右に「ツール／たたむ」（すべてのツール実行を開閉）。右端に送信予定の件数。
 */
export function ChatChromeRow({ working, live, allToolsOpen, onToggleTools, pendingCount, onOpenPending }: {
	working: boolean;
	live: AgentLiveState | undefined;
	allToolsOpen: boolean;
	onToggleTools: () => void;
	pendingCount: number;
	onOpenPending: () => void;
}) {
	return (
		<View style={styles.chrome}>
			<View style={styles.left}>
				{working ? <WorkingIndicator live={live} /> : null}
				<Pressable
					onPress={() => { haptic('tick'); onToggleTools(); }}
					hitSlop={SMALL_SLOP}
					style={styles.toggle}
					accessibilityRole="button"
					accessibilityLabel={allToolsOpen ? 'すべてのツール実行をたたむ' : 'すべてのツール実行を開く'}
				>
					<Icon icon={allToolsOpen ? ChevronsDownUp : ChevronsUpDown} size={iconSize.sm} color={colors.textMuted} />
					<Text style={styles.toggleText}>{allToolsOpen ? 'たたむ' : 'ツール'}</Text>
				</Pressable>
			</View>
			{pendingCount > 0 ? (
				<Pressable
					onPress={() => { haptic('move'); onOpenPending(); }}
					hitSlop={SMALL_SLOP}
					style={styles.pending}
					accessibilityRole="button"
					accessibilityLabel={`送信予定 ${pendingCount}件。開いて内容を確かめる`}
				>
					<View style={styles.pendingDot} />
					<Text style={styles.pendingText}>{`送信予定 ${pendingCount}`}</Text>
					<Icon icon={ChevronRight} size={iconSize.xs} color={colors.textMuted} />
				</Pressable>
			) : null}
		</View>
	);
}

/** 経過時間の文言（旧画面の WorkingIndicator と同じ）。 */
function elapsedLabel(seconds: number): string {
	return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

function WorkingIndicator({ live }: { live: AgentLiveState | undefined }) {
	const dots = useRef([new Animated.Value(0.3), new Animated.Value(0.3), new Animated.Value(0.3)]).current;
	const active = useAppIsActive();
	const [, setClock] = useState(0);
	useEffect(() => {
		if (!active) {
			return undefined;
		}
		const loops = dots.map((dot, index) => Animated.loop(Animated.sequence([
			Animated.delay(index * 160),
			Animated.timing(dot, { toValue: 1, duration: 320, useNativeDriver: true }),
			Animated.timing(dot, { toValue: 0.3, duration: 320, useNativeDriver: true }),
		])));
		loops.forEach(loop => loop.start());
		return () => loops.forEach(loop => loop.stop());
	}, [active, dots]);
	const isLive = live !== undefined;
	// 依存は「live があるか」だけにする（差分のたびにタイマーを張り直さない）。
	useEffect(() => {
		if (!isLive || !active) {
			return undefined;
		}
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [isLive, active]);
	const seconds = live !== undefined
		? Math.max(live.elapsedSeconds ?? 0, Math.max(0, Math.floor((Date.now() - live.startedAt) / 1000)))
		: undefined;
	const phase = live?.phase === 'tool'
		? `実行中: ${formatToolName(live.tool ?? 'tool')}`
		: live?.phase === 'message' ? '応答を生成中'
			: live?.phase === 'permission' ? '許可待ち' : undefined;
	const label = ['エージェントが作業中', seconds !== undefined ? elapsedLabel(seconds) : undefined, phase].filter(Boolean).join(' · ');
	return (
		<View style={styles.working} accessibilityRole="progressbar" accessibilityLabel={label}>
			<Text style={styles.workingText} numberOfLines={1}>{label}</Text>
			<View style={styles.dots}>
				{dots.map((dot, index) => <Animated.View key={index} style={[styles.dot, { opacity: dot }]} />)}
			</View>
		</View>
	);
}

/**
 * 送信予定の中身（旧部品 `components/pendingMessages.tsx` のシートと同じ内容）。読まれる順に並べる。
 * すでにエージェントへ渡っているので、ここから取り消すことはできない。
 */
export function PendingMessagesDrawer({ visible, messages, onClose }: {
	visible: boolean;
	messages: readonly PendingAgentMessage[];
	onClose: () => void;
}) {
	return (
		<BottomDrawer visible={visible} onClose={onClose} accessibilityLabel="送信予定">
			<DrawerTitle title={`送信予定 ${messages.length}件`} />
			<DrawerCaption message="エージェントが手を空けたら、この順で読まれます。送信済みのため、ここから取り消すことはできません。" />
			<View style={styles.pendingList}>
				{messages.map((message, index) => (
					<View key={message.id} style={styles.pendingRow}>
						<Text style={styles.pendingNumber}>{index + 1}</Text>
						<Text style={styles.pendingBody} selectable>{message.text}</Text>
					</View>
				))}
			</View>
		</BottomDrawer>
	);
}

/**
 * 作業を終えたエージェントへの短い返信。一覧は設定の「クイック返信」で変えられる（既定は
 * 旧部品 `components/agentQuickReplies.tsx` と同じ文言）。0件にしたら行ごと出さない。
 * 押すと入力欄へ入るだけで送信はしない。出すかどうかは既存の `shouldShowQuickReplies`。
 *
 * 左右の余白は会話の本文（`chatItems` の行の `space.lg`）に揃える。先頭のチップの左端を
 * 画面の縁に寄せすぎない。
 */
export function QuickReplies({ onPick }: { onPick: (text: string) => void }) {
	const replies = useQuickReplyList();
	// 読み込む前（既定をちらっと見せない）と、0件にしたときは行ごと出さない。
	if (replies === undefined || replies.length === 0) {
		return null;
	}
	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			keyboardShouldPersistTaps="always"
			contentInsetAdjustmentBehavior="never"
			style={styles.repliesScroll}
			contentContainerStyle={styles.replies}
		>
			{replies.map(reply => (
				<Pressable
					key={reply}
					onPress={() => { haptic('tick'); onPick(reply); }}
					hitSlop={REPLY_SLOP}
					style={({ pressed }) => [styles.reply, pressed ? styles.replyPressed : undefined]}
					accessibilityRole="button"
					accessibilityLabel={`「${reply}」を入力欄に入れる`}
				>
					<Text style={styles.replyText} numberOfLines={1}>{reply}</Text>
				</Pressable>
			))}
		</ScrollView>
	);
}

/** クイック返信のチップ（見た目 32。スクロールの内側で上下 6 ずつ広げる）。 */
const REPLY_HEIGHT = 32;
const REPLY_SLOP = { top: 6, bottom: 6, left: 0, right: 0 };

const styles = StyleSheet.create({
	chrome: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		minHeight: 28,
		paddingHorizontal: space.md,
	},
	left: {
		flex: 1,
		minWidth: 0,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	working: {
		flexShrink: 1,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.sm,
	},
	workingText: {
		flexShrink: 1,
		fontSize: type.meta,
		fontStyle: 'italic',
		color: colors.textMuted,
	},
	dots: {
		flexDirection: 'row',
		gap: space.xs,
	},
	dot: {
		width: DOT,
		height: DOT,
		borderRadius: radius.pill,
		backgroundColor: colors.textDim,
	},
	toggle: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		padding: space.xs,
	},
	toggleText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textMuted,
	},
	pending: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		padding: space.xs,
	},
	pendingDot: {
		width: DOT,
		height: DOT,
		borderRadius: radius.pill,
		backgroundColor: colors.yellow,
	},
	pendingText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	pendingList: {
		gap: space.sm,
	},
	pendingRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm,
		padding: space.md,
		borderRadius: radius.group,
		...squircle,
		backgroundColor: colors.panel,
	},
	pendingNumber: {
		minWidth: 16,
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.textMuted,
	},
	pendingBody: {
		flex: 1,
		fontSize: type.body,
		lineHeight: 20,
		color: colors.text,
	},
	repliesScroll: {
		flexGrow: 0,
	},
	replies: {
		gap: space.sm,
		paddingHorizontal: space.lg,
		paddingVertical: 6,
	},
	reply: {
		height: REPLY_HEIGHT,
		justifyContent: 'center',
		paddingHorizontal: space.md,
		borderRadius: radius.pill,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.raised,
	},
	replyPressed: {
		opacity: 0.7,
	},
	replyText: {
		fontSize: type.label,
		color: colors.text,
	},
});
