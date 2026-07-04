// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Link, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAppStore } from '../src/appState.js';

/** ホーム画面: 接続状態・ワークスペース・ターミナル一覧（mobile.html のホーム相当）。 */
export default function HomeScreen() {
	const router = useRouter();
	const { connection, pcOnline, workspace, paired, ready, notifications } = useAppStore(s => ({
		connection: s.connection, pcOnline: s.pcOnline, workspace: s.workspace, paired: s.paired, ready: s.ready, notifications: s.notifications,
	}));

	if (ready && !paired) {
		return (
			<View style={styles.center}>
				<Text style={styles.title}>PC とペアリング</Text>
				<Text style={styles.dim}>PC の Para Code で「モバイルデバイスを接続」を実行し、QR を読み取ってください。</Text>
				<Link href="/pair" asChild>
					<Pressable style={styles.primaryBtn}><Text style={styles.primaryBtnText}>QR を読み取る</Text></Pressable>
				</Link>
			</View>
		);
	}

	const online = connection === 'online' && pcOnline;
	return (
		<ScrollView style={styles.screen} contentContainerStyle={styles.content}>
			<View style={styles.card}>
				<Text style={styles.cardTitle}>接続中の PC</Text>
				<Text style={styles.connState}>{online ? '● オンライン' : connection === 'online' ? '○ PC オフライン' : '接続中…'}</Text>
			</View>

			<Text style={styles.sectionTitle}>ワークスペース</Text>
			{(workspace?.workspaces ?? []).map(ws => {
				const terminals = (workspace?.terminals ?? []).filter(t => t.ws === ws.id || !t.ws);
				return (
					<View key={ws.id} style={styles.wsCard}>
						<Text style={styles.wsName}>{ws.name}</Text>
						{terminals.map(t => (
							<Pressable key={t.id} style={styles.termRow} onPress={() => router.push({ pathname: '/terminal', params: { id: String(t.id), title: t.title } })}>
								<Text style={styles.termTitle}>{t.title}</Text>
								{t.agentStatus ? <Text style={[styles.badge, t.agentStatus === 'permission' ? styles.badgeWaiting : styles.badgeRunning]}>{agentLabel(t.agentStatus)}</Text> : null}
							</Pressable>
						))}
						{terminals.length === 0 ? <Text style={styles.dim}>ターミナルなし</Text> : null}
					</View>
				);
			})}
			{(workspace?.workspaces.length ?? 0) === 0 ? <Text style={styles.dim}>ワークスペース情報を取得中…</Text> : null}

			{notifications.length > 0 ? (
				<>
					<Text style={styles.sectionTitle}>最近の通知</Text>
					<View style={styles.wsCard}>
						{notifications.slice(0, 8).map(n => (
							<Pressable
								key={n.id}
								style={styles.notifRow}
								onPress={() => { if (n.terminalId !== undefined) { router.push({ pathname: '/terminal', params: { id: String(n.terminalId), title: n.title } }); } }}
							>
								<View style={[styles.notifDot, n.kind === 'agent-question' ? styles.dotWaiting : n.kind === 'agent-error' ? styles.dotError : styles.dotDone]} />
								<View style={{ flex: 1 }}>
									<Text style={styles.notifTitle} numberOfLines={1}>{n.title}</Text>
									<Text style={styles.notifBody} numberOfLines={1}>{n.body}</Text>
								</View>
							</Pressable>
						))}
					</View>
				</>
			) : null}
		</ScrollView>
	);
}

function agentLabel(status: string): string {
	return status === 'permission' ? '応答待ち' : status === 'working' ? '実行中' : 'レビュー';
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#0d1117' },
	content: { padding: 16 },
	center: { flex: 1, backgroundColor: '#0d1117', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
	title: { color: '#fff', fontSize: 22, fontWeight: '700' },
	dim: { color: '#8b8b8b', fontSize: 13, textAlign: 'center', lineHeight: 20 },
	sectionTitle: { color: '#8b8b8b', fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginTop: 16, marginBottom: 8, letterSpacing: 0.5 },
	card: { backgroundColor: '#252526', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#3c3c3c' },
	cardTitle: { color: '#8b8b8b', fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 },
	connState: { color: '#4ec9b0', fontSize: 15, fontWeight: '600' },
	wsCard: { backgroundColor: '#252526', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#3c3c3c', marginBottom: 12 },
	wsName: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 8 },
	termRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 8 },
	termTitle: { color: '#cccccc', fontSize: 14, flex: 1 },
	badge: { fontSize: 10, fontWeight: '700', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
	badgeWaiting: { backgroundColor: 'rgba(244,135,113,0.15)', color: '#f48771' },
	badgeRunning: { backgroundColor: 'rgba(78,201,176,0.15)', color: '#4ec9b0' },
	primaryBtn: { backgroundColor: '#007acc', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
	primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
	notifRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
	notifDot: { width: 8, height: 8, borderRadius: 4 },
	dotWaiting: { backgroundColor: '#f48771' },
	dotDone: { backgroundColor: '#4ec9b0' },
	dotError: { backgroundColor: '#f14c4c' },
	notifTitle: { color: '#cccccc', fontSize: 13, fontWeight: '600' },
	notifBody: { color: '#8b8b8b', fontSize: 12, marginTop: 1 },
});
