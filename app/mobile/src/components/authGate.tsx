// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 生体認証ゲート。アプリ起動時に FaceID / Touch ID（フォールバックで端末パスコード）を要求する。
 * 一度認証に成功すれば、他アプリへ切り替えても「離脱から10分以内」の復帰は再認証を省略する。
 * 猶予時刻はメモリ上にのみ持つため、プロセスが終了して再起動した場合は必ず再認証になる。
 *
 * **ロック中も `children`（アプリの画面）は木から外さない。** ロック画面を上に重ねて覆い、下の層は
 * 触らせず読み上げにも出さないだけにする。外すと、猶予切れで再ロックしたときに Stack ごと作り直され、
 * 解除後は最初の画面に戻る（ターミナル・入力途中の文字・iPad の詳細の列・通知で開いた画面が消える）。
 * 木の形は状態によらず同じで、切り替えるのは props とスタイルだけ。ただし起動直後の最初の解除までは `children`
 * を描かない（失う状態がまだ無く、認証前に PC の画面や申告を動かさないため）。一度描いたら外さない。
 *
 * RN の `Modal` はネイティブで最前面に出てロック画面より上に来るので、ロック中かを `AppLockContext`
 * で配り、各 `Modal` が自分で `visible` を落とす（`appLock.ts`）。ロック画面自体は `Modal` にしない
 * （Modal を重ねると iOS が提示を取りこぼすため）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Keyboard, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { colors, type } from '../theme.js';
import { AppLockContext } from '../appLock.js';
import { onAppReauthenticationRequest, setAppLockedNow } from '../appLockState.js';
import { AUTH_UI_RETRY_DELAY_MS, canLockDevice, foregroundAction, isAppLocked, isAuthUiUnavailable, lockedContentProps, lockedRetryAction, type AuthGateState } from '../appLockPolicy.js';
import { Button } from '../ui/button.js';

type GateState = AuthGateState;

