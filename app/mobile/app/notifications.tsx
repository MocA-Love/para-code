// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import type { NotifyKind, NotifyPayload } from '@para/protocol';
import { useAppStore } from '../src/appState.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { colors } from '../src/theme.js';
import { formatRelativeTime, useNow } from '../src/time.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';

function dotColor(kind: NotifyKind): string {
	switch (kind) {
		case 'agent-question': return colors.red;
		case 'agent-done': return colors.green;
		case 'agent-error': return colors.red;
		case 'disconnected': return colors.yellow;
		default: return colors.textDim;
	}
}

/**
 * 通知一覧画面。ヘッダーのベル（Link.AppleZoom）からズーム遷移で開く独立ルート
 * （旧notificationsSheet.tsxの自作ボトムシートを置き換え）。ズーム遷移は
 * ヘッダー付き画面と相性が悪いため独自ヘッダーを描画する。
 */
export default function NotificationsScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	// 相対時刻表示を画面を開いたままでも追従させる
	const now = useNow();
	const { notifications, setSelectedWs, setSelectedTerminalId, clearNotifications, dismissNotification } = useAppStore(useShallow(s => ({
		notifications: s.notifications, setSelectedWs: s.setSelectedWs, setSelectedTerminalId: s.setSelectedTerminalId,
		clearNotifications: s.clearNotifications, dismissNotification: s.dismissNotification,
	})));

	const openNotification = (n: NotifyPayload) => {
		hapticSelection();
		// 開いた通知は一覧から消す（既読/削除扱い）。他のペアリング済み端末にも同期される。
		dismissNotification(n.id);
		// setSelectedWs は selectedTerminalId をリセットするため、この順序を厳守する。
		if (n.ws !== undefined) {
			setSelectedWs(n.ws);
		}
		if (n.terminalId !== undefined) {
			setSelectedTerminalId(n.terminalId);
		}
		// この画面をスタックから畳みつつエージェントタブへ（戻る操作で通知一覧に戻らないように）。
		// back()→push()の同期連発はズーム逆アニメと競合しうるため、dismissToで1操作にする。
		router.dismissTo('/agent');
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				<Text style={styles.title}>通知</Text>
				{notifications.length > 0 ? (
					<Pressable style={styles.clearBtn} onPress={() => { hapticImpact('light'); clearNotifications(); }} accessibilityLabel="通知をすべてクリア">
						<Text style={styles.clearBtnText}>クリア</Text>
					</Pressable>
				) : null}
				<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="閉じる">
					<Ionicons name="close" size={16} color={colors.textDim} />
				</Pressable>
			</View>
			<ScrollView style={styles.list} contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}>
				{notifications.length === 0 ? (
					<Text style={styles.empty}>通知はありません</Text>
				) : notifications.map(n => {
					const openable = n.ws !== undefined || n.terminalId !== undefined;
					return (
						<Pressable
							key={n.id}
							style={({ pressed }) => [styles.row, pressed && openable && styles.rowPressed]}
							disabled={!openable}
							onPress={() => openNotification(n)}
						>
							<View style={[styles.dot, { backgroundColor: dotColor(n.kind) }]} />
							<View style={styles.body}>
								<Text style={styles.rowTitle} numberOfLines={1}>{n.title}</Text>
								<Text style={styles.rowBody} numberOfLines={2}>{n.body}</Text>
							</View>
							<Text style={styles.time}>{formatRelativeTime(n.at, now)}</Text>
							{openable ? <Ionicons name="chevron-forward" size={13} color={colors.textDim} /> : null}
						</Pressable>
					);
				})}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 10 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
	clearBtn: { height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
	clearBtnText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	list: { flex: 1, paddingHorizontal: 14 },
	listContent: { paddingBottom: 32 },
	empty: { color: colors.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 32 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, marginBottom: 4 },
	rowPressed: { backgroundColor: colors.surface2 },
	dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
	body: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
	rowBody: { color: colors.textDim, fontSize: 11.5, marginTop: 1, lineHeight: 15 },
	time: { color: colors.textDim, fontSize: 10.5, flexShrink: 0 },
});
