// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { hapticImpact } from '../haptics.js';

/**
 * 一覧の行を横スワイプで片付けるための包み。ホームは左スワイプで「アーカイブ」、
 * アーカイブ画面は右スワイプで「戻す」に使う。
 *
 * RNGHの`ReanimatedSwipeable`は使わない。あれは動く幅をアクション面の`measure()`から
 * 決めるため、この一覧では幅が取れずに**指を横に動かしても行が1pxも動かない**うえ、
 * 横方向のジェスチャだけは掴んでしまい、ホームの全画面スワイプ（ドロワーを開く）まで
 * 効かなくなった。ここでは幅を定数で持ち、自前のPanで動かす。
 *
 * **`direction`の向きにしか反応しない**のが要点。ホームは左スワイプだけを取るので、
 * 右スワイプはそのままドロワーへ抜ける（アーカイブ画面はドロワーの対象外なので逆向き）。
 */

/** アクション面の幅。指を離す判定もこの半分強で行う。 */
const ACTION_WIDTH = 108;
const TRIGGER_DISTANCE = 64;
const TRIGGER_VELOCITY = 700;

export function SwipeRow({ direction, label, icon, color, onTrigger, children }: {
	/** 'left' は指を左へ引く（右側からアクションが出る）。'right' はその逆。 */
	direction: 'left' | 'right';
	label: string;
	icon: keyof typeof Ionicons.glyphMap;
	/** アクション面の色。 */
	color: string;
	onTrigger: () => void;
	children: ReactNode;
}) {
	const dx = useSharedValue(0);
	const toLeft = direction === 'left';
	const trigger = useCallback(() => {
		hapticImpact('medium');
		onTrigger();
	}, [onTrigger]);

	const pan = useMemo(() => Gesture.Pan()
		// この向きのときだけ掴む。逆向きは触らないので、ドロワーや縦スクロールを妨げない。
		.activeOffsetX(toLeft ? -14 : 14)
		.failOffsetY([-12, 12])
		.onUpdate(event => {
			const limit = ACTION_WIDTH * 1.25;
			dx.value = toLeft
				? Math.min(0, Math.max(event.translationX, -limit))
				: Math.max(0, Math.min(event.translationX, limit));
		})
		.onEnd(event => {
			const passed = toLeft
				? event.translationX < -TRIGGER_DISTANCE || event.velocityX < -TRIGGER_VELOCITY
				: event.translationX > TRIGGER_DISTANCE || event.velocityX > TRIGGER_VELOCITY;
			// 発動しても指を離した位置で止めない。片付いた行はそのまま一覧から消えるので、
			// 残った場合（消えなかった場合）だけ元の位置へ戻る形になる。
			dx.value = withSpring(0, { damping: 22, stiffness: 260 });
			if (passed) {
				runOnJS(trigger)();
			}
		}), [dx, toLeft, trigger]);

	const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }] }));
	// 引き始めてすぐに面が見え、離すと一緒に消える。
	const actionStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.abs(dx.value) / 28) }));

	return (
		<View style={styles.wrap}>
			<Animated.View
				style={[styles.action, toLeft ? styles.actionRight : styles.actionLeft, { backgroundColor: color }, actionStyle]}
				pointerEvents="none"
			>
				<Ionicons name={icon} size={17} color="#fff" />
				<Text style={styles.actionText}>{label}</Text>
			</Animated.View>
			<GestureDetector gesture={pan}>
				<Animated.View style={rowStyle}>{children}</Animated.View>
			</GestureDetector>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { position: 'relative' },
	// 行（agentRowStyles.container）の下マージン8ぶんを避け、行と同じ高さ・角丸にする。
	action: {
		position: 'absolute', top: 0, bottom: 8, width: ACTION_WIDTH,
		flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
		borderRadius: 14,
	},
	actionRight: { right: 0 },
	actionLeft: { left: 0 },
	actionText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
