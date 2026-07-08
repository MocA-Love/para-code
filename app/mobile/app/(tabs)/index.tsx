// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRouter } from 'expo-router';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import type { NotifyPayload } from '@para/protocol';
import { PairingRequiredNotice } from '../../src/components/connectionGate.js';
import { NotificationsButton } from '../../src/components/notificationsSheet.js';
import { ScreenTitle } from '../../src/components/screenTitle.js';
import { AttentionCard } from '../../src/components/attentionCard.js';
import { useAgentActions, useAgentChatSubscription } from '../../src/hooks/useAgentActions.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { colors } from '../../src/theme.js';

/**
 * ホーム画面（モックアップ mock-2.html 準拠）。接続中PCの状態カードと、全ワークスペースの
 * グループ表示。応答待ちのエージェントがいる場合は最上部のアテンションカードで
 * その場で回答できる（ターミナル画面への遷移なしで完結する）。
 */
export default function HomeScreen() {
	const router = useRouter();
	const { connection, pcOnline, workspace, paired, ready, notifications, setSelectedWs, setSelectedTerminalId, manualOffline, disconnectRelay, connectRelay, unpair } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, workspace: s.workspace, paired: s.paired, ready: s.ready,
		notifications: s.notifications, setSelectedWs: s.setSelectedWs, setSelectedTerminalId: s.setSelectedTerminalId,
		manualOffline: s.manualOffline, disconnectRelay: s.disconnectRelay, connectRelay: s.connectRelay, unpair: s.unpair,
	})));

	const tabBarSpacer = useTabBarSpacer();
	// 応答待ちのターミナル（複数あれば先頭の1件をアテンションカードで扱う）
	const waitingTerminal = (workspace?.terminals ?? []).find(t => isAgentWaiting(t.agentStatus));
	const waitingWs = waitingTerminal ? (workspace?.workspaces ?? []).find(w => w.id === waitingTerminal.ws) : undefined;
	const waitingChat = useAgentChatSubscription(waitingTerminal?.id);
	const waitingActions = useAgentActions(waitingTerminal?.id, waitingChat?.agent);

	const confirmUnpair = () => {
		Alert.alert(
			'ペアリング解除',
			'このPCとのペアリング情報を削除します。再接続にはPC側でQRコードを再発行してのペアリングが必要です。',
			[
				{ text: 'キャンセル', style: 'cancel' },
				{ text: '解除する', style: 'destructive', onPress: () => { void unpair(); } },
			],
		);
	};

	if (ready && !paired) {
		return <PairingRequiredNotice onStart={() => router.push('/pair')} />;
	}

	const online = connection === 'online' && pcOnline;
	const openWorkspace = (wsId: string) => {
		setSelectedWs(wsId);
		router.push('/terminal');
	};
	/** エージェントタブへ遷移する。setSelectedWsがselectedTerminalIdをリセットするため、この順序を厳守する。 */
	const openAgent = (wsId: string, terminalId: number) => {
		setSelectedWs(wsId);
		setSelectedTerminalId(terminalId);
		router.push('/agent');
	};
	const openNotification = (n: NotifyPayload) => {
		if (n.ws !== undefined) {
			setSelectedWs(n.ws);
		}
		if (n.terminalId !== undefined) {
			setSelectedTerminalId(n.terminalId);
		}
		router.push('/agent');
	};
	return (
		<View style={styles.screen}>
		<ScreenTitle
			title="ホーム"
			subtitle="Para Code Mobile"
			right={
				<NotificationsButton
					notifications={notifications}
					onOpenNotification={openNotification}
				/>
			}
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

			<View style={styles.card}>
				<View style={styles.cardHeader}>
					<Text style={styles.cardLabel}>接続中のPC</Text>
					<View style={styles.cardHeaderBtns}>
						{connection === 'online' ? (
							<Pressable style={styles.connToggle} onPress={disconnectRelay} accessibilityLabel="切断">
								<Ionicons name="power-outline" size={12} color={colors.red} />
								<Text style={styles.connToggleTextOff}>切断</Text>
							</Pressable>
						) : (
							<Pressable style={styles.connToggle} onPress={connectRelay} accessibilityLabel="接続">
								<Ionicons name="power-outline" size={12} color={colors.green} />
								<Text style={styles.connToggleTextOn}>接続</Text>
							</Pressable>
						)}
						<Pressable style={styles.connToggle} onPress={confirmUnpair} accessibilityLabel="ペアリング解除">
							<Ionicons name="trash-outline" size={12} color={colors.textDim} />
							<Text style={styles.connToggleTextDim}>解除</Text>
						</Pressable>
					</View>
				</View>
				<View style={styles.pcRow}>
					<Image source={require('../../assets/pairing-logo.png')} style={styles.pcIcon} resizeMode="contain" />
					<View style={{ flex: 1 }}>
						<Text style={styles.pcName}>Para Code</Text>
						<Text style={[styles.pcState, !online && styles.pcStateOff]}>
							{online ? '● 接続中' : (connection === 'online' || connection === 'handshaking') && !pcOnline ? '○ PCオフライン' : manualOffline ? '○ 切断中' : '接続中…'}
						</Text>
					</View>
				</View>
				<View style={styles.statsRow}>
					<View style={styles.stat}>
						<Text style={styles.statValue}>{workspace?.workspaces.length ?? 0}</Text>
						<Text style={styles.statLabel}>ワークスペース</Text>
					</View>
					<View style={styles.stat}>
						<Text style={styles.statValue}>{workspace?.terminals.length ?? 0}</Text>
						<Text style={styles.statLabel}>ターミナル</Text>
					</View>
					<View style={styles.stat}>
						<Text style={styles.statValue}>{(workspace?.terminals ?? []).filter(t => isAgentWaiting(t.agentStatus)).length}</Text>
						<Text style={styles.statLabel}>応答待ち</Text>
					</View>
				</View>
			</View>

			<Text style={styles.sectionTitle}>ワークスペース</Text>
			{(workspace?.workspaces ?? []).map(ws => {
				const terminals = (workspace?.terminals ?? []).filter(t => t.ws === ws.id || !t.ws);
				return (
					<View key={ws.id} style={styles.wsCard}>
						<Pressable style={styles.wsHeader} onPress={() => openWorkspace(ws.id)}>
							<Text style={styles.wsName} numberOfLines={1}>{ws.name}</Text>
							{ws.branch ? <View style={styles.wsBranchRow}><Ionicons name="git-branch-outline" size={11} color={colors.accent} /><Text style={styles.wsBranch} numberOfLines={1}>{ws.branch}</Text></View> : null}
							<Ionicons name="chevron-forward" size={14} color={colors.textDim} />
						</Pressable>
						{terminals.map(t => {
							const waiting = isAgentWaiting(t.agentStatus);
							return (
								<View key={t.id} style={[styles.termCard, waiting && styles.termCardWaiting]}>
									<View style={styles.termRow}>
										<Text style={styles.termTitle} numberOfLines={1}>{t.title}</Text>
										{t.agentStatus ? (
											<Text style={[styles.badge, waiting ? styles.badgeWaiting : t.agentStatus === 'working' ? styles.badgeRunning : styles.badgeReview]}>
												{agentLabel(t.agentStatus)}
											</Text>
										) : <Text style={[styles.badge, styles.badgeIdle]}>アイドル</Text>}
									</View>
								</View>
							);
						})}
						{terminals.length === 0 ? <Text style={styles.dimSmall}>ターミナルなし</Text> : null}
					</View>
				);
			})}
			{(workspace?.workspaces.length ?? 0) === 0 ? (
				<Text style={styles.dimSmall}>ワークスペース情報を取得中… PCの Para Code でリポジトリを登録すると表示されます。</Text>
			) : null}

		</ScrollView>
		</View>
	);
}

