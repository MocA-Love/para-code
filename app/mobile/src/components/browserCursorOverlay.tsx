// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画面共有の映像の上に、エージェントのカーソルを描く（browser.cursor.v1、q.html Q276 A）。
// 座標の計算と台帳は ../browserCursors.ts。iPhone の狭い画面では名前だけ、広い画面では状態も出す。

import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { browserCursorPoint, browserCursorStatusText, type BrowserCursor } from '../browserCursors.js';

/** cursor-motion の矢印（PC のページに描くものと同じ形。128 の正方形で、先端が (55, 30)）。 */
const CURSOR_PATH = 'M55 30 C48 28 42 33 43 41 C43 41 64 98 64 98 C67 106 73 106 77 99 C77 99 86 79 86 79 C88 75 91 72 95 70 C95 70 108 63 108 63 C115 59 114 53 107 50 C107 50 55 30 55 30 Z';
/** 映像は縮んで見えるので、PC のページ（42px）より小さく描く。 */
const SIZE = 28;

interface Props {
	readonly cursors: readonly BrowserCursor[];
	readonly view: { readonly w: number; readonly h: number };
	readonly content: { readonly w: number; readonly h: number } | undefined;
	/** 名札に状態も出すか（iPad などの広い幅）。 */
	readonly showStatus: boolean;
}

export function BrowserCursorOverlay({ cursors, view, content, showStatus }: Props) {
	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="none">
			{cursors.map(cursor => {
				const point = browserCursorPoint(cursor.nx, cursor.ny, view, content);
				return point ? <CursorMark key={cursor.ownerId} cursor={cursor} x={point.x} y={point.y} showStatus={showStatus} /> : null;
			})}
		</View>
	);
}

function CursorMark({ cursor, x, y, showStatus }: { readonly cursor: BrowserCursor; readonly x: number; readonly y: number; readonly showStatus: boolean }) {
	const position = useRef(new Animated.ValueXY({ x, y })).current;
	const ripple = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		const animation = Animated.timing(position, { toValue: { x, y }, duration: Math.min(800, cursor.durationMs), easing: Easing.out(Easing.cubic), useNativeDriver: true });
		animation.start();
		return () => animation.stop();
	}, [x, y, cursor.durationMs, position]);
	useEffect(() => {
		if (cursor.presses === 0) {
			return;
		}
		ripple.setValue(0);
		const animation = Animated.timing(ripple, { toValue: 1, duration: 460, easing: Easing.out(Easing.cubic), useNativeDriver: true });
		animation.start();
		return () => animation.stop();
	}, [cursor.presses, ripple]);
	const status = showStatus ? browserCursorStatusText(cursor.status) : undefined;
	const scale = SIZE / 128;
	return (
		<Animated.View style={[styles.mark, { transform: position.getTranslateTransform() }]}>
			<Animated.View style={[styles.ripple, { borderColor: cursor.color, opacity: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.75, 0] }), transform: [{ scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1.6] }) }] }]} />
			<Svg width={SIZE} height={SIZE} viewBox="0 0 128 128" style={{ position: 'absolute', left: -55 * scale, top: -30 * scale }}>
				<Path d={CURSOR_PATH} fill={cursor.color} stroke="#ffffff" strokeWidth={6} strokeLinejoin="round" />
			</Svg>
			<View style={[styles.label, { backgroundColor: cursor.color }]}>
				{cursor.mark ? <Text style={styles.cli}>{cursor.mark}</Text> : null}
				<Text style={styles.name} numberOfLines={1}>{status ? `${cursor.name} · ${status}` : cursor.name}</Text>
			</View>
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	mark: { position: 'absolute', left: 0, top: 0, width: 0, height: 0 },
	ripple: { position: 'absolute', left: -14, top: -14, width: 28, height: 28, borderRadius: 14, borderWidth: 2 },
	label: { position: 'absolute', left: 12, top: 15, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 5, maxWidth: 220 },
	cli: { color: '#ffffff', fontSize: 9, fontWeight: '700', minWidth: 12, textAlign: 'center', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden' },
	name: { color: '#ffffff', fontSize: 11, fontWeight: '500', flexShrink: 1 },
});
