// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import type { NotifyKind, NotifyPayload } from '@para/protocol';
import { useAppStore } from '../src/appState.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useParaHeader, useParaHeaderHeight, type ParaHeaderSpec } from '../src/paraHeader.js';
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
	const headerHeight = useParaHeaderHeight();
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
	// **参照を安定させる。** 素の関数のままだと下の headerSpec の useMemo が毎レンダー切れて、
	// 層への spec 登録（useEffect）が再送のたびに走る。clearNotifications は store の
	// メソッドで安定、notifications.length はプリミティブ。
	const confirmClear = useCallback(() => {
		hapticImpact('light');
		Alert.alert('通知をすべて消す', `${notifications.length}件の通知を消します。この操作は取り消せません。`, [
			{ text: 'キャンセル', style: 'cancel' },
			{ text: 'すべて消す', style: 'destructive', onPress: () => clearNotifications() },
		]);
	}, [notifications.length, clearNotifications]);

	// ヘッダーは常設のヘッダー層が描く。**この画面はズーム遷移（Link.AppleZoom）で開く**ので
	// `instant` にしてモーフさせない——画面全体が拡大しているのに中のヘッダーだけ別の速度で
	// 動くと二重に見える。連続性はズームに任せる。
	// 破壊的な「すべて消す」は閉じるから遠い左側（ピルの中）に置く。指が右上へ伸びる流れの
	// 途中に置くと、閉じるつもりで消してしまう。ここに「すべて既読」は置かない（この一覧に
	// 既読という状態は無く、押せば消えるので「すべて消す」と同じものが2つ並ぶだけになる）。
	const headerSpec = useMemo<ParaHeaderSpec>(() => ({
		instant: true,
		left: {
			kind: 'island', label: `通知、未読 ${notifications.length}`,
			avatarIcon: 'notifications-outline', color: colors.accent,
			name: '通知', sub: `未読 ${notifications.length}`, maxWidth: 170,
		},
		rightA: {
			kind: 'icons',
			items: [
				...(notifications.length > 0
					? [{ key: 'clear', icon: 'trash-outline' as const, label: '通知をすべて消す', color: colors.red, onPress: confirmClear }]
					: []),
				{ key: 'close', icon: 'close' as const, label: '閉じる', size: 18, onPress: () => { hapticSelection(); router.back(); } },
			],
		},
	}), [notifications.length, confirmClear, router]);
	useParaHeader(headerSpec);

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
								<View style={styles.titleRow}>
									<Text style={styles.rowTitle} numberOfLines={1}>{n.title}</Text>
									{n.subtitle !== undefined ? <Text style={styles.rowSubtitle} numberOfLines={1}>{n.subtitle}</Text> : null}
								</View>
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
	// ワークツリー名（太字）とエージェント名を同じ行に置く。入りきらないときは
	// エージェント名から先に削る（どこで待たれているかの方が要る）。
	titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, minWidth: 0 },
	// 縮む割合を副題側へ大きく寄せる。両方を同じにすると、flexboxは長い方（＝ワークツリー名）から
	// 削るため、見せたい名前の方が先に消える。
	rowTitle: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
	rowSubtitle: { color: colors.textDim, fontSize: 11, flexShrink: 8 },
	rowBody: { color: colors.textDim, fontSize: 11.5, marginTop: 1, lineHeight: 15 },
	time: { color: colors.textDim, fontSize: 10.5, flexShrink: 0 },
});
