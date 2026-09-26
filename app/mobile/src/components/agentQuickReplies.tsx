// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { colors, radius, space, squircle, type } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import { QUICK_REPLIES } from '../agentConversationUx.js';
import { hitSlopToMinimum } from './hitSlop.js';

/**
 * 作業を終えたエージェントへの短い返信のチップ（コンポーザーの上に横並び）。
 * 押すと入力欄へ文字が入るだけで、送信はしない（そのまま送るか、書き足してから送るかを選べる）。
 * 出すかどうかの判定は `agentConversationUx.ts` の `shouldShowQuickReplies`。
 */
export function AgentQuickReplies({ onPick }: { onPick: (text: string) => void }) {
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.row}>
			{QUICK_REPLIES.map(reply => (
				<Pressable
					key={reply}
					style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
					hitSlop={CHIP_HIT_SLOP}
					onPress={() => { hapticSelection(); onPick(reply); }}
					accessibilityRole="button"
					accessibilityLabel={`「${reply}」を入力欄に入れる`}
				>
					<Text style={styles.chipText}>{reply}</Text>
				</Pressable>
			))}
		</ScrollView>
	);
}

/** チップの見た目の高さ。当たり判定は 44pt へ広げる（横に並ぶので上下だけ）。 */
const CHIP_HEIGHT = 34;
const CHIP_HIT_SLOP = hitSlopToMinimum(CHIP_HEIGHT);

const styles = StyleSheet.create({
	row: { flexDirection: 'row', gap: space.sm, paddingVertical: space.xs },
	chip: {
		height: CHIP_HEIGHT, justifyContent: 'center', paddingHorizontal: space.md,
		borderRadius: radius.pill, ...squircle, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong,
	},
	chipText: { color: colors.text, fontSize: type.meta, fontWeight: '600' },
	pressed: { opacity: 0.6 },
});
