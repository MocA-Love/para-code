// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { colors } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import { useStableInsets } from '../hooks/useStableInsets.js';

export function ConnectionStatusBanner() {
	const insets = useStableInsets();
	const { connection, pcOnline, sessionProtocolReady, manualOffline, workspace, issue, unknownCount, connectRelay, discardUnknown } = useAppStore(useShallow(s => ({
		connection: s.connection,
		pcOnline: s.pcOnline,
		sessionProtocolReady: s.sessionProtocolReady,
		manualOffline: s.manualOffline,
		workspace: s.workspace,
		issue: s.terminalOperationIssue,
		unknownCount: s.unknownTerminalOperationCount,
		connectRelay: s.connectRelay,
		discardUnknown: s.discardUnknownTerminalOperations,
	})));
	const live = connection === 'online' && pcOnline && sessionProtocolReady;
	const pendingRendererCount = workspace?.renderers.filter(renderer => !renderer.ready).length ?? 0;
	const partialRecovery = live && pendingRendererCount > 0;
	if (live && !partialRecovery && issue === undefined) {
		return null;
	}
	const message = partialRecovery
		? `${pendingRendererCount}個のPC画面を再接続中 — 復旧済みの画面は操作できます`
		: manualOffline
		? '切断中 — 最後の画面を表示しています'
		: !pcOnline && (connection === 'online' || connection === 'handshaking')
			? 'PCオフライン — 最後の画面を表示しています'
			: '再接続中 — 最後の画面を表示しています';
	return <View style={[styles.stack, { top: insets.top + 52 }]} pointerEvents="box-none">
		{!live || partialRecovery ? <View style={styles.connection} accessibilityLiveRegion="polite">
			<Ionicons name={partialRecovery ? 'sync-outline' : 'cloud-offline-outline'} size={15} color={colors.orange} />
			<Text style={styles.text} numberOfLines={2}>{message}</Text>
			{!live ? <Pressable accessibilityRole="button" style={styles.action} onPress={() => { hapticImpact('light'); connectRelay(); }}><Text style={styles.actionText}>再接続</Text></Pressable> : null}
		</View> : null}
		{issue !== undefined ? <View style={styles.unknown} accessibilityLiveRegion="polite">
			<Ionicons name="warning-outline" size={15} color={colors.orange} />
			<Text style={styles.text}>{issue}</Text>
			{unknownCount > 0 ? <Pressable accessibilityRole="button" style={styles.action} onPress={() => Alert.alert(
				'結果不明の操作記録を破棄',
				'PC側の状態を確認しましたか？ 記録を破棄してもPC上の操作は取り消されず、自動再実行もされません。',
				[{ text: 'キャンセル', style: 'cancel' }, { text: '記録を破棄', style: 'destructive', onPress: () => { void discardUnknown(); } }],
			)}><Text style={styles.actionText}>確認して破棄</Text></Pressable> : null}
		</View> : null}
	</View>;
}

const styles = StyleSheet.create({
	stack: { position: 'absolute', left: 12, right: 12, gap: 6, zIndex: 100 },
	connection: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(245,158,11,.35)', backgroundColor: 'rgba(24,24,27,.94)', paddingHorizontal: 10, paddingVertical: 8 },
	unknown: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(245,158,11,.35)', backgroundColor: 'rgba(24,24,27,.96)', paddingHorizontal: 10, paddingVertical: 8 },
	text: { flex: 1, color: colors.text, fontSize: 11, lineHeight: 15 },
	action: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7, backgroundColor: colors.surface },
	actionText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
});
