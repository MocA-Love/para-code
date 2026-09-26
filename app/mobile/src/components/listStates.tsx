// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, space, type } from '../theme.js';

/**
 * 一覧の「読み込み中」。ソース管理・ファイルで形をそろえる（以前は色の無いスピナーだけ・
 * 文字だけ、と画面ごとに違った）。空・失敗は `EmptyState` を使う。
 */
export function LoadingState({ label = '読み込み中…' }: { label?: string }) {
	return (
		<View style={styles.loading} accessibilityLiveRegion="polite">
			<ActivityIndicator color={colors.textDim} />
			<Text style={styles.loadingText}>{label}</Text>
		</View>
	);
}

/**
 * 前回の一覧を残したまま押せなくしているときに、一覧の上へ添える理由の1行。
 * 薄くするだけだと「なぜ押せないのか」が分からない。
 */
export function UnavailableNote({ reason }: { reason: string }) {
	return (
		<View style={styles.note} accessibilityRole="text" accessibilityLiveRegion="polite">
			<Ionicons name="cloud-offline-outline" size={14} color={colors.textDim} />
			<Text style={styles.noteText}>{reason}。前回の内容を表示しています</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	loading: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
	loadingText: { color: colors.textDim, fontSize: type.meta },
	note: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: space.sm },
	noteText: { flex: 1, color: colors.textDim, fontSize: type.meta, lineHeight: 18 },
});
