// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient as SvgGradient, Rect, Stop } from 'react-native-svg';
import { colors } from '../theme.js';

/**
 * 浮かぶヘッダーの背後だけ地色へ落とすグラデーション。
 *
 * ガラスの島の下を本文が流れる作りにすると、島の縁で行が唐突に切れて見える。
 * ここで上端を地色に寄せておくと、行が「奥へ入っていく」ように見える。
 *
 * `react-native-svg` で描く（`scrollEdgeEffects` の `ScrollViewMarker` は experimental で、
 * 直下 subtree の ScrollView にしか効かない）。置いた View の**全面**を塗るので、
 * 高さは呼び出し側の器で決めること。`pointerEvents="none"` なので下の本文は触れる。
 */
export function HeaderEdgeFade({ id = 'paraHeaderFade', color = colors.bg, opacity = 0.94 }: {
	/** 同じ画面に2つ以上敷くときだけ変える（SVGのグラデーション定義IDが衝突するため）。 */
	id?: string;
	/** 落とす先の色。既定は画面の地色。シートの中では面の色を渡す。 */
	color?: string;
	/** 上端での濃さ。 */
	opacity?: number;
}) {
	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="none">
			<Svg width="100%" height="100%">
				<Defs>
					<SvgGradient id={id} x1="0" y1="0" x2="0" y2="1">
						<Stop offset="0" stopColor={color} stopOpacity={String(opacity)} />
						<Stop offset="0.58" stopColor={color} stopOpacity={String(opacity * 0.585)} />
						<Stop offset="1" stopColor={color} stopOpacity="0" />
					</SvgGradient>
				</Defs>
				<Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
			</Svg>
		</View>
	);
}
