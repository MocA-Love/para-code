// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, ChevronRight, Pin } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { PointerHover } from '../../ipad/pointerHover.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon, iconSize } from '../../ui/index.js';
import { RowSeparator } from '../pc/agentListRow.js';
import { SectionToggle } from '../pc/pcListParts.js';
import { BotFace } from './botFace.js';
import { botSectionRows, botStatusLine, type MobileBot } from './bots.js';

const FACE_SIZE = 22;

/**
 * PC の画面の先頭の「Bot」の節（設計 5 章・Q677 の 12 案 A）。行を押すとその Bot のページ。一時停止中の Bot は畳んだ
 * 1 行にまとめる（押すと開く）。`collapsed`・`onToggle` は PC の画面の段の開閉と同じ保存先を使う。
 */
export const BotSection = memo(function BotSection({ bots, query, collapsed, onToggle, currentBotId, onOpen }: {
	bots: readonly MobileBot[];
	query: string;
	collapsed: boolean;
	onToggle: () => void;
	/** iPad の 2 列で詳細の列に出ている Bot（行に印を付ける）。 */
	currentBotId?: string | undefined;
	onOpen: (botId: string) => void;
}) {
	const [pausedOpen, setPausedOpen] = useState(false);
	const { active, paused } = botSectionRows(bots, query);
	if (active.length + paused.length === 0) {
		return null;
	}
	const rows = pausedOpen ? [...active, ...paused] : active;
	return (
		<View>
			<SectionToggle title="Bot" count={active.length + paused.length} collapsed={collapsed} onToggle={onToggle} />
			{collapsed ? null : (
				<>
					{rows.map((bot, index) => (
						<Fragment key={bot.id}>
							{index > 0 ? <RowSeparator /> : null}
							<BotRow bot={bot} current={bot.id === currentBotId} onOpen={onOpen} />
						</Fragment>
					))}
					{paused.length > 0 ? (
						<Pressable
							style={({ pressed }) => [styles.pausedToggle, pressed ? styles.pressed : undefined]}
							hitSlop={hitSlopToMinimum(32)}
							onPress={() => { haptic('move'); setPausedOpen(!pausedOpen); }}
							accessibilityRole="button"
							accessibilityState={{ expanded: pausedOpen }}
							accessibilityLabel={`一時停止中の Bot ${paused.length}件`}
						>
							<Icon icon={pausedOpen ? ChevronDown : ChevronRight} size={iconSize.xs} color={colors.textMuted} />
							<Text style={styles.pausedText}>{pausedOpen ? '一時停止中の Bot を畳む' : `一時停止中 ${paused.length}`}</Text>
						</Pressable>
					) : null}
				</>
			)}
		</View>
	);
});

const BotRow = memo(function BotRow({ bot, current, onOpen }: { bot: MobileBot; current: boolean; onOpen: (botId: string) => void }) {
	const line = botStatusLine(bot);
	const attention = !bot.paused && bot.needsYou > 0;
	return (
		<PointerHover effect="tint" cornerRadius={0}>
			<Pressable
				style={({ pressed }) => [styles.row, current ? styles.rowCurrent : undefined, pressed ? styles.pressed : undefined]}
				onPress={() => { haptic('move'); onOpen(bot.id); }}
				accessibilityRole="button"
				accessibilityLabel={`Bot ${bot.name}、${line}`}
			>
				<View style={styles.face}>
					<BotFace color={bot.faceColor} shape={bot.faceShape} size={FACE_SIZE} dim={bot.paused} />
				</View>
				<View style={styles.main}>
					<View style={styles.nameRow}>
						<Text style={[styles.name, bot.paused ? styles.nameDim : undefined]} numberOfLines={1}>{bot.name}</Text>
						{bot.pinned ? <Icon icon={Pin} size={iconSize.xs} color={colors.textMuted} /> : null}
					</View>
					<Text style={[styles.line, attention ? styles.lineAttention : undefined]} numberOfLines={1}>{line}</Text>
				</View>
				{attention ? (
					<View style={styles.badge}>
						<Text style={styles.badgeText}>{bot.needsYou > 99 ? '99+' : String(bot.needsYou)}</Text>
					</View>
				) : null}
			</Pressable>
		</PointerHover>
	);
});

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.row,
		paddingHorizontal: space.lg,
		// PC の画面の行と同じく、印の線のぶんを常に空ける
		borderLeftWidth: 2,
		borderLeftColor: 'transparent',
	},
	rowCurrent: {
		backgroundColor: colors.panel,
		borderLeftColor: colors.textDim,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	face: {
		width: 20,
		alignItems: 'center',
	},
	main: {
		flex: 1,
		minWidth: 0,
	},
	nameRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		minWidth: 0,
	},
	name: {
		flexShrink: 1,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	nameDim: {
		color: colors.textDim,
	},
	line: {
		marginTop: 2,
		fontSize: type.caption,
		color: colors.textMuted,
	},
	lineAttention: {
		color: colors.red,
	},
	badge: {
		minWidth: 20,
		height: 20,
		paddingHorizontal: space.snug,
		borderRadius: radius.pill,
		backgroundColor: colors.red,
		alignItems: 'center',
		justifyContent: 'center',
	},
	badgeText: {
		fontSize: type.badge,
		fontWeight: '700',
		color: colors.onRed,
	},
	pausedToggle: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		paddingVertical: space.sm,
		paddingLeft: space.lg + 2,
		paddingRight: space.lg,
	},
	pausedText: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
