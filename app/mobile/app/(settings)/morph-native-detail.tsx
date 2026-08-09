// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, mono, radius, squircle } from '../../src/theme.js';

/**
 * 「OSに任せた場合を見る」の遷移先。**実験台。出荷しない。**
 *
 * ここは**標準の戻るボタンに任せる**（`headerLeft` を渡さない）。前の画面の左は
 * アバター＋名前のカプセルなので、UIKit が「同じ項目」と推定できれば、カプセルが
 * この丸い戻るボタンへ形ごと移り変わる。詳しい狙いは `morph-native.tsx` の説明を読むこと。
 *
 * タイトルとサブタイトルを出しているのは、**タイトルが右から滑り込んでくるか**を
 * 見るため（LINEの実測では68pt・強いease-outの尾・333ms）。
 */
export default function MorphNativeDetailScreen() {
	return (
		<View style={styles.screen}>
			<Stack.Screen
				options={{
					headerShown: true,
					title: 'エージェント',
					headerBackTitle: '',
					headerRight: () => (
						<Ionicons name="globe-outline" size={18} color={colors.text} />
					),
				}}
			/>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
				<Text style={styles.lead}>
					戻るボタンは標準のものです。前の画面のカプセルがこの丸へ移り変わったかを、
					戻る操作でもう一度確かめてください。
				</Text>

				<Text style={styles.sectionTitle}>測った目標（LINE・60fps）</Text>
				<View style={styles.card}>
					<Row k="形の変化" v="角丸カプセル→円へ単調に幅が縮む。凹みは無い" />
					<Row k="中身" v="ガウスぼかし。半径はモーフ中央で最大、両端でゼロ" />
					<Row k="入れ替え" v="ぼけた状態で旧と新が同時に見える。完全な透明にはならない" />
					<Row k="器の輪郭" v="全フレーム鮮明" />
					<Row k="タイトル" v="右から68pt滑り込み、正確な中央に着地" />
					<Row k="所要" v="往き215ms / 戻り333ms（非対称）" />
				</View>

				<Text style={styles.footnote}>
					ここに書いた6項目のうち、いくつがこの画面で再現されているかが判断材料になります。
				</Text>
			</ScrollView>
		</View>
	);
}

function Row({ k, v }: { k: string; v: string }) {
	return (
		<View style={styles.row}>
			<Text style={styles.rowKey}>{k}</Text>
			<Text style={styles.rowValue}>{v}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1 },
	content: { padding: 16, paddingBottom: 48 },
	lead: { color: colors.textDim, fontSize: 12.5, lineHeight: 19 },
	sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginTop: 24, marginBottom: 8, letterSpacing: 0.3 },
	card: { backgroundColor: colors.panel, borderRadius: radius.card, ...squircle, paddingHorizontal: 14, paddingVertical: 6 },
	row: { paddingVertical: 9 },
	rowKey: { color: colors.accent, fontSize: 11, fontWeight: '700', fontFamily: mono.default },
	rowValue: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 2 },
	footnote: { color: colors.textDim, fontSize: 11, lineHeight: 17, marginTop: 22 },
});
