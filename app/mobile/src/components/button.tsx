// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HIT_SIZE, alpha, colors, radius, squircle, tint, type } from '../theme.js';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'md' | 'sm';

type IoniconName = keyof typeof Ionicons.glyphMap;

/** 見た目の高さ。sm は当たり判定を hitSlop で HIT_SIZE まで広げる。 */
const HEIGHT: Record<ButtonSize, number> = { md: HIT_SIZE, sm: 36 };

const VARIANT: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
	// 1画面に1つだけ置く、流れを先へ進める操作（許可・送信・コミット・接続など）。
	primary: { bg: colors.primary, fg: colors.onPrimary },
	// primary の隣に並ぶ控えめな操作。
	secondary: { bg: colors.surface2, fg: colors.text, border: colors.border },
	// 削除・拒否・破棄。取り消しは destructive にしない（キャンセルは secondary か ghost）。
	destructive: { bg: colors.surface2, fg: colors.red, border: tint(colors.red, alpha.line) },
	// 地を持たない文字だけの操作（「全文を表示」「さらに読み込む」など）。
	ghost: { bg: 'transparent', fg: colors.accent },
};

/**
 * ボタンの共通部品。角丸・高さ・文字サイズ・押下時の見た目をここで決め、
 * 画面ごとに主ボタンを作り直さない。
 *
 * `label` の代わりに `children` を渡すと中身を差し替えられる（色は `variant` に従わないので
 * 呼び出し側で合わせる）。
 */
export function Button({ label, children, onPress, variant = 'primary', size = 'md', icon, disabled, loading, flex, style, accessibilityLabel, testID }: {
	label?: string;
	children?: ReactNode;
	onPress: () => void;
	variant?: ButtonVariant;
	size?: ButtonSize;
	icon?: IoniconName;
	disabled?: boolean;
	/** 実行中。押せなくなり、アイコンの位置にスピナーを出す。 */
	loading?: boolean;
	/** 横並びで幅を等分するとき。 */
	flex?: boolean;
	style?: StyleProp<ViewStyle>;
	accessibilityLabel?: string;
	testID?: string;
}) {
	const v = VARIANT[variant];
	const height = HEIGHT[size];
	const slop = Math.max(0, (HIT_SIZE - height) / 2);
	const inactive = disabled === true || loading === true;
	return (
		<Pressable
			onPress={onPress}
			disabled={inactive}
			hitSlop={slop > 0 ? { top: slop, bottom: slop } : undefined}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? label}
			accessibilityState={{ disabled: inactive, busy: loading === true }}
			testID={testID}
			style={({ pressed }) => [
				styles.base,
				{ minHeight: height, paddingHorizontal: size === 'md' ? 18 : 14, backgroundColor: v.bg },
				v.border !== undefined && { borderWidth: StyleSheet.hairlineWidth, borderColor: v.border },
				flex === true && styles.flex,
				inactive && styles.disabled,
				pressed && !inactive && styles.pressed,
				style,
			]}
		>
			{children ?? (
				<View style={styles.inner}>
					{loading === true
						? <ActivityIndicator size="small" color={v.fg} />
						: icon !== undefined && <Ionicons name={icon} size={size === 'md' ? 16 : 14} color={v.fg} />}
					{label !== undefined && (
						<Text style={[styles.label, { color: v.fg, fontSize: size === 'md' ? type.body : type.meta }]} numberOfLines={1}>{label}</Text>
					)}
				</View>
			)}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	base: { borderRadius: radius.control, ...squircle, alignItems: 'center', justifyContent: 'center' },
	flex: { flex: 1 },
	inner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	label: { fontWeight: '700' },
	disabled: { opacity: 0.45 },
	pressed: { opacity: 0.8 },
});
