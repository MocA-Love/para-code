// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { NotifyPayload } from '@para/protocol';
import { HIT_SIZE, colors, radius, squircle, type } from '../theme.js';
import { haptic } from '../haptics.js';
import { unreadQuestionNotificationCount } from './notificationCount.js';

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
	const questionCount = unreadQuestionNotificationCount(notifications);

	return (
		<Link href="/notifications" asChild>
			<Link.AppleZoom>
				{/* ヘッダー右のガラスのピルの中に入るので、ここでガラスを重ねない（Apple HIG）。
				    見た目は34ptだが、隣のボタンと粒の違う操作なので当たり判定は広げておく。 */}
				<Pressable
					style={({ pressed }) => [styles.bellBtn, pressed && styles.bellBtnPressed]}
					hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
					onPress={() => haptic('move')}
					accessibilityRole="button"
					accessibilityLabel={questionCount > 0 ? `通知。要対応 ${questionCount}件` : '通知'}
				>
					<Ionicons name="notifications-outline" size={17} color={colors.text} />
					{questionCount > 0 ? <View style={styles.bellBadge} /> : null}
				</Pressable>
			</Link.AppleZoom>
		</Link>
	);
}

/**
 * iPhone のホームのヘッダーに直接置くベル。未読の質問通知の件数（`notificationCount.ts`。
 * 押した先の通知一覧に残っている質問の数）を赤い数字で重ね、押すと通知一覧を開く
 * （`…` メニューにあった「通知」と同じ行き先・同じ数）。要対応のエージェント数は重ねない
 * （押した先に同じ数の項目が無く、食い違って見えるため。要対応はタブのバッジとホームの見出しが示す）。
 *
 * iPad の {@link NotificationsButton} と違い件数を出すのは、iPhone ではベルが `…` から
 * 独立して1つだけ置かれ、数字を読める大きさを取れるため。
 */
export function HomeBellButton({ count, onPress }: { count: number; onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.homeBell, pressed && styles.bellBtnPressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={count > 0 ? `通知。未読の質問 ${count}件` : '通知'}
		>
			<Ionicons name="notifications-outline" size={19} color={colors.text} />
			{count > 0 ? (
				<View style={styles.countBadge} pointerEvents="none">
					<Text style={styles.countText}>{count > 99 ? '99+' : String(count)}</Text>
				</View>
			) : null}
		</Pressable>
	);
}

/** 件数バッジの高さ。数字1桁のときは丸になる。 */
const COUNT_BADGE = 16;

const styles = StyleSheet.create({
	// ヘッダーの `…`（44pt）と同じ大きさ。器（ガラス）はバーが持つので、ここでは重ねない。
	homeBell: { width: HIT_SIZE, height: HIT_SIZE, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	// 白抜きの件数は暗い赤の面に載せる（タブのバッジと同じ規範）。
	countBadge: {
		position: 'absolute', top: 5, right: 4, minWidth: COUNT_BADGE, height: COUNT_BADGE, paddingHorizontal: 4,
		borderRadius: radius.pill, ...squircle, alignItems: 'center', justifyContent: 'center',
		backgroundColor: colors.redStrong,
	},
	countText: { color: colors.text, fontSize: type.badge, fontWeight: '700' },
	bellBtn: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	bellBtnPressed: { backgroundColor: colors.borderStrong },
	// 件数は出さない。同じ数はタブバーのバッジが持っており、ガラスのピルの中に小さな数字を
	// もう1つ置いても読めないうえ、母数の違う数字が並んで見える。
	// 縁はベルのアイコンから点を切り離すためのもの。無いと線と点が繋がって欠けて見える。
	// 縁の色はガラスのピルの見かけの地色に合わせる（surfaceが最も近い）。
	bellBadge: {
		position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: radius.pill, ...squircle,
		backgroundColor: colors.red, borderWidth: 1.5, borderColor: colors.surface,
	},
});
