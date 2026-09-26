// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Check, ChevronRight } from 'lucide-react-native';
import { HIT_SIZE, colors, radius, space, type } from '../theme.js';
import { Icon, type LucideIcon } from './icon.js';
import { useThemeColors } from './themeColorsStore.js';

/**
 * 行を束ねる面（設定の inset grouped・シートの選択肢の束。モックの `.sec` / `.agroup`）。
 * 地は `colors.panel`、角丸 12。子の行の間に細い区切り線（左右 12 の余白）を自動で入れる。
 *
 * ```tsx
 * <ListGroup>
 *   <ListRow icon={Terminal} label="ターミナル" trailing="chevron" onPress={...} />
 *   <ListRow icon={Bell} label="通知" value="オン" trailing="chevron" onPress={...} />
 * </ListGroup>
 * ```
 */
export function ListGroup({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const rows = Children.toArray(children).filter(isValidElement);
	return (
		<View style={[styles.group, style]}>
			{rows.map((row, index) => (
				<Fragment key={row.key ?? index}>
					{index > 0 ? <View style={styles.separator} /> : null}
					{row}
				</Fragment>
			))}
		</View>
	);
}

export type ListRowTrailing = 'chevron' | 'check' | 'none';

export interface ListRowProps {
	readonly label: string;
	/** ラベルの下の補足（12pt）。 */
	readonly hint?: string;
	/** 補足の下に出す注意（12pt の琥珀色。保存はできるが気をつけてほしいこと）。 */
	readonly warning?: string;
	/** 行の頭のアイコン（16pt）。 */
	readonly icon?: LucideIcon;
	/** アイコンの色（既定は補足の灰。破壊的な行は赤）。 */
	readonly iconColor?: string;
	/** アイコンの代わりに置くもの（状態の点・エージェントのロゴなど）。 */
	readonly leading?: ReactNode;
	/** 右に寄せる値（13pt の灰）。 */
	readonly value?: string;
	/** 右端。`chevron` は先へ進む、`check` は選択中の印。任意の要素（スイッチなど）も置ける。 */
	readonly trailing?: ListRowTrailing | ReactNode;
	/** 削除など取り消しにくい操作（ラベルとアイコンを赤くする）。 */
	readonly destructive?: boolean;
	readonly disabled?: boolean;
	/** 処理中はくるくるを出して押せなくする。 */
	readonly loading?: boolean;
	readonly onPress?: () => void;
	readonly onLongPress?: () => void;
	readonly accessibilityLabel?: string;
	readonly selected?: boolean;
}

/**
 * 一覧の1行（モックの `.srow` / `.arow`）。アイコン16＋ラベル14（＋補足12）＋右端。
 * 高さは 44pt 以上。押している間は `colors.raised` を敷く。
 */
export function ListRow({
	label, hint, warning, icon, iconColor, leading, value, trailing = 'none', destructive = false,
	disabled = false, loading = false, onPress, onLongPress, accessibilityLabel, selected,
}: ListRowProps) {
	const theme = useThemeColors();
	const tone = destructive ? colors.red : iconColor ?? colors.textDim;
	const lead = leading ?? (icon !== undefined ? <Icon icon={icon} color={tone} /> : null);
	const trail = trailing === 'chevron'
		? <Icon icon={ChevronRight} color={colors.textMuted} />
		: trailing === 'check'
			? <Icon icon={Check} color={theme.accent} />
			: trailing === 'none' ? null : trailing;
	const interactive = onPress !== undefined || onLongPress !== undefined;
	return (
		<Pressable
			onPress={onPress}
			onLongPress={onLongPress}
			disabled={!interactive || disabled || loading}
			style={({ pressed }) => [styles.row, pressed && interactive ? styles.rowPressed : undefined, disabled ? styles.rowDisabled : undefined]}
			accessibilityRole={interactive ? 'button' : undefined}
			accessibilityLabel={accessibilityLabel ?? [label, hint, warning].filter(part => part !== undefined).join('、')}
			accessibilityState={{ disabled: disabled || loading, selected }}
		>
			{lead !== null ? <View style={styles.lead}>{lead}</View> : null}
			<View style={styles.textCol}>
				<Text style={[styles.label, destructive ? styles.labelDestructive : undefined]}>{label}</Text>
				{hint !== undefined ? <Text style={styles.hint}>{hint}</Text> : null}
				{warning !== undefined ? <Text style={styles.warning}>{warning}</Text> : null}
			</View>
			{value !== undefined ? <Text style={styles.value} numberOfLines={1}>{value}</Text> : null}
			{loading ? <ActivityIndicator size="small" color={colors.textDim} /> : trail}
		</Pressable>
	);
}

/** 行の頭の枠の幅（アイコン 16 を中央に置く。モックの `.aicon`）。 */
const LEAD_WIDTH = 22;

const styles = StyleSheet.create({
	group: {
		backgroundColor: colors.panel,
		borderRadius: radius.group,
		overflow: 'hidden',
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
		marginHorizontal: space.md,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		paddingVertical: space.md,
		paddingHorizontal: space.md + 2,
		minHeight: HIT_SIZE,
	},
	rowPressed: {
		backgroundColor: colors.raised,
	},
	rowDisabled: {
		opacity: 0.45,
	},
	lead: {
		width: LEAD_WIDTH,
		alignItems: 'center',
		justifyContent: 'center',
	},
	textCol: {
		flex: 1,
		minWidth: 0,
	},
	label: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.text,
	},
	labelDestructive: {
		color: colors.red,
	},
	hint: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: 2,
	},
	warning: {
		fontSize: type.meta,
		color: colors.amber,
		marginTop: 2,
	},
	value: {
		fontSize: type.label,
		color: colors.textDim,
		maxWidth: 160,
	},
});