function agentLabel(status: string): string {
	return status === 'permission' ? '応答待ち' : status === 'question' ? '質問あり' : status === 'working' ? '実行中' : 'レビュー';
}



const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1 },
	content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 32 },
	dimSmall: { color: colors.textDim, fontSize: 12, marginTop: 4 },
	card: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border },
	cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
	cardLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
	connToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: colors.surface2 },
	connToggleTextOff: { color: colors.red, fontSize: 11, fontWeight: '600' },
	connToggleTextOn: { color: colors.green, fontSize: 11, fontWeight: '600' },
	connToggleTextDim: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
	cardHeaderBtns: { flexDirection: 'row', gap: 6 },
	pcRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
	pcIcon: { width: 40, height: 40 },
	pcName: { color: '#fff', fontSize: 15, fontWeight: '600' },
	pcState: { color: colors.green, fontSize: 12, marginTop: 2 },
	pcStateOff: { color: colors.textDim },
	statsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
	stat: { flex: 1, backgroundColor: colors.surface2, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
	statValue: { color: colors.accent, fontSize: 17, fontWeight: '700' },
	statLabel: { color: colors.textDim, fontSize: 10, marginTop: 2 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginTop: 18, marginBottom: 8, letterSpacing: 0.5 },
	wsCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
	wsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
	wsName: { color: '#fff', fontSize: 15, fontWeight: '600', flexShrink: 1 },
	wsBranchRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 0 },
	wsBranch: { color: colors.accent, fontSize: 11, fontFamily: 'Menlo', flexShrink: 1 },
	termCard: { backgroundColor: colors.surface2, borderRadius: 10, padding: 10, marginBottom: 6 },
	termCardWaiting: { borderLeftWidth: 3, borderLeftColor: colors.red },
	termRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	termTitle: { color: colors.text, fontSize: 13, flex: 1 },
	badge: { fontSize: 10, fontWeight: '700', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	badgeWaiting: { backgroundColor: 'rgba(244,135,113,0.15)', color: colors.red },
	badgeRunning: { backgroundColor: 'rgba(78,201,176,0.15)', color: colors.green },
	badgeReview: { backgroundColor: 'rgba(220,220,170,0.15)', color: colors.yellow },
	badgeIdle: { backgroundColor: 'rgba(139,139,139,0.15)', color: colors.textDim },
});
