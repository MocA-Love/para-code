// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Bell, Ellipsis, Folder, Pin } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { colors, radius, space, type } from '../../theme.js';
import { AgentSpinner, Icon, agentKindFromStatus, iconSize } from '../../ui/index.js';
import { AgentLogo } from './agentLogo.js';
import { agentLogoKind, agentRowLine, formatElapsedShort } from './agentRowLine.js';
import { useStatusSince } from './statusSinceStore.js';
import { PointerHover } from '../../ipad/pointerHover.js';

/**
 * PC の画面の1行（Orca の WorktreeListRow ＋ WorktreeAgentRow の形。モックの `wtRow`）。
 *
 *  - 左の列: 状態の印（AgentSpinner。実行中は黄の輪が回る）と、未読のベル（要対応・未確認）
 *  - 1段目: 名前（未読は太字）とピン留めの印
 *  - 2段目: スペース（スペースで分けているときは見出しが言うので省く）とブランチ
 *  - 3段目: エージェントのロゴ・最後の一言・経過時間（`agentRowLine`）。状態は左の列の印が示すので、
 *    ここには状態の点を重ねて出さない
 *  - 右端: ⋯（長押しと同じ操作のシート）
 *
 * 受け取るのはスカラと安定したコールバックだけにして、行ごとに memo で止める（PC からの再送は
 * 最大 10Hz）。最後の一言と経過時間は行の中で必要な値だけを購読する。
 */
export const AgentListRow = memo(function AgentListRow({
	terminalKey, title, agent, agentStatus, spaceName, spaceColor, branch, hideSpace, pinned, current, now, onOpen, onMenu,
}: {
	terminalKey: string;
	title: string;
	agent: boolean;
	agentStatus: string | undefined;
	spaceName: string | undefined;
	spaceColor: string;
	branch: string | undefined;
	/** スペースの見出しの下に並べるとき、行からスペース名を省く。 */
	hideSpace: boolean;
	pinned: boolean;
	/** 最後に開いた行（Orca の「デスクトップで開いている」行と同じく地を一段明るくする）。 */
	current: boolean;
	now: number;
	onOpen: (terminalKey: string) => void;
	onMenu: (terminalKey: string) => void;
}) {
	const kind = agentKindFromStatus(agent ? agentStatus : undefined);
	const line = useAppStore(useShallow(s => {
		const chat = s.agentChats.get(terminalKey);
		const result = agentRowLine({ agent, agentStatus }, chat);
		return { text: result.text, emphasized: result.emphasized, at: result.at, logo: agentLogoKind({ agent, title }, chat?.agent) };
	}));
	const since = useStatusSince(s => s.map.get(terminalKey)?.since);
	const at = line.at !== undefined && since !== undefined ? Math.max(line.at, since) : line.at ?? since;
	// 未読のベル: 答えを待っているもの（要対応）と、作業を終えてまだ見ていないもの（未確認）。
	const unread = kind === 'attention' || kind === 'review';
	return (
		// iPad のポインタを乗せると行に薄い色が重なる（ポインタの形は変えない）。
		<PointerHover effect="tint" cornerRadius={0}>
		<Pressable
			style={({ pressed }) => [styles.row, current ? styles.rowCurrent : undefined, pressed ? styles.rowPressed : undefined]}
			onPress={() => onOpen(terminalKey)}
			delayLongPress={400}
			onLongPress={() => {
				haptic('lift');
				onMenu(terminalKey);
			}}
			accessibilityRole="button"
			accessibilityLabel={`${title}、${line.text}${spaceName !== undefined ? `、${spaceName}` : ''}`}
			accessibilityHint="長押しで操作を開きます"
		>
			<View style={styles.indicator}>
				<AgentSpinner kind={kind} />
				{unread ? <Icon icon={Bell} size={BELL_SIZE} color={colors.amber} fill={colors.amber} /> : null}
			</View>
			<View style={styles.main}>
				<View style={styles.nameRow}>
					<Text style={[styles.name, unread ? styles.nameUnread : undefined]} numberOfLines={1}>{title}</Text>
					{pinned ? <Icon icon={Pin} size={GLYPH_SIZE} color={colors.textMuted} /> : null}
				</View>
				{(!hideSpace && spaceName !== undefined) || branch !== undefined ? (
					<View style={styles.metaRow}>
						{!hideSpace && spaceName !== undefined ? (
							<>
								<Icon icon={Folder} size={GLYPH_SIZE} color={spaceColor} />
								<Text style={styles.spaceName} numberOfLines={1}>{spaceName}</Text>
							</>
						) : null}
						{branch !== undefined ? <Text style={styles.branch} numberOfLines={1}>{branch}</Text> : null}
					</View>
				) : null}
				<View style={styles.agentRow}>
					<AgentLogo kind={line.logo} size={LOGO_SIZE} />
					<Text style={[styles.agentLabel, line.emphasized ? styles.agentLabelUnread : undefined]} numberOfLines={1}>{line.text}</Text>
					{at !== undefined ? <Text style={styles.time}>{formatElapsedShort(at, now)}</Text> : null}
				</View>
			</View>
			<PointerHover effect="highlight" cornerRadius={radius.button}>
			<Pressable
				style={({ pressed }) => [styles.more, pressed ? styles.morePressed : undefined]}
				hitSlop={hitSlopToMinimum(MORE_SIZE, MORE_SIZE)}
				onPress={() => {
					haptic('move');
					onMenu(terminalKey);
				}}
				accessibilityRole="button"
				accessibilityLabel={`${title} の操作`}
			>
				<Icon icon={Ellipsis} size={iconSize.md} color={colors.textMuted} />
			</Pressable>
			</PointerHover>
		</Pressable>
		</PointerHover>
	);
});

