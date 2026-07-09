// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { colors } from '../theme.js';

/**
 * Liquid Glass面の共通コンポーネント。iOS 26+では本物のLiquid Glass
 * （expo-glass-effect / UIVisualEffectView）で描画し、それ未満・Androidでは
 * 従来のBlurView+半透明オーバーレイ（自作glass風）へフォールバックする。
 *
 * 注意（expo-glass-effectの制約）:
 *  - GlassViewまたは親のopacityを0にすると効果ごと消えるため、フェードには使わない
 *  - Apple HIGに従い「glassの上にglassを重ねない」。コンポーザー内のボタン等、
 *    既にglass面の上に載る要素はこのコンポーネントを使わず不透明のままにする
 */
export const liquidGlass: boolean = isLiquidGlassAvailable();

export function GlassSurface({ style, children, interactive = false, tintColor }: {
	/** 角丸・サイズ等。ネイティブglass時もそのまま適用される（overflow: 'hidden' を含めること）。 */
	style?: StyleProp<ViewStyle>;
	children?: ReactNode;
	/** タッチに反応して光が揺れる純正のインタラクティブglass（ボタン用途）。 */
	interactive?: boolean;
	/** glassへの色被せ（ワークスペースチップ等、アイデンティティ色が必要な場合）。 */
	tintColor?: string;
}) {
	if (liquidGlass) {
		return (
			<GlassView style={style} glassEffectStyle="regular" isInteractive={interactive} tintColor={tintColor}>
				{children}
			</GlassView>
		);
	}
	return (
		<View style={style}>
			<BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
			<View style={[StyleSheet.absoluteFill, styles.fallbackOverlay, tintColor !== undefined && { backgroundColor: tintColor + '33' }]} />
			{children}
		</View>
	);
}

const styles = StyleSheet.create({
	fallbackOverlay: { backgroundColor: colors.glassBg },
});
