// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { colors, radius, squircle, type } from '../theme.js';

/**
 * 数値を1つ大きく見せるカード（「今日のコスト」「CORE 使用率」など）。
 * 横に並べるときは親を `flexDirection: 'row'` にして、それぞれ `flex: 1` で等分する。
 */
export function StatCard({ label, value, sub, valueColor, style }: {
	label: string;
	value: string;
	sub?: string;
	valueColor?: string;
	style?: StyleProp<ViewStyle>;
}) {
	return (
		<View style={[styles.card, style]}>
			<Text style={styles.label} numberOfLines={1}>{label}</Text>
			<Text style={[styles.value, valueColor !== undefined && { color: valueColor }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
			{sub !== undefined && <Text style={styles.sub} numberOfLines={2}>{sub}</Text>}
		</View>
	);
}

const styles = StyleSheet.create({
	card: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, padding: 14 },
	label: { color: colors.textDim, fontSize: type.caption, fontWeight: '600', letterSpacing: 0.4 },
	value: { color: colors.text, fontSize: type.large, fontWeight: '800', marginTop: 4, fontVariant: ['tabular-nums'] },
	sub: { color: colors.textDim, fontSize: type.caption, marginTop: 2 },
});
