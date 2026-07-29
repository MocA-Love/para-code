// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PendingAgentMessage } from '../pendingAgentMessages.js';
import { BottomSheet } from './bottomSheet.js';
import { GlassSurface } from './glassSurface.js';
import { colors } from '../theme.js';
import { hapticSelection } from '../haptics.js';
import { useStableInsets } from '../hooks/useStableInsets.js';

/**
 * 「送ったが、まだ読まれていない」メッセージの件数を示すLiquid Glassのチップ。
 * 実行中インジケータの行に同居させ、タップで中身（PendingMessagesSheet）を開く。
 *
 * 送信した本文は会話に現れるまで画面のどこにも出ないため、これが唯一の手がかりになる。
 * 控えの持ち方は pendingAgentMessages.ts 参照。
 */
export function PendingMessagesChip({ count, onPress }: { count: number; onPress: () => void }) {
	if (count <= 0) {
		return null;
	}
	return (
		<Pressable
			style={styles.chip}
			onPress={() => { hapticSelection(); onPress(); }}
			hitSlop={6}
			accessibilityRole="button"
			accessibilityLabel={`送信予定 ${count}件。開いて内容を確認`}
		>
			{/* 角丸はガラス面自体に渡す（ネイティブglassが正しい丸形状で描画される） */}
			<GlassSurface style={styles.chipGlass} interactive />
			<View style={styles.chipDot} />
			<Text style={styles.chipText}>送信予定 {count}</Text>
			<Ionicons name="chevron-forward" size={11} color={colors.textDim} />
		</Pressable>
	);
}

/** 最後の行とホームインジケータの間に空ける余白（これにセーフエリアを足す）。 */
const BOTTOM_GAP = 24;

/**
 * 送信予定の中身。読まれる順に並べる。
 * すでにエージェントへ渡っているので、ここから取り消すことはできない（その旨を明記する）。
 *
 * BottomSheetは高さ72%で内容をクリップするだけなので、スクロールと余白はここで持つ
 * （他のシートと同じ構成）。本文は長文になりうるうえ件数も増えるため、ScrollViewが無いと
 * 枠を超えた分に到達する手段が無くなる。下端はホームインジケータに接しないようinsetを足す。
 */
export function PendingMessagesSheet({ visible, messages, onClose }: {
	visible: boolean;
	messages: readonly PendingAgentMessage[];
	onClose: () => void;
}) {
	const insets = useStableInsets();
	return (
		<BottomSheet visible={visible} onClose={onClose} title={`送信予定 ${messages.length}件`} glass>
			<ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: BOTTOM_GAP + insets.bottom }}>
				<Text style={styles.note}>エージェントが手を空けたら、この順で読まれます。送信済みのため、ここから取り消すことはできません。</Text>
				{/* glassの上にglassを重ねない（Apple HIG）。行は不透明のまま置く */}
				<View style={styles.list}>
					{messages.map((message, index) => (
						<View key={message.id} style={styles.row}>
							<View style={styles.num}><Text style={styles.numText}>{index + 1}</Text></View>
							<Text style={styles.rowText} selectable>{message.text}</Text>
						</View>
					))}
				</View>
			</ScrollView>
		</BottomSheet>
	);
}

const styles = StyleSheet.create({
	chip: {
		flexDirection: 'row', alignItems: 'center', gap: 5,
		paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, marginLeft: 'auto',
	},
	chipGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 999, overflow: 'hidden' },
	chipDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.yellow },
	chipText: { color: colors.text, fontSize: 10.5, fontWeight: '600' },
	body: { paddingHorizontal: 20 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginBottom: 12 },
	list: { gap: 8 },
	row: {
		flexDirection: 'row', alignItems: 'flex-start', gap: 9,
		backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
		borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10,
	},
	num: {
		width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: colors.borderStrong,
		alignItems: 'center', justifyContent: 'center', marginTop: 1,
	},
	numText: { color: colors.textDim, fontSize: 9.5, fontWeight: '700' },
	rowText: { flex: 1, color: colors.text, fontSize: 12.5, lineHeight: 18 },
});
