// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, LayoutAnimation, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { GlassSurface } from './glassSurface.js';
import { useParaToast, type ParaToast as ParaToastItem } from '../paraToast.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticImpact } from '../haptics.js';

/**
 * 一時的なお知らせを出す唯一の場所。ルートに1つだけ置く（`app/_layout.tsx`）。
 *
 * **上端に、内容ぶんの幅のガラスのカプセル**。出ている間はヘッダーごと本文が下がるので、
 * 島や右のボタンを覆わない（押し下げ量は `useToastInset()` を各ヘッダーが読む）。
 * 上へスワイプすればタイマーを待たずに消せる——iOSの通知バナーと同じ所作なので説明が要らない。
 *
 * 実装で気をつけていること:
 *  - **`opacity` で出し入れしない。** ガラスは不透明度を0にすると効果ごと死ぬので、
 *    `translateY` で画面外へ送る
 *  - ジェスチャは `PanResponder`（素のJS）。worklet から `runOnJS` で予約した処理は
 *    予約元が木から外れた後に走ると落ちる既知の不具合があり、
 *    「スワイプしたらその要素が消える」ここは最も踏みやすい形
 *  - 色は**アイコンだけ**に持たせ、面は染めない（暗所で薄い色を混ぜると泥色に濁る）
 *  - 位置は**セーフエリア基準**。タブバーの高さを基準にすると、
 *    iOS 26 のタブバーがスクロールで縮んだ瞬間に基準ごと動く
 */

/** カプセルの最大幅（pt）。iPhone SE の 320pt でも左右に余白が残る。 */
const TOAST_MAX_WIDTH = 300;

/** 出入りにかける時間（ミリ秒）。 */
const IN_MS = 420;
const OUT_MS = 240;
/** ここまで引き上げたら消す（pt）。速度が乗っていればこれ未満でも消す。 */
const DISMISS_DISTANCE = 26;
const DISMISS_VELOCITY = 0.5;

const TONE_COLOR: Record<ParaToastItem['tone'], string> = {
	info: colors.accent,
	done: colors.green,
	warn: colors.orange,
};

/**
 * 接続の状態から**継続系**のお知らせを導く。タイマーは持たない（直るまで残る）。
 *
 * `key` は状態が変わると変わる。いちど払われた後でも、状態が変われば別のお知らせとして
 * 出し直される（オフラインのまま気づかずに操作するのを防ぐのが目的）。
 */
function useStickyToast(): ParaToastItem | undefined {
	const { connection, pcOnline, sessionProtocolReady, manualOffline, pendingRendererCount, connectRelay } = useAppStore(useShallow(s => ({
		connection: s.connection,
		pcOnline: s.pcOnline,
		sessionProtocolReady: s.sessionProtocolReady,
		manualOffline: s.manualOffline,
		pendingRendererCount: s.workspace?.renderers.filter(renderer => !renderer.ready).length ?? 0,
		connectRelay: s.connectRelay,
	})));

	const live = connection === 'online' && pcOnline && sessionProtocolReady;
	const partialRecovery = live && pendingRendererCount > 0;

	return useMemo(() => {
		if (live && !partialRecovery) {
			return undefined;
		}
		if (partialRecovery) {
			return {
				key: `recovering:${pendingRendererCount}`,
				text: `${pendingRendererCount}個のPC画面を再接続中`,
				sub: '復旧済みの画面は操作できます',
				icon: 'sync-outline',
				tone: 'warn' as const,
			};
		}
		if (manualOffline) {
			return {
				key: 'manual-offline',
				text: '切断中 — 最後の画面を表示しています',
				icon: 'cloud-offline-outline',
				tone: 'warn' as const,
				action: { label: '接続', onPress: connectRelay },
			};
		}
		if (!pcOnline && (connection === 'online' || connection === 'handshaking')) {
			return {
				key: 'pc-offline',
				text: 'PCオフライン — 最後の画面を表示しています',
				icon: 'cloud-offline-outline',
				tone: 'warn' as const,
				action: { label: '再接続', onPress: connectRelay },
			};
		}
		return {
			key: 'reconnecting',
			text: '再接続中 — 最後の画面を表示しています',
			icon: 'sync-outline',
			tone: 'warn' as const,
			action: { label: '再接続', onPress: connectRelay },
		};
	}, [live, partialRecovery, pendingRendererCount, manualOffline, pcOnline, connection, connectRelay]);
}

/**
 * 「別のPCへ切り替わりました」をトーストへ流す。
 *
 * 通知タップなどで自動的に切り替わったこと自体は隠さない。以前は専用のコンポーネント
 * （PcSwitchNotice）が上端の別の位置に出していたが、器はここに1つで足りる。
 */
