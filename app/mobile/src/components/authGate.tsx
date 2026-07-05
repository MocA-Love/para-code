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

export function AuthGate({ children }: { children: React.ReactNode }) {
	const [state, setState] = useState<GateState>('locked');
	const [appActive, setAppActive] = useState(true);
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
				return;
			}
			const result = await LocalAuthentication.authenticateAsync({
				promptMessage: 'Para Code Mobile のロックを解除',
				cancelLabel: 'キャンセル',
			});
			if (attempt === attemptRef.current) {
				setState(result.success ? 'unlocked' : 'locked');
			}
		} catch {
			if (attempt === attemptRef.current) {
				setState('locked');
			}
		}
	}, []);

	useEffect(() => {
		void authenticate();
		let stuckTimer: ReturnType<typeof setTimeout> | undefined;
		const sub = AppState.addEventListener('change', next => {
			setAppActive(next === 'active');
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
		// アプリスイッチャーのサムネイル等に内容が写らないよう、非アクティブ中は目隠しを重ねる
		// （childrenはアンマウントせず状態を保つ）
		return (
			<View style={styles.fill}>
				{children}
				{!appActive ? (
					<View style={styles.privacyCover}>
						<Ionicons name="lock-closed-outline" size={44} color={colors.textDim} />
					</View>
				) : null}
			</View>
		);
	}
	return (
		<View style={styles.screen}>
			<Ionicons name="lock-closed-outline" size={44} color={colors.textDim} />
			<Text style={styles.title}>Para Code Mobile はロックされています</Text>
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
	fill: { flex: 1 },
	privacyCover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, zIndex: 10 },
	screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: colors.bg },
	title: { color: colors.text, fontSize: 15, fontWeight: '600' },
	dim: { color: colors.textDim, fontSize: 13 },
	unlockBtn: { backgroundColor: colors.accent2, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
	unlockText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
