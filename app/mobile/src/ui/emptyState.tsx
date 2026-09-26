// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, space, type } from '../theme.js';
import { Button } from './button.js';
import { Icon, iconSize, type LucideIcon } from './icon.js';

/**
 * 中身が無いとき・届かないときの表示（モックの `.emptystate` / `.state`）。
 * アイコン 28・見出し 16・説明 14 を中央に縦に並べ、必要なら操作を1つ添える。
 * 置いた場所の残りの高さいっぱいに広がる（`flex: 1`）。
 *
 * ```tsx
 * <EmptyState icon={Unplug} title="デスクトップに届きません" body="PC の電源と Para Code が…" action={{ label: '再接続', onPress: reconnect }} />
 * ```
 */
export function EmptyState({ icon, title, body, action, style }: {
	icon?: LucideIcon;
	title?: string;
	body?: string;
	action?: { readonly label: string; readonly onPress: () => void };
	style?: StyleProp<ViewStyle>;
}) {
	return (
		<View style={[styles.root, style]}>
			{icon !== undefined ? <Icon icon={icon} size={iconSize.xl} color={colors.textMuted} /> : null}
			{title !== undefined ? <Text style={styles.title} accessibilityRole="header">{title}</Text> : null}
			{body !== undefined ? <Text style={styles.body}>{body}</Text> : null}
			{action !== undefined ? <Button label={action.label} variant="secondary" size="sm" onPress={action.onPress} style={styles.action} /> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: space.xl,
		gap: space.sm + 2,
	},
	title: {
		fontSize: type.heading,
		fontWeight: '700',
		color: colors.text,
		textAlign: 'center',
	},
	body: {
		fontSize: type.body,
		lineHeight: 20,
		color: colors.textDim,
		textAlign: 'center',
	},
	action: {
		marginTop: space.xs + 2,
	},
});
