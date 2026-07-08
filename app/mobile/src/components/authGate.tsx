// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 生体認証ゲート。アプリ起動時に FaceID / Touch ID（フォールバックで端末パスコード）を要求する。
 * 一度認証に成功すれば、他アプリへ切り替えても「離脱から10分以内」の復帰は再認証を省略する。
 * 猶予時刻はメモリ上にのみ持つため、プロセスが終了して再起動した場合は必ず再認証になる。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { colors } from '../theme.js';

/** 離脱後に再認証を免除する猶予時間。 */
const REAUTH_GRACE_MS = 10 * 60 * 1000;

type GateState = 'locked' | 'authenticating' | 'unlocked';

export function AuthGate({ children, onUnlock }: { children: React.ReactNode; onUnlock?: () => void }) {
	const [state, setState] = useState<GateState>('locked');
	const stateRef = useRef(state);
	stateRef.current = state;
	// 認証済みのままバックグラウンドへ移った時刻。10分以内の復帰は再認証を免除する。
	const hiddenAtRef = useRef<number | undefined>(undefined);
	// 認証試行の世代。authenticateAsync が resolve しないまま次の試行が始まった場合に、
	// 古い試行の結果で state を上書きしないためのガード。
	const attemptRef = useRef(0);

	const authenticate = useCallback(async () => {
		if (stateRef.current === 'authenticating') {
			return;
		}
		const attempt = ++attemptRef.current;
		setState('authenticating');
		try {
			const hasHardware = await LocalAuthentication.hasHardwareAsync();
			const enrolled = hasHardware && await LocalAuthentication.isEnrolledAsync();
			if (attempt !== attemptRef.current) {
				return;
			}
			if (!enrolled) {
				// 生体情報もパスコードも未設定の端末ではロックが成立しないため通す
				setState('unlocked');
				onUnlock?.();
				return;
			}
			const result = await LocalAuthentication.authenticateAsync({
				promptMessage: 'Para Code のロックを解除',
				cancelLabel: 'キャンセル',
			});
			if (attempt === attemptRef.current) {
				setState(result.success ? 'unlocked' : 'locked');
				if (result.success) {
					onUnlock?.();
				}
			}
		} catch {
			if (attempt === attemptRef.current) {
				setState('locked');
			}
		}
	}, [onUnlock]);

	useEffect(() => {
		void authenticate();
		let stuckTimer: ReturnType<typeof setTimeout> | undefined;
		const sub = AppState.addEventListener('change', next => {
			if (next === 'background') {
				if (stateRef.current === 'unlocked') {
					hiddenAtRef.current = Date.now();
				}
				return;
			}
			if (next === 'active') {
				if (stateRef.current === 'unlocked') {
					const hiddenAt = hiddenAtRef.current;
					if (hiddenAt !== undefined && Date.now() - hiddenAt > REAUTH_GRACE_MS) {
						hiddenAtRef.current = undefined;
						void authenticate();
					}
				} else if (stateRef.current === 'locked') {
					void authenticate();
				} else {
					// 'authenticating' のまま復帰した場合、システムキャンセル等で
					// authenticateAsync が resolve しないまま固着している可能性がある。
					// 少し待っても解決しなければ locked へ戻して再試行ボタンを出す。
					clearTimeout(stuckTimer);
					stuckTimer = setTimeout(() => {
						if (stateRef.current === 'authenticating') {
							attemptRef.current++;
							setState('locked');
						}
					}, 2000);
				}
			}
		});
		return () => { sub.remove(); clearTimeout(stuckTimer); };
	}, [authenticate]);

	if (state === 'unlocked') {
		// ロック解除後の猶予時間内はアプリスイッチャー等でも目隠しはしない（ユーザー要望）。
		// 再ロック（猶予超過での復帰）時は state が変わりロック画面に切り替わる。
		return <>{children}</>;
	}
	return (
		<View style={styles.screen}>
			<Ionicons name="lock-closed-outline" size={44} color={colors.textDim} />
			<Text style={styles.title}>Para Code はロックされています</Text>
			{state === 'locked' ? (
				<Pressable style={styles.unlockBtn} onPress={() => { void authenticate(); }}>
					<Text style={styles.unlockText}>ロック解除</Text>
				</Pressable>
			) : (
				<Text style={styles.dim}>認証中…</Text>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: colors.bg },
	title: { color: colors.text, fontSize: 15, fontWeight: '600' },
	dim: { color: colors.textDim, fontSize: 13 },
	unlockBtn: { backgroundColor: colors.accent2, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
	unlockText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
