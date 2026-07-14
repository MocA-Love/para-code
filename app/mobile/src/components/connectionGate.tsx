// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 接続ガード。PCとの接続が確立するまで、ホーム以外のタブの中身の代わりに
 * 接続状態と再接続導線を表示する（未接続のままターミナル等を操作できてしまう
 * 中途半端な状態を防ぐ）。
 */

import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { colors } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import { useStableInsets } from '../hooks/useStableInsets.js';

/**
 * 未ペアリング時の案内。ConnectionGateと、ホーム画面（独自に接続状態を出す都合上
 * 全体をConnectionGateでラップできない）の両方から使う共通部品。
 */
export function PairingRequiredNotice({ onStart }: { onStart: () => void }) {
	return (
		<View style={styles.center}>
			<Ionicons name="qr-code-outline" size={40} color={colors.textDim} />
			<Text style={styles.title}>ペアリングが必要です</Text>
			<Text style={styles.dim}>PCとペアリングすると、離れた場所からでも遠隔操作できます。</Text>
			<Pressable style={styles.btn} accessibilityRole="button" onPress={() => { hapticImpact('medium'); onStart(); }}>
				<Text style={styles.btnText}>ペアリングを開始</Text>
			</Pressable>
		</View>
	);
}

export function ConnectionGate({ children }: { children: ReactNode }) {
	const router = useRouter();
	const insets = useStableInsets();
	const canGoBack = router.canGoBack();
	const { connection, pcOnline, paired, ready, manualOffline, protocolError, connectRelay } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, paired: s.paired, ready: s.ready,
		manualOffline: s.manualOffline, protocolError: s.protocolError, connectRelay: s.connectRelay,
	})));

	if (connection === 'online' && pcOnline && protocolError === undefined) {
		return <>{children}</>;
	}

	if (protocolError !== undefined) {
		return <View style={styles.gated}><View style={styles.center} accessibilityLiveRegion="polite">
			<Ionicons name="refresh-circle-outline" size={40} color={colors.red} />
			<Text style={styles.title}>アップデートが必要です</Text>
			<Text style={styles.dim}>{protocolError}</Text>
		</View>{canGoBack ? <GateBackButton top={insets.top + 8} onBack={() => router.back()} /> : null}</View>;
	}

	if (ready && !paired) {
		return <View style={styles.gated}><PairingRequiredNotice onStart={() => router.push('/pair')} />{canGoBack ? <GateBackButton top={insets.top + 8} onBack={() => router.back()} /> : null}</View>;
	}

	// PCオフライン（リレーには繋がったがPC側が不在）はハンドシェイク未完了(handshaking)の
	// 段階でもリレーのpresence通知で分かる。PC不在時はE2Eハンドシェイク応答が永遠に来ず
	// タイムアウト→再接続を繰り返すため、「接続しています…」のまま固まって見せず
	// 「PCがオフライン」と的確に伝える。
	const pcOffline = !manualOffline && !pcOnline && (connection === 'online' || connection === 'handshaking');
	const connecting = !manualOffline && !pcOffline && (connection === 'connecting' || connection === 'handshaking');
	const message = manualOffline
		? '接続を切断しています'
		: pcOffline
			? 'PCがオフラインです。PCの Para Code が起動しているか確認してください。'
			: connecting
				? 'PCに接続しています…'
				: 'PCに接続できていません';

	return (
		<View style={styles.gated}><View style={styles.center} accessibilityLiveRegion="polite">
			{connecting ? <ActivityIndicator accessibilityLabel="PCへ接続中" size="large" color={colors.accent} /> : <Ionicons name="cloud-offline-outline" size={40} color={colors.textDim} />}
			<Text style={styles.title}>{connecting ? '接続中' : '未接続'}</Text>
			<Text style={styles.dim}>{message}</Text>
			{!connecting ? (
				<Pressable style={styles.btn} accessibilityRole="button" onPress={() => { hapticImpact('light'); connectRelay(); }}>
					<Text style={styles.btnText}>{manualOffline ? '接続する' : '再接続'}</Text>
				</Pressable>
			) : null}
		</View>{canGoBack ? <GateBackButton top={insets.top + 8} onBack={() => router.back()} /> : null}</View>
	);
}

function GateBackButton({ onBack, top }: { onBack: () => void; top: number }) {
	return <Pressable style={[styles.back, { top }]} accessibilityRole="button" accessibilityLabel="前の画面へ戻る" onPress={onBack}><Ionicons name="chevron-back" size={18} color={colors.text} /><Text style={styles.backText}>戻る</Text></Pressable>;
}

const styles = StyleSheet.create({
	gated: { flex: 1, backgroundColor: colors.bg },
	center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
	back: { position: 'absolute', left: 16, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: colors.surface }, backText: { color: colors.text, fontSize: 13, fontWeight: '600' },
	title: { color: colors.text, fontSize: 17, fontWeight: '700' },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 20 },
	btn: { backgroundColor: colors.accent2, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 26, marginTop: 4 },
	btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