function usePcSwitchToast(): void {
	const { notice, pcs, switchPc, dismissNotice } = useAppStore(useShallow(s => ({
		notice: s.pcSwitchNotice, pcs: s.pcs, switchPc: s.switchPc, dismissNotice: s.dismissPcSwitchNotice,
	})));
	const show = useParaToast(s => s.show);

	useEffect(() => {
		if (notice === undefined) {
			return;
		}
		const previous = notice.previousPcId !== undefined ? pcs.find(pc => pc.id === notice.previousPcId) : undefined;
		show({
			key: `pc-switch:${notice.pcId}`,
			text: `${notice.name} に切り替えました`,
			icon: 'desktop-outline',
			tone: 'info',
			...(previous !== undefined
				? { action: { label: '戻る', onPress: () => switchPc(previous.id) } }
				: {}),
		}, 6_000);
		// ストア側のフラグはここで降ろす。消えるタイミングはトースト自身のタイマーが持つ。
		dismissNotice();
	}, [notice, pcs, show, switchPc, dismissNotice]);
}

export function ParaToastHost() {
	const insets = useStableInsets();
	const { transient, dismissedStickyKey, hideTransient, dismissSticky, resetSticky, setHeight } = useParaToast(useShallow(s => ({
		transient: s.transient,
		dismissedStickyKey: s.dismissedStickyKey,
		hideTransient: s.hideTransient,
		dismissSticky: s.dismissSticky,
		resetSticky: s.resetSticky,
		setHeight: s.setHeight,
	})));
	const sticky = useStickyToast();
	usePcSwitchToast();

	// 一過性が出ている間はそちらを見せる（新しい出来事のほうが関心が高い）。
	// 沈んだら継続系が戻ってくる。
	const stickyVisible = sticky !== undefined && sticky.key !== dismissedStickyKey;
	const toast = transient ?? (stickyVisible ? sticky : undefined);

	const anim = useRef(new Animated.Value(0)).current;
	const [shown, setShown] = useState<ParaToastItem | undefined>(undefined);
	// 出入りの最中も中身を描き続けるため、消えるまでは直前の内容を保持する。
	const visible = toast !== undefined;
	const content = toast ?? shown;

	useEffect(() => {
		if (toast !== undefined) {
			setShown(toast);
			Animated.timing(anim, { toValue: 1, duration: IN_MS, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }).start();
			return undefined;
		}
		Animated.timing(anim, { toValue: 0, duration: OUT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start();
		// 消え切ってから中身を捨てる。アニメーションの完了コールバックでアンマウントすると、
		// 木から外れた後に走った場合に落ちる経路を踏むので `setTimeout` にする。
		const timer = setTimeout(() => setShown(undefined), OUT_MS + 40);
		return () => clearTimeout(timer);
	}, [toast, anim]);

	// C1: 継続系の条件が消えた（＝復帰した）瞬間に、払った記録を白紙へ戻す。
	// key は固定文字列なので、これをやらないと「復帰 → また切れる」で同じ key に
	// 戻ってきたときに払い済みと判定され、二度と出なくなる。
	useEffect(() => {
		if (sticky === undefined && dismissedStickyKey !== undefined) {
			resetSticky();
		}
	}, [sticky, dismissedStickyKey, resetSticky]);

	// 出ていないときはヘッダーを押し下げない。
	useEffect(() => {
		if (!visible) {
			LayoutAnimation.configureNext({ duration: OUT_MS, update: { type: 'easeInEaseOut' } });
			setHeight(0);
		}
	}, [visible, setHeight]);

	// 払う操作は「いま画面に出ている1件」ではなく**その場のカプセルごと**を対象にする。
	// 一過性だけ消すと、裏に控えていた継続系がその場で昇格して指を離した位置から
	// 生えてくるので、払えたのか払えなかったのかが読めない（H2）。
	const dismiss = useMemo(() => () => {
		hapticImpact('light');
		if (transient !== undefined) {
			hideTransient();
		}
		if (sticky !== undefined) {
			dismissSticky(sticky.key);
		}
	}, [transient, sticky, hideTransient, dismissSticky]);

	// 画面外へ送る距離＝カプセルの実測高さ。**ref ではなく state で持つ。**
	// ref のままだと測っても再レンダが起きず、`translateY` の outputRange が既定値で
	// 固まったまま＝背の高いカプセルが画面外から始まらない（頭が出たまま現れる）。
	const [travel, setTravel] = useState(64);

	// ホストが外れる（再ロック等）ときは押し下げ量を残さない。
	useEffect(() => () => { useParaToast.getState().setHeight(0); }, []);

	// 上へ引くと付いてきて、離した位置か速度で消える。下は引っぱれない（行き止まり）。
	const pan = useMemo(() => PanResponder.create({
		onStartShouldSetPanResponder: () => false,
		onMoveShouldSetPanResponder: (_event, gesture) =>
			gesture.dy < -3 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
		onPanResponderMove: (_event, gesture) => {
			// 1 が定位置。上へ引くほど 0 に近づけて、そのまま画面外へ繋げる。
			anim.setValue(Math.max(0, Math.min(1, 1 + Math.min(0, gesture.dy) / Math.max(1, travel))));
		},
		onPanResponderRelease: (_event, gesture) => {
			if (gesture.dy < -DISMISS_DISTANCE || gesture.vy < -DISMISS_VELOCITY) {
				dismiss();
				return;
			}
			Animated.spring(anim, { toValue: 1, speed: 16, bounciness: 4, useNativeDriver: true }).start();
		},
		onPanResponderTerminate: () => {
			Animated.spring(anim, { toValue: 1, speed: 16, bounciness: 4, useNativeDriver: true }).start();
		},
	}), [anim, dismiss, travel]);

	if (content === undefined) {
		return null;
	}

	const translateY = anim.interpolate({
		inputRange: [0, 1],
		outputRange: [-(travel + insets.top), 0],
		extrapolate: 'clamp',
	});
	const tone = TONE_COLOR[content.tone];

	return (
		<View style={[styles.host, { top: insets.top }]} pointerEvents="box-none">
			<Animated.View
				style={[styles.slider, { transform: [{ translateY }] }]}
				{...pan.panHandlers}
				onLayout={event => {
					// カプセル全体の高さをヘッダーの押し下げへ渡す。文字数・補足行・操作ボタンの
					// 有無で変わるので固定値にしない。
					const height = Math.round(event.nativeEvent.layout.height);
					if (height <= 0) {
						return;
					}
					// **`setHeight` は無条件に呼ぶ。** 隠れるときに store の height は 0 へ落ちるが
					// `travel` は前回の値を保持しているので、「同じ高さなら早期return」にすると
					// 2回目以降は store が 0 のままになり、ヘッダーが下がらずカプセルが島へ重なる（C2）。
					// 同値の書き込みはストア側で弾いてある。
					LayoutAnimation.configureNext({ duration: IN_MS, update: { type: 'easeInEaseOut' } });
					setHeight(height);
					if (height !== travel) {
						setTravel(height);
					}
				}}
			>
				<GlassSurface style={styles.capsule}>
					<View style={styles.body}>
						{content.spinner === true
							? <ActivityIndicator size="small" color={tone} />
							: <Ionicons name={content.icon} size={16} color={tone} />}
						<View style={styles.textCol}>
							<Text style={styles.text} numberOfLines={2} accessibilityLiveRegion="polite">{content.text}</Text>
							{content.sub !== undefined && content.sub.length > 0
								? <Text style={styles.sub} numberOfLines={1}>{content.sub}</Text>
								: null}
						</View>
						{content.action !== undefined ? (
							<Pressable
								hitSlop={8}
								onPress={() => {
									hapticImpact('light');
									content.action?.onPress();
									// 操作したらそのお知らせの役目は終わり。
									dismiss();
								}}
								accessibilityRole="button"
								accessibilityLabel={content.action.label}
							>
								<Text style={styles.action}>{content.action.label}</Text>
							</Pressable>
						) : null}
					</View>
				</GlassSurface>
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	// 上端の中央。内容ぶんの幅にするため、左右いっぱいに広げてから中身を中央へ寄せる。
	host: { position: 'absolute', left: 0, right: 0, zIndex: 60, alignItems: 'center' },
	// 幅は**絶対値**で決める。割合にすると iPad の広い幅で940pt級のカプセルになる
	// （CLAUDE.md のiPad規約）。iPhoneの狭い幅でも画面内に収まる値。
	slider: { maxWidth: TOAST_MAX_WIDTH },
	// 補足行が付くと2行になるので、角丸はピル（高さの半分）に任せる。
	capsule: { borderRadius: radius.pill, ...squircle },
	body: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingVertical: 11 },
	textCol: { flexShrink: 1, minWidth: 0 },
	text: { color: colors.text, fontSize: 12.5, fontWeight: '600', lineHeight: 17 },
	sub: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
	action: { color: colors.accent, fontSize: 12.5, fontWeight: '700' },
});
