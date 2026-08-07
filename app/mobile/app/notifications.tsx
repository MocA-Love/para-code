// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import type { NotifyKind, NotifyPayload } from '@para/protocol';
import { useAppStore } from '../src/appState.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { HeaderEdgeFade } from '../src/components/headerEdgeFade.js';
import { HeaderActionButton, HeaderActionPill } from '../src/components/screenHeader.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { CONTENT_MAX_WIDTH } from '../src/ipad/ipadLayout.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import { colors, radius, squircle } from '../src/theme.js';
import { formatRelativeTime, useNow } from '../src/time.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';
import { notificationNavigationDecision } from '../src/notificationNavigation.js';

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
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	// 相対時刻表示を画面を開いたままでも追従させる
	const now = useNow();
	const { workspace, notifications, setSelectedWs, setSelectedTerminalKey, clearNotifications, dismissNotification } = useAppStore(useShallow(s => ({
		workspace: s.workspace,
		notifications: s.notifications, setSelectedWs: s.setSelectedWs, setSelectedTerminalKey: s.setSelectedTerminalKey,
		clearNotifications: s.clearNotifications, dismissNotification: s.dismissNotification,
	})));

	const openNotification = (n: NotifyPayload) => {
		hapticSelection();
		if (notificationNavigationDecision(workspace, n.terminalKey) !== 'open' || n.terminalKey === undefined) {
			return;
		}
		// exact targetの検証成功後だけ既読にする。partial stateで有効な通知を消さない。
		dismissNotification(n.id);
		// setSelectedWs は selectedTerminalKey をリセットするため、この順序を厳守する。
		if (n.ws !== undefined) {
			setSelectedWs(n.ws);
		}
		setSelectedTerminalKey(n.terminalKey);
		// この画面をスタックから畳みつつエージェントタブへ（戻る操作で通知一覧に戻らないように）。
		// back()→push()の同期連発はズーム逆アニメと競合しうるため、dismissToで1操作にする。
		router.dismissTo('/agent');
	};

	/** 全消去は取り返しがつかない（PC側の一覧からも消える）ので一度だけ聞く。 */
	const confirmClear = () => {
		hapticImpact('light');
		Alert.alert('通知をすべて消す', `${notifications.length}件の通知を消します。この操作は取り消せません。`, [
			{ text: 'キャンセル', style: 'cancel' },
			{ text: 'すべて消す', style: 'destructive', onPress: () => clearNotifications() },
		]);
	};

	return (
		<View style={styles.screen}>
			<ScrollView
				style={styles.list}
				contentContainerStyle={[styles.listContent, { paddingTop: headerHeight, paddingBottom: insets.bottom + 24 }, column]}
			>
				{notifications.length === 0 ? (
					<Text style={styles.empty}>通知はありません</Text>
				) : notifications.map(n => {
					const openable = notificationNavigationDecision(workspace, n.terminalKey) === 'open';
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
			{/* ヘッダーは島＋ガラスのボタン群。破壊的な「すべて消す」は閉じるから遠い左側に置く。
			    指が右上へ伸びる流れの途中に置くと、閉じるつもりで消してしまう。
			    ここに「すべて既読」は置かない。この一覧に既読という状態は無く、押せば消えるので
			    「すべて消す」と同じものが2つ並ぶだけになる。 */}
			<View style={[styles.headerWrap, { paddingTop: insets.top }]} pointerEvents="box-none" onLayout={e => setHeaderHeight(e.nativeEvent.layout.height)}>
				<HeaderEdgeFade id="paraNotificationsFade" />
				<View style={styles.headerRow} pointerEvents="box-none">
					<GlassSurface style={styles.island}>
						<View style={styles.islandBody}>
							<Text style={styles.islandTitle}>通知</Text>
							{/* この一覧に残っている＝まだ読んでいない、なので件数は「未読」として出す。 */}
							<Text style={styles.islandSub}>未読 {notifications.length}</Text>
						</View>
					</GlassSurface>
					<View style={styles.headerSpacer} pointerEvents="none" />
					<HeaderActionPill>
						{notifications.length > 0 ? (
							<HeaderActionButton icon="trash-outline" label="通知をすべて消す" color={colors.red} onPress={confirmClear} />
						) : null}
						<HeaderActionButton icon="close" label="閉じる" size={18} onPress={() => { hapticSelection(); router.back(); }} />
					</HeaderActionPill>
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	headerWrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, paddingBottom: 12 },
	headerRow: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 16, paddingRight: 12, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
	headerSpacer: { flex: 1, minWidth: 0 },
	island: { height: 44, borderRadius: radius.pill, ...squircle },
	islandBody: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
	islandTitle: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
	islandSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
	list: { flex: 1, paddingHorizontal: 14 },
	listContent: { paddingBottom: 32 },
	empty: { color: colors.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 32 },
	// 行はホームのエージェント行と同じ札にする。同じ「押すと開く1件」なのに、片方だけ
	// 面を持たないと別の種類のものに見える。
	row: {
		flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12,
		backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
		borderRadius: radius.card, ...squircle, marginBottom: 4,
	},
	rowPressed: { backgroundColor: colors.surface2 },
	dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
	body: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
	rowBody: { color: colors.textDim, fontSize: 11.5, marginTop: 1, lineHeight: 15 },
	time: { color: colors.textDim, fontSize: 10.5, flexShrink: 0 },
});
