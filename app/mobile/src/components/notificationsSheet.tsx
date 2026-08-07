// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, View } from 'react-native';
import { Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { NotifyPayload } from '@para/protocol';
import { colors, radius } from '../theme.js';
import { hapticImpact } from '../haptics.js';

/**
 * ヘッダー右上の通知ボタン（Liquid Glassの丸ボタン）。タップで通知一覧ルート
 * （app/notifications.tsx）へ遷移する。iOS 18+ではLink.AppleZoomにより
 * ボタン自体が画面へモーフするネイティブのズーム遷移になる（それ未満は通常遷移）。
 * 応答待ち（agent-question）の通知が残っている間はベルに赤バッジを出す。
 * （旧: この場で自作ボトムシートを開いていた。一覧はルートへ移設済み）
 */
export function NotificationsButton({ notifications }: {
	notifications: readonly NotifyPayload[];
}) {
	const questionCount = notifications.filter(n => n.kind === 'agent-question').length;

	return (
		<Link href="/notifications" asChild>
			<Link.AppleZoom>
				{/* ヘッダー右のガラスのピルの中に入るので、ここでガラスを重ねない（Apple HIG）。
				    見た目は34ptだが、隣のボタンと粒の違う操作なので当たり判定は広げておく。 */}
				<Pressable
					style={({ pressed }) => [styles.bellBtn, pressed && styles.bellBtnPressed]}
					hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
					onPress={() => hapticImpact('light')}
					accessibilityRole="button"
					accessibilityLabel={questionCount > 0 ? `通知。応答待ち ${questionCount}件` : '通知'}
				>
					<Ionicons name="notifications-outline" size={17} color={colors.text} />
					{questionCount > 0 ? <View style={styles.bellBadge} /> : null}
				</Pressable>
			</Link.AppleZoom>
		</Link>
	);
}

const styles = StyleSheet.create({
	bellBtn: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	bellBtnPressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
	// 件数は出さない。同じ数はタブバーのバッジが持っており、ガラスのピルの中に小さな数字を
	// もう1つ置いても読めないうえ、母数の違う数字が並んで見える。
	bellBadge: { position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
});
