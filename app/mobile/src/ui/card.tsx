// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius } from '../theme.js';

/**
 * カード（モックの `.card`）。地は `colors.panel`、細い枠、角丸 14。
 * `onPress` を渡すと押せるカードになり、押している間は `colors.raised` を敷く。
 * 中の余白は置く物で違うので、カード自身は持たない（`style` で渡す）。
 *
 * ```tsx
 * <Card onPress={openPc} accessibilityLabel="MacBook Pro を開く" style={{ padding: 12 }}>...</Card>
 * ```
 */
export function Card({ children, onPress, onLongPress, style, accessibilityLabel }: {
	children: ReactNode;
	onPress?: () => void;
	onLongPress?: () => void;
	style?: StyleProp<ViewStyle>;
	accessibilityLabel?: string;
}) {
	if (onPress === undefined && onLongPress === undefined) {
		return <View style={[styles.card, style]}>{children}</View>;
	}
	return (
		<Pressable
			onPress={onPress}
			onLongPress={onLongPress}
			style={({ pressed }) => [styles.card, pressed ? styles.pressed : undefined, style]}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel}
		>
			{children}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	card: {
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: radius.card,
		overflow: 'hidden',
	},
	pressed: {
		backgroundColor: colors.raised,
	},
});
