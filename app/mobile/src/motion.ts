// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { GentleSpringConfig, SnappySpringConfig, type WithSpringConfig } from 'react-native-reanimated';

/**
 * ばねと時間のプリセット。動きの値を画面ごとに発明しないための一箇所。
 *
 * **`withSpring` に damping と stiffness だけ渡してはいけない。** 既定の mass は 4 なので、
 * mass 1 のつもりで減衰と硬さを決めると意図の5倍近く揺れて収束も遅くなる。ここでは
 * Reanimated 4 が公開しているプリセット（いずれも mass を明示的に持つ）をそのまま使い、
 * 独自の値を足すときも mass を必ず書く。
 */
export const spring = {
	/** メニュー・ポップオーバーの出現。行き過ぎずに素早く止まる（overshootClamping つき）。 */
	snappy: SnappySpringConfig,
	/** シート・ドロワーの移動。少し柔らかく着地する。 */
	gentle: GentleSpringConfig,
	/** スワイプの復帰。指を離した位置から元へ戻す。 */
	swipe: { damping: 22, stiffness: 260, mass: 1 } satisfies WithSpringConfig,
} as const;

/**
 * ばねが似合わない場面のための時間指定（ミリ秒）。
 *
 * 押下のハイライトのように「押している間だけ」の表現は、ばねだと離した後も揺れて
 * 指の動きから遅れるため、短い timing のほうが合う。
 */
export const duration = {
	/** 押下フィードバック。 */
	press: 90,
	/** スクリム等の淡いフェード。 */
	fade: 160,
} as const;

/** 押下時の縮み。ガラスボタンに当てる（不透明ボタンにはガラスを被せず、これだけ足す）。 */
export const PRESS_SCALE = 0.96;