export function AuthGate({ children, onUnlock }: { children: React.ReactNode; onUnlock?: () => void }) {
	const [state, setState] = useState<GateState>('locked');
	const stateRef = useRef(state);
	stateRef.current = state;
	// 認証済みのままバックグラウンドへ移った時刻。10分以内の復帰は再認証を免除する。
	const hiddenAtRef = useRef<number | undefined>(undefined);
	// 認証試行の世代。authenticateAsync が resolve しないまま次の試行が始まった場合に、
	// 古い試行の結果で state を上書きしないためのガード。
	const attemptRef = useRef(0);
	/**
	 * 直前の失敗（時刻と `authenticateAsync` の `error`）。失敗の直後に認証の UI が閉じて前面へ戻った知らせで、
	 * すぐ認証し直さないために使う（appLockPolicy.ts の lockedRetryAction）。
	 */
	const lastFailureRef = useRef<{ readonly at: number; readonly error: string | undefined } | undefined>(undefined);
	/** UI を出せずに失敗したときのやり直しを、もう使ったか（1 回だけ）。成功か「ロック解除」のボタンで戻す。 */
	const uiRetriedRef = useRef(false);
	const uiRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(uiRetryTimer.current), []);

	const authenticate = useCallback(async () => {
		if (stateRef.current === 'authenticating') {
			return;
		}
		clearTimeout(uiRetryTimer.current);
		const attempt = ++attemptRef.current;
		setState('authenticating');
		const failed = (error: string | undefined) => {
			lastFailureRef.current = { at: Date.now(), error };
			setState('locked');
			// UI を出せなかった（起動の途中・前面でない）。前面にいれば少し待って 1 回だけやり直す。前面でなければ、
			// 前面へ戻った知らせでやり直す
			if (isAuthUiUnavailable(error) && !uiRetriedRef.current && AppState.currentState === 'active') {
				scheduleUiRetryRef.current();
			}
		};
		try {
			// 生体を登録していなくても、パスコードがあればそれで解除させる（authenticateAsync は既定でパスコードへ回す）
			const lockable = canLockDevice(await LocalAuthentication.getEnrolledLevelAsync());
			if (attempt !== attemptRef.current) {
				return;
			}
			if (!lockable) {
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
				if (result.success) {
					lastFailureRef.current = undefined;
					uiRetriedRef.current = false;
					setState('unlocked');
					onUnlock?.();
				} else {
					failed(result.error);
				}
			}
		} catch {
			if (attempt === attemptRef.current) {
				failed(undefined);
			}
		}
	}, [onUnlock]);

	/** UI を出せずに失敗した後、少し待ってから 1 回だけやり直す（前面にいてロック中のときだけ）。 */
	const scheduleUiRetry = () => {
		uiRetriedRef.current = true;
		clearTimeout(uiRetryTimer.current);
		uiRetryTimer.current = setTimeout(() => {
			if (stateRef.current === 'locked' && AppState.currentState === 'active') {
				void authenticate();
			}
		}, AUTH_UI_RETRY_DELAY_MS);
	};
	const scheduleUiRetryRef = useRef(scheduleUiRetry);
	scheduleUiRetryRef.current = scheduleUiRetry;

	/** 「ロック解除」のボタン。やり直しの回数と直前の失敗を忘れて始める。 */
	const authenticateByUser = useCallback(() => {
		lastFailureRef.current = undefined;
		uiRetriedRef.current = false;
		void authenticate();
	}, [authenticate]);

	// 通知のボタン（許可・拒否・返信）は送る前に Face ID を通す（notificationActionRunner.ts）。再認証の猶予の間でも認証し直す。
	useEffect(() => onAppReauthenticationRequest(() => {
		if (stateRef.current === 'unlocked') {
			void authenticate();
		}
	}), [authenticate]);

	useEffect(() => {
		// 起動の途中（まだ前面でない）に頼むと、iOS は認証の UI を出せずに -1000 で失敗する。前面のときだけすぐ始め、
		// そうでなければ前面へ戻った知らせ（下の 'active'）で始める。知らせが来ないときのために少し待っても始める
		let startTimer: ReturnType<typeof setTimeout> | undefined;
		if (AppState.currentState === 'active') {
			void authenticate();
		} else {
			startTimer = setTimeout(() => {
				if (stateRef.current === 'locked' && lastFailureRef.current === undefined && attemptRef.current === 0) {
					void authenticate();
				}
			}, AUTH_UI_RETRY_DELAY_MS * 2);
		}
		let stuckTimer: ReturnType<typeof setTimeout> | undefined;
		const sub = AppState.addEventListener('change', next => {
			if (next === 'background') {
				if (stateRef.current === 'unlocked') {
					hiddenAtRef.current = Date.now();
				}
				return;
			}
			if (next === 'active') {
				const action = foregroundAction(stateRef.current, hiddenAtRef.current, Date.now());
				if (stateRef.current === 'unlocked' && action === 'authenticate') {
					hiddenAtRef.current = undefined;
				}
				if (action === 'authenticate' && stateRef.current === 'locked') {
					// 失敗の直後（認証の UI が閉じて戻った知らせ）にすぐ始めない。UI を出せなかった失敗は待って 1 回だけやり直す
					const retry = lockedRetryAction(lastFailureRef.current, uiRetriedRef.current, Date.now());
					if (retry === 'authenticate') {
						void authenticate();
					} else if (retry === 'retryLater') {
						scheduleUiRetryRef.current();
					}
				} else if (action === 'authenticate') {
					void authenticate();
				} else if (action === 'watchStuck') {
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
		return () => { sub.remove(); clearTimeout(stuckTimer); clearTimeout(startTimer); };
	}, [authenticate]);

	const locked = isAppLocked(state);
	// 最初に解除されたか。一度 true になったら戻さない（再ロックでは `children` を外さない）。
	const [everUnlocked, setEverUnlocked] = useState(false);
	if (!locked && !everUnlocked) {
		setEverUnlocked(true);
	}
	// React の外（Alert・送信待ち・トーストのタイマー）にも知らせる。子の effect より先に入れる。
	useLayoutEffect(() => {
		setAppLockedNow(locked);
	}, [locked]);
	// ロック中は下の画面の入力欄にフォーカスを渡さない（外付けキーボードの打鍵が覆われた入力欄へ入らないように）。
	// ロックした瞬間に外し、その後キーボードが出ようとしても閉じる。入力途中の文字は入力欄に残る。
	useEffect(() => {
		if (!locked) {
			return undefined;
		}
		Keyboard.dismiss();
		const willShow = Keyboard.addListener('keyboardWillShow', () => Keyboard.dismiss());
		const didShow = Keyboard.addListener('keyboardDidShow', () => Keyboard.dismiss());
		return () => {
			willShow.remove();
			didShow.remove();
		};
	}, [locked]);

	// ロック解除後の猶予時間内はアプリスイッチャー等でも目隠しはしない（ユーザー要望）。
	// 再ロック（猶予超過での復帰）時はロック画面の層が表示に切り替わり、下の画面を覆う。
	// 層は常に置き、`display` で出し入れする（木の形を変えない）。
	return (
		<AppLockContext.Provider value={locked}>
			<View style={styles.root} collapsable={false}>
				{/* `collapsable={false}`: 平坦化されると中の zIndex がロック画面より上に出うるので、層として残す */}
				<View style={styles.root} collapsable={false} {...lockedContentProps(locked)}>
					{everUnlocked ? children : null}
				</View>
				<View
					style={[styles.lockScreen, locked ? undefined : styles.hidden]}
					collapsable={false}
					pointerEvents={locked ? 'auto' : 'none'}
					accessibilityViewIsModal={locked}
					accessibilityElementsHidden={!locked}
					importantForAccessibility={locked ? 'yes' : 'no-hide-descendants'}
				>
					<Ionicons name="lock-closed-outline" size={44} color={colors.textDim} />
					<Text style={styles.title}>Para Code はロックされています</Text>
					{state === 'locked' ? (
						<Button label="ロック解除" variant="primary" accessibilityLabel="ロック解除" onPress={authenticateByUser} />
					) : (
						<Text style={styles.dim}>認証中…</Text>
					)}
				</View>
			</View>
		</AppLockContext.Provider>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
	lockScreen: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 14, backgroundColor: colors.bg },
	hidden: { display: 'none' },
	title: { color: colors.text, fontSize: type.title, fontWeight: '600' },
	dim: { color: colors.textDim, fontSize: type.body },
});
