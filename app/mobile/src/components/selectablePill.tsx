// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { GlassSurface } from './glassSurface.js';
import { colors } from '../theme.js';

/**
 * 選択状態を持つガラスのピル/チップの共通部品（設定画面の絞り込み・期間・軸切替で使う）。
 * 非選択=ガラス、選択=不透明なaccent系の地（ガラスの上に文字を読ませない）という
 * 作法をここに1箇所へまとめる。
 *
 * `active ? <View> : <GlassSurface>` のように選択状態で要素の**型そのもの**を
 * 切り替えると、選択が移るたびに対象のピルがReactツリー上でunmount→mountされる
 * （CLAUDE.md「条件分岐でReactツリーの形を変えない」に抵触する）。ここでは外殻を
 * 常に `GlassSurface interactive` に固定し、選択状態は内側に常設した色被せ層
 * （absoluteFill）の `backgroundColor` だけを切り替えて表す。ボーダーの有無を
 * 選択状態で切り替えると寸法が数pxずれるため、枠は選択に関わらず常に同じ
 * （GlassSurface既定のfallbackBorderのまま）にする。
 */
export function SelectablePill({ active, onPress, style, hitStyle, disabled, accessibilityLabel, activeColor = colors.accent, children }: {
	active: boolean;
	onPress: () => void;
	/** 外殻（箱）の形。角丸・radius等は呼び出し側で指定する。 */
	style?: StyleProp<ViewStyle>;
	/** 中身のヒット領域の余白。ピル/チップで大きさが違うため呼び出し側が決める。 */
	hitStyle?: StyleProp<ViewStyle>;
	disabled?: boolean;
	accessibilityLabel?: string;
	/** 選択時に敷く色被せ。既定はaccent（呼び出し側で `colors.accentWash` 等に差し替え可）。 */
	activeColor?: string;
	children: ReactNode;
}) {
	return (
		// 押せないピルは光を揺らさない（interactiveのままだと押せる見た目の嘘になる）。
		<GlassSurface style={[styles.pill, style]} interactive={disabled !== true}>
			<View style={[StyleSheet.absoluteFill, active && { backgroundColor: activeColor }]} pointerEvents="none" />
			<Pressable
				style={[styles.hit, hitStyle]}
				onPress={onPress}
				disabled={disabled}
				accessibilityRole="button"
				accessibilityState={{ selected: active, disabled: disabled === true }}
				accessibilityLabel={accessibilityLabel}
			>
				{children}
			</Pressable>
		</GlassSurface>
	);
}

const styles = StyleSheet.create({
	// 内側の色被せ層を角丸で切り抜くため overflow hidden が要る
	// （GlassSurfaceのフォールバック素材は自身を切り抜くが、子は切り抜かないため）。
	pill: { overflow: 'hidden' },
	hit: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
