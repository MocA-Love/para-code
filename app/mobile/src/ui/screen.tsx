// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '../theme.js';

/**
 * 画面の地（`colors.bg` で全面を塗る）。ルートの Stack はヘッダーを出さないので、
 * 各画面はこの中に `ScreenHeader` と中身を縦に並べる。
 *
 * ```tsx
 * <Screen>
 *   <ScreenHeader title="設定" variant="settings" />
 *   <ScrollView>...</ScrollView>
 * </Screen>
 * ```
 */
export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	return <View style={[styles.screen, style]}>{children}</View>;
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
		backgroundColor: colors.bg,
	},
});
