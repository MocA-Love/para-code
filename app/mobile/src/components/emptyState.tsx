// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './button.js';
import { colors, space, type } from '../theme.js';

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * 空・読み込み失敗など「表示するものが無い」ときの表示。形を1つに決める。
 *
 * `message` には**なぜ空なのか**と、あれば**次に何をすればよいか**を書く
 * （「変更はありません」だけでなく、「PCとの接続が切れています」のように理由を分ける）。
 */
export function EmptyState({ icon, title, message, action, style }: {
	icon?: IoniconName;
	title: string;
	message?: string;
	action?: { label: string; onPress: () => void };
	style?: StyleProp<ViewStyle>;
}) {
	return (
		<View style={[styles.wrap, style]}>
			{icon !== undefined && <Ionicons name={icon} size={28} color={colors.textDim} />}
			<Text style={styles.title}>{title}</Text>
			{message !== undefined && <Text style={styles.message}>{message}</Text>}
			{action !== undefined && <Button variant="secondary" size="sm" label={action.label} onPress={action.onPress} style={styles.action} />}
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { alignItems: 'center', paddingVertical: space.xl, paddingHorizontal: space.lg, gap: 6 },
	title: { color: colors.text, fontSize: type.body, fontWeight: '600', textAlign: 'center' },
	message: { color: colors.textDim, fontSize: type.meta, lineHeight: 18, textAlign: 'center' },
	action: { marginTop: 6 },
});
