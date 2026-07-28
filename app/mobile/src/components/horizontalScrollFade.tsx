// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { colors } from '../theme.js';

/**
 * はみ出す内容（表・コードブロック）を横スクロールさせ、まだ続きがある側にだけ
 * 端のグラデーションを出す。本家Claudeアプリと同じく「表とコードだけ」を横に流し、
 * 本文の折り返しには影響させない。
 *
 * フェードは react-native-svg で描く（既存依存で完結させ、ネイティブ追加をしない）。
 */
const FADE_WIDTH = 30;

export function HorizontalScrollFade({ children, style, contentStyle }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; contentStyle?: StyleProp<ViewStyle> }) {
	const [height, setHeight] = useState(0);
	// スクロール前からはみ出しを判定できるよう、表示幅と内容幅を別々に測る
	// （onScroll だけだと初回表示で右のフェードが出ない）。
	const [viewport, setViewport] = useState(0);
	const [content, setContent] = useState(0);
	const [offset, setOffset] = useState(0);
	const overflow = Math.max(0, content - viewport);
	const showLeft = overflow > 1 && offset > 2;
	const showRight = overflow > 1 && offset < overflow - 2;
	return (
		<View style={style} onLayout={event => setHeight(event.nativeEvent.layout.height)}>
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => setOffset(event.nativeEvent.contentOffset.x)}
				onLayout={event => setViewport(event.nativeEvent.layout.width)}
				onContentSizeChange={(width: number) => setContent(width)}
				scrollEventThrottle={16}
				contentContainerStyle={contentStyle}
			>
				{children}
			</ScrollView>
			{showLeft ? <Fade height={height} side="left" /> : null}
			{showRight ? <Fade height={height} side="right" /> : null}
		</View>
	);
}

function Fade({ height, side }: { height: number; side: 'left' | 'right' }) {
	if (height <= 0) {
		return null;
	}
	const id = `hsf-${side}`;
	return (
		<View pointerEvents="none" style={[styles.fade, side === 'left' ? styles.fadeLeft : styles.fadeRight]}>
			<Svg width={FADE_WIDTH} height={height}>
				<Defs>
					<LinearGradient id={id} x1={side === 'left' ? '1' : '0'} y1="0" x2={side === 'left' ? '0' : '1'} y2="0">
						<Stop offset="0" stopColor={colors.bg} stopOpacity="0" />
						<Stop offset="0.75" stopColor={colors.bg} stopOpacity="0.85" />
						<Stop offset="1" stopColor={colors.bg} stopOpacity="0.96" />
					</LinearGradient>
				</Defs>
				<Rect x="0" y="0" width={FADE_WIDTH} height={height} fill={`url(#${id})`} />
			</Svg>
		</View>
	);
}

const styles = StyleSheet.create({
	fade: { position: 'absolute', top: 0, bottom: 0, width: FADE_WIDTH },
	fadeLeft: { left: 0 },
	fadeRight: { right: 0 },
});
