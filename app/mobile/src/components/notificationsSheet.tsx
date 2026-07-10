// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { NotifyPayload } from '@para/protocol';
import { GlassSurface } from './glassSurface.js';
import { colors } from '../theme.js';
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
				<Pressable style={styles.bellBtn} onPress={() => hapticImpact('light')} accessibilityLabel="通知">
					{/* 角丸はガラス面自体に渡す（ネイティブglassが正しい丸形状で描画される）。
					    ボタン自体に overflow: hidden を掛けるとバッジが円周で欠けるので掛けない */}
					<GlassSurface style={styles.bellGlass} interactive />
					<Ionicons name="notifications-outline" size={18} color={colors.text} />
					{questionCount > 0 ? (
						<View style={styles.bellBadge}><Text style={styles.bellBadgeText}>{questionCount}</Text></View>
					) : null}
				</Pressable>
			</Link.AppleZoom>
		</Link>
	);
}

const styles = StyleSheet.create({
	bellBtn: {
		width: 40, height: 40, borderRadius: 20,
		alignItems: 'center', justifyContent: 'center',
	},
	bellGlass: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 20, overflow: 'hidden' },
	bellBadge: {
		position: 'absolute', top: -1, right: -1, minWidth: 15, height: 15, borderRadius: 8,
		backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
	},
	bellBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
});
