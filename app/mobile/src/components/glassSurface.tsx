// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { StyleProp, StyleSheet, View, ViewProps, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassContainer, GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { GlassEffectStyleConfig, GlassStyle } from 'expo-glass-effect';
import { colors, withAlpha } from '../theme.js';

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

/**
 * ネイティブのLiquid Glassを使えるか。
 *
 * `isLiquidGlassAvailable()` だけでは足りない。iOS 26 のベータ実機には `UIGlassEffect`
 * クラスを欠くものがあり、そこでは `GlassView` が黙って何も描かない（フォールバックにも
 * 落ちないので、子を持たない背景専用の面は丸ごと消える）。`isGlassEffectAPIAvailable()` は
 * まさにその判定のためにパッケージ側が用意しているので、両方が真のときだけネイティブを使う。
 */
export const liquidGlass: boolean = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

/** 角丸に関わるスタイルキー。フォールバックの素材レイヤへそのまま写して形を合わせる。 */
const RADIUS_KEYS = [
	'borderRadius', 'borderCurve',
	'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
	'borderTopStartRadius', 'borderTopEndRadius', 'borderBottomStartRadius', 'borderBottomEndRadius',
] as const satisfies readonly (keyof ViewStyle)[];

/** `style` から角丸だけを抜き出す。 */
function radiusOf(style: StyleProp<ViewStyle>): ViewStyle {
	// 型は `T` を返すと書いてあるが、実装は style が null/undefined だと undefined を返す。
	// style 無しで呼ばれたときにここで落ちないよう受け止める。
	const flat = StyleSheet.flatten(style) as ViewStyle | undefined ?? {};
	const radius: ViewStyle = {};
	for (const key of RADIUS_KEYS) {
		const value = flat[key];
		if (value !== undefined) {
			Object.assign(radius, { [key]: value });
		}
	}
	return radius;
}

/**
 * 非対応環境で面の素材（ぼかし＋色被せ）だけを角丸に切り抜いて敷く層。
 *
 * 切り抜くのは素材だけで、子は切り抜かない。外枠ごと `overflow: 'hidden'` にすると、
 * 面からはみ出す位置のバッジが円周で欠ける。枠線もこの層に置く（外枠に置くと
 * borderWidth のぶん中身が1pxずれる）。
 */
function FallbackMaterial({ style, tint, border }: { style: StyleProp<ViewStyle>; tint?: string; border: boolean }) {
	return (
		<View
			style={[StyleSheet.absoluteFill, styles.fallbackClip, radiusOf(style), border && styles.fallbackBorder]}
			pointerEvents="none"
		>
			<BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
			<View style={[StyleSheet.absoluteFill, styles.fallbackOverlay, tint !== undefined && { backgroundColor: tint }]} />
		</View>
	);
}

export function GlassSurface({ style, children, interactive = false, tintColor, tintOpacity = 0.2, fallbackBorder = true, appearance, pointerEvents }: {
	/**
	 * 角丸・サイズ等。ネイティブglass時もそのまま適用される。
	 *
	 * `overflow: 'hidden'` は**書かなくてよい**。フォールバックのぼかしはこの中で角丸に
	 * 切り抜くので、書くと子（バッジ等）まで円周で欠ける。
	 */
	style?: StyleProp<ViewStyle>;
	children?: ReactNode;
	/** タッチに反応して光が揺れる純正のインタラクティブglass（ボタン用途）。 */
	interactive?: boolean;
	/** glassへの色被せ（ワークスペースチップ等、アイデンティティ色が必要な場合）。不透明度は足さずに渡す。 */
	tintColor?: string;
	/** 色被せの濃さ（0〜1）。1なら色をそのまま渡す。 */
	tintOpacity?: number;
	/**
	 * 非対応環境で面の輪郭を描くか。既定で描く。
	 *
	 * ネイティブglassは素材自体が縁の光を持つが、フォールバックのぼかしには輪郭が無く、
	 * 面がどこまでか分からなくなる。全周の枠が邪魔な面（画面下端に貼り付くシートの背面など）
	 * でだけ `false` にすること。
	 */
	fallbackBorder?: boolean;
	/**
	 * 素材を出し入れするときに渡す。
	 *
	 * ガラスは `opacity` では消せない（0にすると効果ごと死ぬ）ので、代わりにネイティブ側の
	 * 素材の種類を `regular` と `none` の間で遷移させる。**{@link GlassGroup} の中で使うと、
	 * 隣のガラスと融合しながら生えてくる**——ボタンからメニューが伸びてくる表現はこれで作る。
	 */
	appearance?: { visible: boolean; duration: number };
	pointerEvents?: ViewProps['pointerEvents'];
}) {
	const tint = tintColor !== undefined ? withAlpha(tintColor, tintOpacity) : undefined;
	if (liquidGlass) {
		const effect: GlassStyle | GlassEffectStyleConfig = appearance === undefined
			? 'regular'
			: { style: appearance.visible ? 'regular' : 'none', animate: true, animationDuration: appearance.duration };
		return (
			<GlassView style={style} glassEffectStyle={effect} isInteractive={interactive} tintColor={tint} pointerEvents={pointerEvents}>
				{children}
			</GlassView>
		);
	}
	return (
		<View style={style} pointerEvents={pointerEvents}>
			<FallbackMaterial style={style} tint={tint} border={fallbackBorder} />
			{children}
		</View>
	);
}

/**
 * **ガラス面そのものをアニメーションさせてはいけない。**
 *
 * `Animated.createAnimatedComponent(GlassView)` で大きさを動かすと、Reanimated が
 * ネイティブのガラスビューへ直接プロパティを書き込もうとして**アプリごと落ちる**
 * （影ツリーへの反映中に落ちるので、原因が動かした側だと分かりにくい）。実際に
 * ＋メニューを「繋がったまま開く」ために試して、実機で落ちることを確認した。
 *
 * 動かしたいときは、ガラスは静止させたまま**その上に載っている中身**（普通のView）の
 * 濃さや位置を動かす。ただし {@link GlassGroup} の融合は直下の兄弟にしか効かないので、
 * ガラスを `Animated.View` で包むと今度は融合が切れる。**融合と動きは両立しない**と
 * 割り切って、どちらを取るかをその場で決めること。
 */

/**
 * 隣り合うglass面を束ねる器（`UIGlassContainerEffect`）。中の面同士が `spacing` 以内まで
 * 近づくと液体のように融合し、離れるとちぎれる。iOS 26のガラスが「生きて動く」表現の中核。
 *
 * **効くのは直下に兄弟として並ぶ {@link GlassSurface} 同士だけ**。ネイティブ側の
 * `mountChildComponentView` は直下の子しかコンテナの `contentView` へ差し込まないため、
 * `Pressable > GlassSurface` のように1段挟むと融合しない（＝押せるガラスを作るときは
 * ガラスを外側に、`Pressable` を中身として入れる）。
 *
 * 非対応環境では素の `View` になる。ここで `BlurView` を敷いてはいけない
 * （子が各自 `BlurView` を持つため二重ブラーになる）。
 */
export function GlassGroup({ style, spacing, children }: {
	style?: StyleProp<ViewStyle>;
	/** 面同士が影響しあい始める距離（pt）。未指定ならシステム既定。 */
	spacing?: number;
	children?: ReactNode;
}) {
	if (liquidGlass) {
		return <GlassContainer style={style} spacing={spacing}>{children}</GlassContainer>;
	}
	return <View style={style}>{children}</View>;
}

const styles = StyleSheet.create({
	fallbackOverlay: { backgroundColor: colors.glassBg },
	fallbackClip: { overflow: 'hidden' },
	fallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
});
