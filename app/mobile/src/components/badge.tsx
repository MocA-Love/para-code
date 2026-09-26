// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { alpha, colors, radius, tint, type } from '../theme.js';
import { monoFamily } from '../monoFont.js';

export type BadgeTone = 'neutral' | 'accent' | 'red' | 'green' | 'yellow' | 'purple';

type IoniconName = keyof typeof Ionicons.glyphMap;

const TONE: Record<BadgeTone, { bg: string; fg: string }> = {
	neutral: { bg: colors.surface3, fg: colors.textDim },
	accent: { bg: colors.accentWash, fg: colors.accent },
	red: { bg: tint(colors.red, alpha.wash), fg: colors.red },
	green: { bg: tint(colors.green, alpha.wash), fg: colors.green },
	yellow: { bg: tint(colors.yellow, alpha.wash), fg: colors.yellow },
	purple: { bg: tint(colors.purple, alpha.wash), fg: colors.purple },
};

/** バッジの高さ（既定の文字サイズのとき）。行の中に置いても行の高さを揺らさない。 */
export const BADGE_HEIGHT = 22;

/**
 * 状態・件数・区分を示す、押せない小さなラベル（「実行中」「使用中」「要再ログイン」など）。
 *
 * 押せる選択肢には使わない（それは `SelectablePill`）。押せる見た目と押せない見た目を
 * 同じ形にすると、押せないものを押そうとして迷わせる。
 */
export function Badge({ label, tone = 'neutral', icon, mono, style }: {
	label: string;
	tone?: BadgeTone;
	icon?: IoniconName;
	/** 件数など、桁がそろって見えてほしい数字。 */
	mono?: boolean;
	style?: StyleProp<ViewStyle>;
}) {
	const t = TONE[tone];
	return (
		<View style={[styles.badge, { backgroundColor: t.bg }, style]}>
			{icon !== undefined && <Ionicons name={icon} size={11} color={t.fg} />}
			<Text style={[styles.label, { color: t.fg }, mono === true && { fontFamily: monoFamily }]} numberOfLines={1}>{label}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	// 高さを固定すると、文字サイズを大きくする設定でラベルが上下にはみ出す。既定の文字サイズでは
	// BADGE_HEIGHT ちょうどになり、大きい設定のときだけ文字に合わせて伸びる。
	badge: { minHeight: BADGE_HEIGHT, paddingVertical: 2, borderRadius: radius.pill, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
	label: { fontSize: type.badge, fontWeight: '700' },
});
