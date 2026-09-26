// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { ReactNode } from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { colors, space, type } from '../theme.js';

/**
 * 一覧・設定のセクション見出し。書式（11/600・字間）と上下の余白をここで決める。
 *
 * 大文字化はしない（iOS 26 の見出しは大文字化をやめた。日本語では効果もない）。
 * 画面の先頭のセクションだけ `first` を付けて上の余白を詰める。
 */
export function SectionHeader({ title, count, right, first, style }: {
	title: string;
	/** 見出しの横に添える件数。 */
	count?: number;
	/** 右端に置く操作（「すべて表示」など）。 */
	right?: ReactNode;
	first?: boolean;
	style?: StyleProp<ViewStyle>;
}) {
	return (
		<View style={[styles.row, first === true ? styles.first : styles.rest, style]}>
			<Text style={styles.title} numberOfLines={1}>{title}</Text>
			{count !== undefined && <Text style={styles.count}>{count}</Text>}
			<View style={styles.spacer} />
			{right}
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.sm, paddingHorizontal: space.xs },
	first: { marginTop: space.sm },
	rest: { marginTop: 18 },
	title: { color: colors.textDim, fontSize: type.caption, fontWeight: '600', letterSpacing: 0.5, flexShrink: 1 },
	count: { color: colors.textDim, fontSize: type.caption },
	spacer: { flex: 1 },
});
