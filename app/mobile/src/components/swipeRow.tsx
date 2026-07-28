// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme.js';
import { hapticImpact } from '../haptics.js';

/**
 * 一覧の行を横スワイプで片付けるための包み。ホームは左スワイプで「アーカイブ」、
 * アーカイブ画面は右スワイプで「戻す」に使う。
 *
 * ジェスチャ認識はRNGH（ネイティブ）で行う。ホームはフォーカス中に画面全域の
 * 右スワイプでワークスペースドロワーが開くため、**ホーム側では左スワイプだけ**を
 * 有効にして取り合いを避ける（direction で使う側を分ける）。
 */
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
	const ref = useRef<SwipeableMethods>(null);
	const action = () => (
		<View style={[styles.action, { backgroundColor: color }, direction === 'right' && styles.actionStart]}>
			<Ionicons name={icon} size={17} color="#fff" />
			<Text style={styles.actionText}>{label}</Text>
		</View>
	);
	return (
		<ReanimatedSwipeable
			ref={ref}
			friction={1.6}
			// 行の高さぶんも引かないと発動しないと重いので、3分の1ほどで開く。
			rightThreshold={56}
			leftThreshold={56}
			overshootRight={false}
			overshootLeft={false}
			enableTrackpadTwoFingerGesture
			{...(direction === 'left' ? { renderRightActions: action } : { renderLeftActions: action })}
			onSwipeableOpen={() => {
				hapticImpact('medium');
				// 閉じてから実行する。実行で行が消える場合、開いたままの内部状態が
				// 次に同じ位置へ来た行へ引き継がれてしまう。
				ref.current?.close();
				onTrigger();
			}}
		>
			{children}
		</ReanimatedSwipeable>
	);
}

const styles = StyleSheet.create({
	// 行（agentRowStyles.container）と同じ角丸・同じ下マージンにする。揃えないと
	// 行の下の隙間にもアクション面が残り、帯が1本ぶん長く見える。
	action: {
		flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
		gap: 7, paddingHorizontal: 20, borderRadius: 14, marginBottom: 8,
	},
	actionStart: { justifyContent: 'flex-start' },
	actionText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
