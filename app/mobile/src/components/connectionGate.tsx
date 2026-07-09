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
			<Pressable style={styles.btn} onPress={() => { hapticImpact('medium'); onStart(); }}>
				<Text style={styles.btnText}>ペアリングを開始</Text>
			</Pressable>
		</View>
	);
}

export function ConnectionGate({ children }: { children: ReactNode }) {
	const router = useRouter();
	const { connection, pcOnline, paired, ready, manualOffline, connectRelay } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, paired: s.paired, ready: s.ready,
		manualOffline: s.manualOffline, connectRelay: s.connectRelay,
	})));

	if (connection === 'online' && pcOnline) {
		return <>{children}</>;
	}

	if (ready && !paired) {
		return <PairingRequiredNotice onStart={() => router.push('/pair')} />;
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
		<View style={styles.center}>
			{connecting ? <ActivityIndicator size="large" color={colors.accent} /> : <Ionicons name="cloud-offline-outline" size={40} color={colors.textDim} />}
			<Text style={styles.title}>{connecting ? '接続中' : '未接続'}</Text>
			<Text style={styles.dim}>{message}</Text>
			{!connecting ? (
				<Pressable style={styles.btn} onPress={() => { hapticImpact('light'); connectRelay(); }}>
					<Text style={styles.btnText}>{manualOffline ? '接続する' : '再接続'}</Text>
				</Pressable>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
	title: { color: colors.text, fontSize: 17, fontWeight: '700' },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 20 },
	btn: { backgroundColor: colors.accent2, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 26, marginTop: 4 },
	btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
