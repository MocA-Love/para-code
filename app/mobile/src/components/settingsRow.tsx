// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { Children, Fragment, ReactNode, isValidElement } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, squircle, type } from '../theme.js';

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * 設定・一覧の行を束ねるカード。子の行の間にだけ区切り線を入れる
 * （行の側で「最後の行か」を知らなくて済むように）。
 */
export function SettingsCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const rows = Children.toArray(children).filter(isValidElement);
	return (
		<View style={[styles.card, style]}>
			{rows.map((row, i) => (
				<Fragment key={row.key ?? i}>
					{i > 0 && <View style={styles.separator} />}
					{row}
				</Fragment>
			))}
		</View>
	);
}

/**
 * 設定の行。アイコン・タイトル・説明・現在値・シェブロンの並びと寸法を1つに決める。
 *
 * `onPress` を渡したときだけ押せる行になり、別画面へ移る行にはシェブロンが付く。右端に
 * Switch などを置きたいときは `right` に渡す。
 *
 * 押せない行（情報を並べるだけの行）は View、押せる行は Pressable で描く。
 * **同じ行を実行中に押せる/押せないで切り替えるときは、`onPress` を外さず `disabled` を使うこと。**
 * `onPress={cond ? fn : undefined}` と書くと外側の要素の型が入れ替わり、右側の Switch などが
 * 再マウントされる（CLAUDE.md「条件分岐でReactツリーの形を変えない」）。
 */
export function SettingsRow({ icon, iconColor, title, description, value, right, onPress, chevron, destructive, disabled, accessibilityLabel }: {
	icon?: IoniconName;
	/** 既定は accent。破壊的な行は `destructive` を使う。 */
	iconColor?: string;
	title: string;
	description?: string;
	/** 右側に出す現在の値（「12pt」「4 件オン」など）。開かなくても状態が分かるようにする。 */
	value?: string;
	right?: ReactNode;
	onPress?: () => void;
	/**
	 * シェブロンを出すか。既定は「押せて、破壊的でない行」だけ。確認ダイアログを出す操作
	 * （ペアリング解除など）は別画面へ移らないので、シェブロンを付けない。
	 */
	chevron?: boolean;
	destructive?: boolean;
	disabled?: boolean;
	accessibilityLabel?: string;
}) {
	const tone = destructive === true ? colors.red : undefined;
	const pressable = onPress !== undefined;
	const showChevron = chevron ?? (pressable && destructive !== true);
	// 読み上げは見出しと現在値をつなぎ、説明はヒントに回す（title だけにすると値が聞こえない）。
	const label = accessibilityLabel ?? [title, value].filter((part): part is string => part !== undefined && part !== '').join('、');
	const body = (
		<>
			{icon !== undefined && <Ionicons name={icon} size={18} color={tone ?? iconColor ?? colors.accent} />}
			<View style={styles.body}>
				<Text style={[styles.title, tone !== undefined && { color: tone }]} numberOfLines={1}>{title}</Text>
				{description !== undefined && <Text style={styles.description}>{description}</Text>}
			</View>
			{value !== undefined && <Text style={styles.value} numberOfLines={1}>{value}</Text>}
			{right}
			{showChevron && <Ionicons name="chevron-forward" size={16} color={colors.textDim} />}
		</>
	);
	if (!pressable) {
		return <View style={[styles.row, disabled === true && styles.disabled]}>{body}</View>;
	}
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityHint={description}
			accessibilityState={{ disabled: disabled === true }}
			style={({ pressed }) => [styles.row, disabled === true && styles.disabled, pressed && styles.pressed]}
		>
			{body}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	card: { backgroundColor: colors.surface, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 44 },
	body: { flex: 1, minWidth: 0 },
	title: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	description: { color: colors.textDim, fontSize: type.meta, lineHeight: 16, marginTop: 2 },
	value: { color: colors.textDim, fontSize: type.meta, fontWeight: '600', maxWidth: 160 },
	disabled: { opacity: 0.45 },
	pressed: { opacity: 0.7 },
});
