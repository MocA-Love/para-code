// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
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
 * **上端に浮かぶガラスのカプセル。ヘッダーは動かさず、その上に重ねる。**
 * 以前はカプセルの高さぶんヘッダーを押し下げていたが、押し下げは島だけでなくその下の帯・
 * 本文の上端まで連鎖して動かすうえ、押し下げの `LayoutAnimation` とカプセルのばねが別々に
 * 走るので境目が一瞬重なっていた。重ねればレイアウトは一切動かない——iOSの通知バナーと
 * 同じ読み方なので説明も要らない。
 *
 * 重なるあいだ島は隠れるが、ここに出すのは**数秒で沈む一過性のお知らせだけ**なので許容する。
 * 直るまで残る状態（再接続中・オフライン）はこの器では出さず、島の中で示す
 * （`src/offlineNotice.ts`）。
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

/** セーフエリア上端からの浮かせ量（pt）。 */
const TOAST_TOP_GAP = 6;

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
	const { current, hide } = useParaToast(useShallow(s => ({ current: s.current, hide: s.hide })));
	usePcSwitchToast();

	const anim = useRef(new Animated.Value(0)).current;
	const [shown, setShown] = useState<ParaToastItem | undefined>(undefined);
	// 出入りの最中も中身を描き続けるため、消えるまでは直前の内容を保持する。
	const visible = current !== undefined;
	const content = current ?? shown;

	useEffect(() => {
		if (current !== undefined) {
			setShown(current);
			Animated.timing(anim, { toValue: 1, duration: IN_MS, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }).start();
			return undefined;
		}
		Animated.timing(anim, { toValue: 0, duration: OUT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start();
		// 消え切ってから中身を捨てる。アニメーションの完了コールバックでアンマウントすると、
		// 木から外れた後に走った場合に落ちる経路を踏むので `setTimeout` にする。
		const timer = setTimeout(() => setShown(undefined), OUT_MS + 40);
		return () => clearTimeout(timer);
	}, [current, anim]);

	// 画面外へ送る距離＝カプセルの実測高さ。**ref ではなく state で持つ。**
	// ref のままだと測っても再レンダが起きず、`translateY` の outputRange が既定値で
	// 固まったまま＝背の高いカプセルが画面外から始まらない（頭が出たまま現れる）。
	const [travel, setTravel] = useState(64);

	const dismiss = useMemo(() => () => {
		hapticImpact('light');
		hide();
	}, [hide]);

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
		outputRange: [-(travel + insets.top + TOAST_TOP_GAP), 0],
		extrapolate: 'clamp',
	});
	const tone = TONE_COLOR[content.tone];

	return (
		<View style={[styles.host, { top: insets.top + TOAST_TOP_GAP }]} pointerEvents={visible ? 'box-none' : 'none'}>
			<Animated.View
				style={[styles.slider, { transform: [{ translateY }] }]}
				{...pan.panHandlers}
				// 高さは文字数・補足行・操作ボタンの有無で変わるので固定値にしない。
				onLayout={event => {
					const height = Math.round(event.nativeEvent.layout.height);
					if (height > 0 && height !== travel) {
						setTravel(height);
					}
				}}
			>
				{/* 影はガラスの外側に落とす層に持たせる。重ねる方式では影だけが
				    「これは上に浮いている別の層」を伝える手掛かりになる。 */}
				<View style={styles.shadow}>
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
										hide();
									}}
									accessibilityRole="button"
									accessibilityLabel={content.action.label}
								>
									<Text style={styles.action}>{content.action.label}</Text>
								</Pressable>
							) : null}
						</View>
					</GlassSurface>
				</View>
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
	// 影は `overflow: 'hidden'` と同じ層に置くと切り抜かれて消えるので、ガラスの外側に置く。
	shadow: { borderRadius: radius.pill, ...squircle, shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
	// 補足行が付くと2行になるので、角丸はピル（高さの半分）に任せる。
	capsule: { borderRadius: radius.pill, ...squircle },
	body: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingVertical: 11 },
	textCol: { flexShrink: 1, minWidth: 0 },
	text: { color: colors.text, fontSize: 12.5, fontWeight: '600', lineHeight: 17 },
	sub: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
	action: { color: colors.accent, fontSize: 12.5, fontWeight: '700' },
});
