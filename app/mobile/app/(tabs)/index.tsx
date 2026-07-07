// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { colors } from '../../src/theme.js';

/**
 * ホーム画面（モックアップ準拠）。接続中PCの状態カードと、全ワークスペースの
 * グループ表示。各ワークスペース内のエージェント動作状況を一覧し、応答待ちには
 * 「回答する」導線を出す。「開く」でそのワークスペースのターミナル画面へ。
 */
export default function HomeScreen() {
	const router = useRouter();
	const { connection, pcOnline, workspace, paired, ready, notifications, setSelectedWs, setSelectedTerminalId, manualOffline, disconnectRelay, connectRelay } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, workspace: s.workspace, paired: s.paired, ready: s.ready,
		notifications: s.notifications, setSelectedWs: s.setSelectedWs, setSelectedTerminalId: s.setSelectedTerminalId,
		manualOffline: s.manualOffline, disconnectRelay: s.disconnectRelay, connectRelay: s.connectRelay,
	})));

	if (ready && !paired) {
		return (
			<View style={styles.center}>
				<View style={styles.appIcon}><Ionicons name="phone-portrait-outline" size={32} color="#fff" /></View>
				<Text style={styles.title}>Para Code と接続</Text>
				<Text style={styles.dim}>PC側のPara Codeで「モバイルデバイスを接続」を実行し、表示されたQRコードを読み取ると、別ネットワークからでも安全に遠隔操作できます。</Text>
				<Pressable style={styles.primaryBtn} onPress={() => router.push('/pair')}>
					<Text style={styles.primaryBtnText}>接続を開始</Text>
				</Pressable>
			</View>
		);
	}

	const online = connection === 'online' && pcOnline;
	const openWorkspace = (wsId: string) => {
		setSelectedWs(wsId);
		router.push('/terminal');
	};
	const answerTerminal = (wsId: string, terminalId: number) => {
		setSelectedWs(wsId);
		setSelectedTerminalId(terminalId);
		router.push('/terminal');
	};
	const latestQuestion = notifications.find(n => n.kind === 'agent-question');

	return (
		<ScrollView style={styles.screen} contentContainerStyle={styles.content}>
			{latestQuestion ? (
				<Pressable
					style={styles.pushBanner}
					onPress={() => { if (latestQuestion.terminalId !== undefined && latestQuestion.ws) { answerTerminal(latestQuestion.ws, latestQuestion.terminalId); } }}
				>
					<View style={styles.pushIcon}><Ionicons name="chatbubble-ellipses-outline" size={17} color="#fff" /></View>
					<View style={{ flex: 1 }}>
						<Text style={styles.pushTitle} numberOfLines={1}>{latestQuestion.title}</Text>
						<Text style={styles.pushMsg} numberOfLines={1}>{latestQuestion.body}</Text>
					</View>
				</Pressable>
			) : null}

			<View style={styles.card}>
				<View style={styles.cardHeader}>
					<Text style={styles.cardLabel}>接続中のPC</Text>
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
				</View>
				<View style={styles.pcRow}>
					<View style={styles.pcIcon}><Ionicons name="laptop-outline" size={20} color="#fff" /></View>
					<View style={{ flex: 1 }}>
						<Text style={styles.pcName}>Para Code</Text>
						<Text style={[styles.pcState, !online && styles.pcStateOff]}>
							{online ? '● 接続中 · リレー経由 (E2E暗号化)' : connection === 'online' ? '○ PCオフライン' : manualOffline ? '○ 切断中' : '接続中…'}
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
						<View style={styles.wsHeader}>
							<Text style={styles.wsName}>{ws.name}</Text>
							{ws.branch ? <View style={styles.wsBranchRow}><Ionicons name="git-branch-outline" size={11} color={colors.accent} /><Text style={styles.wsBranch}>{ws.branch}</Text></View> : null}
							<Pressable onPress={() => openWorkspace(ws.id)}>
								<Text style={styles.openLink}>開く ›</Text>
							</Pressable>
						</View>
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
									{waiting ? (
										<View style={styles.answerRow}>
											<Pressable style={styles.answerBtn} onPress={() => answerTerminal(ws.id, t.id)}>
												<Text style={styles.answerBtnText}>回答する</Text>
											</Pressable>
											<Pressable style={styles.openTermBtn} onPress={() => answerTerminal(ws.id, t.id)}>
												<Text style={styles.openTermBtnText}>ターミナルを開く</Text>
											</Pressable>
										</View>
									) : null}
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
	);
}

function agentLabel(status: string): string {
	return status === 'permission' ? '応答待ち' : status === 'question' ? '質問あり' : status === 'working' ? '実行中' : 'レビュー';
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	content: { padding: 16, paddingBottom: 32 },
	center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
	appIcon: { width: 72, height: 72, borderRadius: 18, backgroundColor: colors.accent2, alignItems: 'center', justifyContent: 'center' },
	title: { color: '#fff', fontSize: 22, fontWeight: '700' },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 20 },
	dimSmall: { color: colors.textDim, fontSize: 12, marginTop: 4 },
	primaryBtn: { backgroundColor: colors.accent2, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 28, marginTop: 8 },
	primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
	pushBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(45,45,48,.97)', borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 10, marginBottom: 14 },
	pushIcon: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.claude },
	pushTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
	pushMsg: { color: colors.textDim, fontSize: 12, marginTop: 1 },
	card: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border },
	cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
	cardLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
	connToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: colors.surface2 },
	connToggleTextOff: { color: colors.red, fontSize: 11, fontWeight: '600' },
	connToggleTextOn: { color: colors.green, fontSize: 11, fontWeight: '600' },
	pcRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
	pcIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.accent2, alignItems: 'center', justifyContent: 'center' },
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
	wsName: { color: '#fff', fontSize: 15, fontWeight: '600' },
	wsBranchRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 },
	wsBranch: { color: colors.accent, fontSize: 11, fontFamily: 'Menlo' },
	openLink: { color: colors.accent, fontSize: 13 },
	termCard: { backgroundColor: colors.surface2, borderRadius: 10, padding: 10, marginBottom: 6 },
	termCardWaiting: { borderLeftWidth: 3, borderLeftColor: colors.red },
	termRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	termTitle: { color: colors.text, fontSize: 13, flex: 1 },
	badge: { fontSize: 10, fontWeight: '700', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	badgeWaiting: { backgroundColor: 'rgba(244,135,113,0.15)', color: colors.red },
	badgeRunning: { backgroundColor: 'rgba(78,201,176,0.15)', color: colors.green },
	badgeReview: { backgroundColor: 'rgba(220,220,170,0.15)', color: colors.yellow },
	badgeIdle: { backgroundColor: 'rgba(139,139,139,0.15)', color: colors.textDim },
	answerRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
	answerBtn: { backgroundColor: colors.accent2, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
	answerBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
	openTermBtn: { backgroundColor: colors.surface, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: colors.border },
	openTermBtnText: { color: colors.text, fontSize: 12 },
});