/**
 * ターミナルの無いスペースの行。押すとそのスペースのセッション（空の状態）を開き、そこから
 * ターミナルやエージェントを足せる。
 */
export function EmptySpaceRow({ onPress }: { onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : undefined]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel="このスペースを開く"
		>
			<View style={styles.indicator}>
				<AgentSpinner kind="idle" />
			</View>
			<View style={styles.main}>
				<Text style={styles.emptyText}>エージェントはいません</Text>
				<Text style={styles.emptyHint}>押すとこのスペースを開きます</Text>
			</View>
		</Pressable>
	);
}

/** 行の間の区切り線（モックの `.sep`: 左 40・右 16）。 */
export function RowSeparator() {
	return <View style={styles.separator} />;
}

/** モックの寸法（pt）。 */
const BELL_SIZE = 10;
const GLYPH_SIZE = 11;
const LOGO_SIZE = 13;
const MORE_SIZE = 28;
const INDICATOR_WIDTH = 20;
const SEPARATOR_INSET = 40;

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.lg,
		// 最後に開いた行の左の線ぶんを常に空けておく（行ごとに文字の位置がずれないように）。
		borderLeftWidth: 2,
		borderLeftColor: 'transparent',
	},
	rowCurrent: {
		backgroundColor: colors.panel,
		borderLeftColor: colors.textDim,
	},
	rowPressed: {
		backgroundColor: colors.raised,
	},
	indicator: {
		width: INDICATOR_WIDTH,
		alignItems: 'center',
		paddingTop: 6,
		marginRight: space.sm,
		gap: space.xs,
	},
	main: {
		flex: 1,
		minWidth: 0,
		marginRight: space.sm,
	},
	nameRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minWidth: 0,
	},
	name: {
		flexShrink: 1,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	nameUnread: {
		fontWeight: '700',
	},
	metaRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		marginTop: 2,
		minWidth: 0,
	},
	spaceName: {
		maxWidth: 100,
		fontSize: type.caption,
		color: colors.textDim,
	},
	branch: {
		flexShrink: 1,
		fontSize: type.caption,
		color: colors.textMuted,
		fontFamily: monoFamily,
	},
	agentRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		marginTop: 3,
		minWidth: 0,
	},
	agentLabel: {
		flex: 1,
		minWidth: 0,
		fontSize: type.caption,
		color: colors.textMuted,
	},
	agentLabelUnread: {
		color: colors.text,
		fontWeight: '600',
	},
	time: {
		// モックの `.agtime`（10pt）。行の右端に収める小さな数字なので badge の段を使う。
		fontSize: type.badge,
		color: colors.textMuted,
	},
	more: {
		width: MORE_SIZE,
		height: MORE_SIZE,
		borderRadius: radius.button,
		alignItems: 'center',
		justifyContent: 'center',
	},
	morePressed: {
		backgroundColor: colors.raised,
	},
	separator: {
		height: 1,
		backgroundColor: colors.border,
		marginLeft: SEPARATOR_INSET,
		marginRight: space.lg,
	},
	emptyText: {
		fontSize: type.body,
		color: colors.textDim,
	},
	emptyHint: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginTop: 2,
	},
});
