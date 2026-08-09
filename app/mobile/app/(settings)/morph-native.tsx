// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Stack, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, mono, radius, squircle } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';

/**
 * 設定 →「ヘッダーの動きを試す」→「OSに任せた場合を見る」。**実験台。出荷しない。**
 *
 * ## 何を確かめる画面か
 * ここだけ**iOS標準のナビゲーションバーを出している**（アプリの他の画面は自前のヘッダー層を
 * 浮かべているので標準バーは隠してある）。左に「アバター＋名前」のカプセルを置き、そこから
 * 次の画面へpushする。**押したときにカプセルが丸い戻るボタンへ形ごと変わるかを見る。**
 *
 * ## なぜこれが決定的なのか
 * LINEの実機録画を60fpsでコマ送りして測った挙動（幅が縮む・中身がぼける・タイトルが右から
 * 68pt滑り込む・器とタイトルで所要が違う）は、**iOS 26の標準バーがpush/popのときに自分で
 * 描いているもの**だと判定した。Apple公式（`UIBarButtonItem.identifier` の説明）が
 * 「バー項目の集合が変わると UIKit が自動で遷移をアニメーションし、位置と内容から
 * 同じ項目を推定して対応付ける」と明言しており、**対応付けは識別子を与えなくても既定で走る**。
 *
 * もしここでモーフすれば、自前で補間を書く必要はまったく無い。**逆にモーフしなければ、
 * カスタムビューが対応付けから外れているということ**で、その場合の直し方は識別子
 * （`UIBarButtonItem.identifier`）を通すしかなく、それは react-native-screens の
 * カスタムビュー経路に配線されていない（宣言的なアイコン項目にしか渡らない）。
 *
 * ## 見るときの注意
 * - **ここのカプセルには自前のガラスを置いていない。** iOS 26 はバー項目のカスタムビューに
 *   自動でガラスの器を付けるので、自分で重ねると枠が二重になる
 * - 器が付くかどうかも同時に見てほしい（付いていれば、いま自前で描いているカプセルは不要）
 * - **往きと戻りの両方**を見ること。戻りだけ崩れる場合は別の既知の不具合（去る側の
 *   スナップショット差し替え）に当たっている
 */
export default function MorphNativeScreen() {
	return (
		<View style={styles.screen}>
			<Stack.Screen
				options={{
					headerShown: true,
					title: '',
					headerLeft: () => (
						// 素の中身だけ。ガラスはOSが付ける。
						<View style={styles.capsule}>
							<View style={styles.avatar}><Text style={styles.avatarText}>P</Text></View>
							<Text style={styles.capsuleName} numberOfLines={1}>すべてのスペース</Text>
						</View>
					),
					headerRight: () => (
						<View style={styles.rightGroup}>
							<Ionicons name="notifications-outline" size={18} color={colors.text} />
						</View>
					),
				}}
			/>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
				<Text style={styles.lead}>
					この画面だけiOS標準のナビゲーションバーを出しています。左のカプセルは中身だけを渡していて、
					ガラスの器はOSが付けたものです。
				</Text>

				<Pressable
					style={({ pressed }) => [styles.push, pressed && styles.pushPressed]}
					onPress={() => { hapticSelection(); router.push('/morph-native-detail'); }}
				>
					<Ionicons name="arrow-forward" size={18} color={colors.bg} />
					<Text style={styles.pushLabel}>次の画面へ進む</Text>
				</Pressable>

				<Text style={styles.sectionTitle}>見てほしいこと</Text>
				<View style={styles.card}>
					<Check text="押した瞬間、左のカプセルが丸い戻るボタンへ幅を変えながら移り変わるか（それとも消えて別物が出てくるか）" />
					<Check text="移り変わる最中、中身がぼけるか" />
					<Check text="次の画面のタイトルが、右から滑り込んでくるか" />
					<Check text="戻るときも同じように動くか" />
					<Check text="カプセルにガラスの器が付いているか（付いていれば、自前で描く必要がない）" />
				</View>

				<Text style={styles.footnote}>
					ここでモーフすれば、画面遷移の動きは自分で書く必要がありません。モーフしなければ、
					カスタムビューがOSの対応付けから外れているということで、別の手当てが必要になります。
				</Text>
			</ScrollView>
		</View>
	);
}

function Check({ text }: { text: string }) {
	return (
		<View style={styles.checkRow}>
			<Ionicons name="ellipse-outline" size={15} color={colors.accent} style={styles.checkIcon} />
			<Text style={styles.checkText}>{text}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1 },
	content: { padding: 16, paddingBottom: 48 },
	lead: { color: colors.textDim, fontSize: 12.5, lineHeight: 19 },

	capsule: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 6 },
	avatar: { width: 26, height: 26, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(9,175,217,.28)' },
	avatarText: { color: colors.accent, fontSize: 12, fontWeight: '800', fontFamily: mono.default },
	capsuleName: { color: colors.text, fontSize: 14, fontWeight: '700' },
	rightGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },

	push: { marginTop: 18, height: 46, borderRadius: radius.pill, ...squircle, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
	pushPressed: { opacity: 0.85 },
	pushLabel: { color: colors.bg, fontSize: 15, fontWeight: '700' },

	sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginTop: 24, marginBottom: 8, letterSpacing: 0.3 },
	card: { backgroundColor: colors.panel, borderRadius: radius.card, ...squircle, paddingHorizontal: 14, paddingVertical: 6 },
	checkRow: { flexDirection: 'row', gap: 10, paddingVertical: 9 },
	checkIcon: { marginTop: 2 },
	checkText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 19 },
	footnote: { color: colors.textDim, fontSize: 11, lineHeight: 17, marginTop: 22 },
});
