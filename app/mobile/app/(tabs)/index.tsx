// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { useIsFocused, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { PairingRequiredNotice } from '../../src/components/connectionGate.js';
import { NotificationsButton } from '../../src/components/notificationsSheet.js';
import { WsHeader, useWsDrawer, wsColor } from '../../src/components/wsDrawer.js';
import { AttentionCard } from '../../src/components/attentionCard.js';
import { useAgentActions, useAgentChatSubscription } from '../../src/hooks/useAgentActions.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { colors } from '../../src/theme.js';

/**
 * ホーム画面（mock.html 案A準拠のリデザイン）。旧デザインの「接続中のPC」カードと
 * ワークスペース別グループ表示を廃止し、全ワークスペース横断のエージェント一覧に
 * 再定義した（PCステータス・接続管理はワークスペースドロワーへ移設）。
 * 応答待ちのエージェントがいる場合は最上部のアテンションカードでその場で回答できる。
 */
export default function HomeScreen() {
	const router = useRouter();
	const { workspace, paired, ready, notifications, setSelectedWs, setSelectedTerminalId } = useAppStore(useShallow(s => ({
		workspace: s.workspace, paired: s.paired, ready: s.ready, notifications: s.notifications,
		setSelectedWs: s.setSelectedWs, setSelectedTerminalId: s.setSelectedTerminalId,
	})));

	const tabBarSpacer = useTabBarSpacer();
	// ホームは横スクロール要素を持たないため、フォーカス中は画面全域の右スワイプで
	// ドロワーを開ける（X方式）。他タブへ移ったら左端エッジのみに戻す。
	const { setFullWidthSwipe } = useWsDrawer();
	const isFocused = useIsFocused();
	useEffect(() => {
		setFullWidthSwipe(isFocused);
		return () => setFullWidthSwipe(false);
	}, [isFocused, setFullWidthSwipe]);
	// 応答待ちのターミナル（複数あれば先頭の1件をアテンションカードで扱う）
	const waitingTerminal = (workspace?.terminals ?? []).find(t => isAgentWaiting(t.agentStatus));
	const waitingWs = waitingTerminal ? (workspace?.workspaces ?? []).find(w => w.id === waitingTerminal.ws) : undefined;
	const waitingChat = useAgentChatSubscription(waitingTerminal?.id);
	const waitingActions = useAgentActions(waitingTerminal?.id, waitingChat?.agent);

	if (ready && !paired) {
		return <PairingRequiredNotice onStart={() => router.push('/pair')} />;
	}

	/** エージェントタブへ遷移する。setSelectedWsがselectedTerminalIdをリセットするため、この順序を厳守する。 */
	const openAgent = (wsId: string, terminalId: number) => {
		setSelectedWs(wsId);
		setSelectedTerminalId(terminalId);
		router.push('/agent');
	};
	// 全ワークスペース横断のエージェント一覧（応答待ち → 実行中 → その他 → アイドルの順）
	const wsById = new Map((workspace?.workspaces ?? []).map(w => [w.id, w]));
	const rows = [...(workspace?.terminals ?? [])].sort((a, b) => statusOrder(a.agentStatus) - statusOrder(b.agentStatus));

	return (
		<View style={styles.screen}>
			<WsHeader
				title="ホーム"
				subtitle="Para Code Mobile"
				right={<NotificationsButton notifications={notifications} />}
			/>
			<ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: tabBarSpacer }]}>
				{waitingTerminal && waitingWs && (waitingTerminal.agentStatus === 'permission' || waitingTerminal.agentStatus === 'question') ? (
					<AttentionCard
						wsName={waitingWs.name}
						terminalTitle={waitingTerminal.title}
						agentStatus={waitingTerminal.agentStatus}
						chat={waitingChat}
						actions={waitingActions}
						onOpenAgent={() => openAgent(waitingWs.id, waitingTerminal.id)}
					/>
				) : null}

				<Text style={styles.sectionTitle}>エージェント — 全ワークスペース</Text>
				{rows.map(t => {
					// ws未タグのターミナルはPC側アクティブワークスペース所属として表示する
					// （activeWsも未定義なら先頭ワークスペースへフォールバックし、行が無反応になるのを防ぐ）
					const ws = (t.ws !== undefined ? wsById.get(t.ws) : undefined)
						?? (workspace?.activeWs !== undefined ? wsById.get(workspace.activeWs) : undefined)
						?? workspace?.workspaces[0];
					const waiting = isAgentWaiting(t.agentStatus);
					const color = ws ? wsColor(ws) : colors.accent;
					return (
						<Pressable
							key={t.id}
							style={[styles.agentRow, waiting && styles.agentRowWaiting]}
							onPress={() => { if (ws) { openAgent(ws.id, t.id); } }}
						>
							<View style={[styles.orb, orbStyle(t.agentStatus)]} />
							<View style={styles.agentBody}>
								<Text style={styles.agentTitle} numberOfLines={1}>{t.title}</Text>
								<View style={styles.agentSub}>
									<Text style={[styles.agentWs, { color }]} numberOfLines={1}>{ws?.name ?? '—'}</Text>
									{ws?.branch ? <Text style={styles.agentBranch} numberOfLines={1}> · {ws.branch}</Text> : null}
								</View>
							</View>
							<Text style={[styles.badge, badgeStyle(t.agentStatus)]}>{agentLabel(t.agentStatus)}</Text>
						</Pressable>
					);
				})}
				{rows.length === 0 ? (
					<Text style={styles.dimSmall}>
						エージェントはまだありません。ターミナルタブでターミナルを作成し、claude / codex を起動すると表示されます。
					</Text>
				) : null}
				{(workspace?.workspaces.length ?? 0) === 0 ? (
					<Text style={styles.dimSmall}>ワークスペース情報を取得中… PCの Para Code でリポジトリを登録すると表示されます。</Text>
				) : null}
			</ScrollView>
		</View>
	);
}

