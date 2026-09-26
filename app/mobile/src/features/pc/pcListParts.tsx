// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, ChevronRight, Folder, Pin, Plus, TriangleAlert, Unplug } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import type { HomeStatusBucket } from '../../homeSort.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { colors, radius, space, type } from '../../theme.js';
import { EmptyState, Icon, agentDotColor, iconSize, useThemeColors } from '../../ui/index.js';

/** 状態のまとまり → 点の色（theme の状態の色。待機は薄めた灰）。 */
export function bucketDotColor(bucket: HomeStatusBucket): string {
	return agentDotColor(bucket === 'waiting' ? 'attention' : bucket === 'working' ? 'running' : bucket);
}

/**
 * 段の見出し（モックの `.secthdr`）。押すと段を畳む／開く。
 * 頭の印はピン留めならピン、スペースならスペースの色のフォルダ、状態なら状態の点。
 */
export function SectionToggle({ title, count, collapsed, onToggle, icon, iconColor, bucket }: {
	title: string;
	count: number;
	collapsed: boolean;
	onToggle: () => void;
	icon?: 'pin' | 'folder';
	iconColor?: string;
	bucket?: HomeStatusBucket;
}) {
	return (
		<Pressable
			style={styles.section}
			hitSlop={hitSlopToMinimum(SECTION_HEIGHT)}
			onPress={() => {
				hapticSelection();
				onToggle();
			}}
			accessibilityRole="button"
			accessibilityState={{ expanded: !collapsed }}
			accessibilityLabel={`${title} ${count}件`}
		>
			<Icon icon={collapsed ? ChevronRight : ChevronDown} size={iconSize.xs} color={colors.textMuted} />
			{icon === 'pin' ? <Icon icon={Pin} size={iconSize.xs} color={colors.textMuted} /> : null}
			{icon === 'folder' ? <Icon icon={Folder} size={iconSize.sm} color={iconColor ?? colors.textMuted} /> : null}
			{bucket !== undefined ? <View style={[styles.sectionDot, { backgroundColor: bucketDotColor(bucket) }]} /> : null}
			<Text style={styles.sectionTitle} numberOfLines={1}>{title}</Text>
			<Text style={styles.sectionCount}>{count}</Text>
		</Pressable>
	);
}

/** 右下の白い ＋（モックの `.fab`。48×48）。エージェントの起動シートを開く。色は設定 → 色の「主ボタン」。 */
export function LaunchFab({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
	const insets = useStableInsets();
	const theme = useThemeColors();
	return (
		<Pressable
			style={({ pressed }) => [
				styles.fab,
				{ bottom: insets.bottom + space.xl, backgroundColor: pressed ? theme.primaryPressed : theme.primary },
				disabled ? styles.fabDisabled : undefined,
			]}
			onPress={() => {
				hapticImpact('light');
				onPress();
			}}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel="エージェントを起動"
			accessibilityState={{ disabled }}
		>
			<Icon icon={Plus} size={FAB_ICON} color={theme.onPrimary} strokeWidth={2.75} />
		</Pressable>
	);
}

/** ＋の大きさ（一覧の下を空ける量の計算にも使う）。 */
export const FAB_SIZE = 48;

/**
 * つながっていない PC を開いたときの中身（モックの Mac mini）。上に帯で「接続できません」、
 * 真ん中に「デスクトップに届きません」と再接続。
 */
export function PcOfflineState({ name, lastOnline, onReconnect }: {
	name: string;
	/** 最後につながっていた時刻の相対表記（「2時間前」）。分からなければ undefined。 */
	lastOnline: string | undefined;
	onReconnect: () => void;
}) {
	return (
		<View style={styles.offline}>
			<View style={styles.banner}>
				<Icon icon={TriangleAlert} size={iconSize.sm} color={colors.amber} />
				<Text style={styles.bannerText}>
					{`${name} に接続できません。`}
					{lastOnline !== undefined ? `最後に接続したのは ${lastOnline}です。` : ''}
				</Text>
			</View>
			<EmptyState
				icon={Unplug}
				title="デスクトップに届きません"
				body="PC の電源と Para Code が起動しているかを確かめて、再接続してください。"
				action={{ label: '再接続', onPress: onReconnect }}
			/>
		</View>
	);
}

/** モックの寸法（pt）。 */
const SECTION_HEIGHT = 30;
const FAB_ICON = 24;
const SECTION_DOT = 8;

const styles = StyleSheet.create({
	section: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		paddingTop: space.md,
		paddingBottom: space.xs,
		paddingHorizontal: space.lg,
	},
	sectionDot: {
		width: SECTION_DOT,
		height: SECTION_DOT,
		borderRadius: radius.pill,
	},
	sectionTitle: {
		flexShrink: 1,
		fontSize: type.caption,
		fontWeight: '600',
		letterSpacing: 0.5,
		color: colors.textMuted,
	},
	sectionCount: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	fab: {
		position: 'absolute',
		right: space.lg,
		width: FAB_SIZE,
		height: FAB_SIZE,
		borderRadius: radius.pill,
		alignItems: 'center',
		justifyContent: 'center',
		shadowColor: colors.shadow,
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.25,
		shadowRadius: 4,
		elevation: 4,
	},
	fabDisabled: {
		opacity: 0.45,
	},
	offline: {
		flex: 1,
	},
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		marginTop: space.sm,
		marginHorizontal: space.lg,
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
		borderRadius: radius.button,
		backgroundColor: colors.raised,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	bannerText: {
		flex: 1,
		fontSize: type.meta,
		color: colors.text,
	},
});
