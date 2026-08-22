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
import { ConnectionStatusBanner } from './connectionStatusBanner.js';

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

/**
 * ゲートが本文を塞いでいるか（＝この画面は自分の中身を描いていないか）。
 *
 * **常設のヘッダー層はこれを見て伏せる。** 層は画面の外に居るのでゲートに巻き込まれず、
 * 塞がれている画面の上にもヘッダーを描いてしまう。条件をヘッダー側に書き写すと必ずずれる
 * （実際に「接続完了から最初のstate到着までの数百msだけ島が消える」「ゲートの『戻る』と
 * 層の丸が二重に出る」の2つを作った）ので、**判断はここ1箇所に置く**。
 *
 * 下の `ConnectionGate` の分岐と1対1で対応させること。本文を返す分岐（キャッシュあり・
 * 完全にオンライン）だけが false になる。
 */
export function useConnectionGateBlocked(): boolean {
	const { connection, pcOnline, sessionProtocolReady, hasWorkspace, paired, ready, protocolError } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, paired: s.paired, ready: s.ready,
		sessionProtocolReady: s.sessionProtocolReady, hasWorkspace: s.workspace !== undefined,
		protocolError: s.protocolError,
	})));
	if (protocolError !== undefined || (ready && !paired)) {
		return true;
	}
	if (paired && hasWorkspace) {
		return false;
	}
	return !(connection === 'online' && pcOnline && sessionProtocolReady);
}

export function ConnectionGate({ children }: { children: ReactNode }) {
	const router = useRouter();
	const insets = useStableInsets();
	const canGoBack = router.canGoBack();
	// workspace 本体ではなく「キャッシュがあるか」だけを購読する（判定に使うのは有無のみ）。
	// 本体を購読すると、PCからのstate再送のたびに全タブの中身が再構築される。
	const { connection, pcOnline, sessionProtocolReady, hasWorkspace, paired, ready, manualOffline, protocolError, initializing, initError, connectRelay } = useAppStore(useShallow(s => ({
		connection: s.connection, pcOnline: s.pcOnline, paired: s.paired, ready: s.ready,
		sessionProtocolReady: s.sessionProtocolReady, hasWorkspace: s.workspace !== undefined,
		manualOffline: s.manualOffline, protocolError: s.protocolError,
		initializing: s.initializing, initError: s.initError, connectRelay: s.connectRelay,
	})));

	if (protocolError !== undefined) {
		return <View style={styles.gated}><View style={styles.center} accessibilityLiveRegion="polite">
			<Ionicons name="refresh-circle-outline" size={40} color={colors.red} />
			<Text style={styles.title}>アップデートが必要です</Text>
			<Text style={styles.dim}>{protocolError}</Text>
		</View>{canGoBack ? <GateBackButton top={insets.top + 8} onBack={() => router.back()} /> : null}</View>;
	}

	// **起動処理の間は「未接続」を出さない。** コールドスタート直後（Keychain読取・台帳復元が
	// 終わる前）は ready も paired も false で、ここを通らないと一瞬「PCに接続できていません」
	// +再接続ボタン（実質 no-op）がちらつく。
	if (initializing) {
		return <View style={styles.gated}><View style={styles.center}>
			<ActivityIndicator accessibilityLabel="起動中" size="large" color={colors.accent} />
			<Text style={styles.dim}>起動しています…</Text>
		</View>{canGoBack ? <GateBackButton top={insets.top + 8} onBack={() => router.back()} /> : null}</View>;
	}

	// **起動処理の失敗。** 記録していないと初期 state のまま「未接続」で固まり、
	// 再接続ボタン（connectRelay）は runtimes が空で何もせず復帰不能だった。
	if (initError !== undefined && !ready) {
		const retry = () => { void useAppStore.getState().init().catch(() => { /* 失敗は initError へ記録される */ }); };
		return <View style={styles.gated}><View style={styles.center} accessibilityLiveRegion="polite">
			<Ionicons name="cloud-offline-outline" size={40} color={colors.red} />
			<Text style={styles.title}>起動に失敗しました</Text>
			<Text style={styles.dim}>{initError}</Text>
			<Pressable style={styles.btn} accessibilityRole="button" onPress={() => { hapticImpact('light'); retry(); }}>
				<Text style={styles.btnText}>再試行</Text>
			</Pressable>
		</View>{canGoBack ? <GateBackButton top={insets.top + 8} onBack={() => router.back()} /> : null}</View>;
	}

	if (ready && !paired) {
		return <View style={styles.gated}><PairingRequiredNotice onStart={() => router.push('/pair')} />{canGoBack ? <GateBackButton top={insets.top + 8} onBack={() => router.back()} /> : null}</View>;
	}

	if (paired && hasWorkspace) {
		return <View style={styles.cached}>{children}<ConnectionStatusBanner /></View>;
	}

	if (connection === 'online' && pcOnline && sessionProtocolReady) {
		return <>{children}</>;
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
	cached: { flex: 1, backgroundColor: colors.bg },
	center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
	back: { position: 'absolute', left: 16, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: colors.surface }, backText: { color: colors.text, fontSize: 13, fontWeight: '600' },
	title: { color: colors.text, fontSize: 17, fontWeight: '700' },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 20 },
	btn: { backgroundColor: colors.accent2, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 26, marginTop: 4 },
	btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