function statusOrder(status: string | undefined): number {
	return status === 'permission' || status === 'question' ? 0 : status === 'working' ? 1 : status === undefined ? 3 : 2;
}

function agentLabel(status: string | undefined): string {
	return status === 'permission' ? '応答待ち' : status === 'question' ? '質問あり' : status === 'working' ? '実行中' : status === undefined ? 'アイドル' : 'レビュー';
}

function orbStyle(status: string | undefined) {
	return status === 'permission' || status === 'question' ? styles.orbWaiting
		: status === 'working' ? styles.orbRunning
			: status === undefined ? styles.orbIdle : styles.orbReview;
}

function badgeStyle(status: string | undefined) {
	return status === 'permission' || status === 'question' ? styles.badgeWaiting
		: status === 'working' ? styles.badgeRunning
			: status === undefined ? styles.badgeIdle : styles.badgeReview;
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1 },
	content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 32 },
	dimSmall: { color: colors.textDim, fontSize: 12, marginTop: 4, lineHeight: 18 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginTop: 6, marginBottom: 8, letterSpacing: 0.5 },
	agentRow: {
		flexDirection: 'row', alignItems: 'center', gap: 11,
		backgroundColor: colors.surface, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14,
		borderWidth: 1, borderColor: colors.border, marginBottom: 8,
	},
	agentRowWaiting: { borderLeftWidth: 3, borderLeftColor: colors.red },
	orb: { width: 10, height: 10, borderRadius: 6 },
	orbWaiting: { backgroundColor: colors.red },
	orbRunning: { backgroundColor: colors.green },
	orbReview: { backgroundColor: colors.yellow },
	orbIdle: { backgroundColor: '#55555c' },
	agentBody: { flex: 1, minWidth: 0 },
	agentTitle: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	agentSub: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
	agentWs: { fontSize: 11, fontFamily: 'Menlo', flexShrink: 1 },
	agentBranch: { color: colors.textDim, fontSize: 11, flexShrink: 1 },
	badge: { fontSize: 10, fontWeight: '700', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	badgeWaiting: { backgroundColor: 'rgba(244,135,113,0.15)', color: colors.red },
	badgeRunning: { backgroundColor: 'rgba(78,201,176,0.15)', color: colors.green },
	badgeReview: { backgroundColor: 'rgba(220,220,170,0.15)', color: colors.yellow },
	badgeIdle: { backgroundColor: 'rgba(139,139,139,0.15)', color: colors.textDim },
});
