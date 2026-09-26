// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, space, type } from '../theme.js';
import { Icon, iconSize, type LucideIcon } from './icon.js';

/**
 * 見出し（モックの `.sh` / `.secthdr` / `.gh`）。11pt・太さ 600・字間 0.6 の弱い灰。
 * Orca は英字を大文字にするが、日本語が主なので大文字化はしない。
 *
 * 上下の余白は置き場所で違う（ホームは 16/24、設定は 24）ので `style` で渡す。
 *
 * ```tsx
 * <SectionHeader title="デスクトップ" />
 * <SectionHeader title="要対応" icon={CircleAlert} count={2} style={{ marginTop: 16 }} />
 * ```
 */
export function SectionHeader({ title, count, icon, right, style }: {
	title: string;
	/** 見出しの横に添える件数。 */
	count?: number;
	icon?: LucideIcon;
	/** 右端に置く小さな操作（「すべて表示」など）。 */
	right?: ReactNode;
	style?: StyleProp<ViewStyle>;
}) {
	return (
		<View style={[styles.row, style]}>
			{icon !== undefined ? <View style={styles.icon}><Icon icon={icon} size={iconSize.xs} color={colors.textMuted} /></View> : null}
			<Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{title}</Text>
			{count !== undefined ? <Text style={styles.count}>{count}</Text> : null}
			{right !== undefined ? <View style={styles.right}>{right}</View> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: space.xs,
		marginBottom: space.sm,
	},
	icon: {
		marginRight: space.xs,
	},
	title: {
		fontSize: type.caption,
		fontWeight: '600',
		letterSpacing: 0.6,
		color: colors.textMuted,
		flexShrink: 1,
	},
	count: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginLeft: space.xs,
	},
	right: {
		marginLeft: 'auto',
	},
});
