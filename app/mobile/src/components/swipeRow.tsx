// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { CARD_GAP, CARD_WIDTH, swipeGeometry } from './swipeRowGeometry.js';
import { radius, squircle } from '../theme.js';
import { spring } from '../motion.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/**
 * 一覧の行を横スワイプして操作するための包み。
 *
 * RNGHの`ReanimatedSwipeable`は使わない。あれは動く幅をアクション面の`measure()`から
 * 決めるため、この一覧では幅が取れずに**指を横に動かしても行が1pxも動かない**うえ、
 * 横方向のジェスチャだけは掴んでしまい、ホームの全画面スワイプ（ドロワーを開く）まで
 * 効かなくなった。ここでは幅を定数で持ち、自前のPanで動かす。
 *
 * **`direction`の向きにしか反応しない**のが要点。ホームは左スワイプだけを取るので、
 * 右スワイプはそのままドロワーへ抜ける（アーカイブ画面はドロワーの対象外なので逆向き）。
 *
 * 動きは2段階。浅く引くと**開いたまま止まり**、カードを狙って押せる。深く引き切ると
 * `fullSwipe` を付けたものが横に伸びてそのまま実行される。**取り返しのつかない操作
 * （削除）には `fullSwipe` を付けない**。勢いよく払っただけで消えてしまうため。
 *
 * 面の見せ方は透明度ではなく**幾何**で行う。開いた幅ぶんだけ切り抜いた窓から覗かせるので、
 * 半透明の板が薄く重なる中間状態が生まれず、指の位置と面の縁がぴったり付いてくる。
 */

export interface SwipeAction {
	key: string;
	label: string;
	icon: keyof typeof Ionicons.glyphMap;
	/** カードの地の色。 */
	color: string;
	onPress: () => void;
	/** 引き切ったときに伸びて実行されるか。破壊的な操作には付けないこと。 */
	fullSwipe?: boolean;
}

/**
 * 開いている行は常に1つだけにする。
 *
 * 段階1（開いたまま止まる）を入れると「指を離せば必ず閉じる」という前提が崩れるので、
 * 何もしないと開きっぱなしの行が一覧に散らばる。次を開くとき前のを閉じることで、
 * 画面のどこかに押し忘れたカードが残っている状態を作らない。
 */
let closeOpenedRow: (() => void) | undefined;

export function SwipeRow({ direction, actions, children }: {
	/** 'left' は指を左へ引く（右側からアクションが出る）。'right' はその逆。 */
	direction: 'left' | 'right';
	actions: readonly SwipeAction[];
	children: ReactNode;
}) {
	const dx = useSharedValue(0);
	const toLeft = direction === 'left';
	const { openDistance, fullSwipeAt, limit } = swipeGeometry(actions.length);
	const fullSwipeAction = actions.find(action => action.fullSwipe === true);
	// 開いている間は逆向きにも掴む。そうしないと閉じる手段が「カードを押す＝何か実行する」
	// しか無くなる（行本体を押すとエージェント詳細へ行ってしまう）。
	const [opened, setOpened] = useState(false);

	const close = useCallback(() => { setOpened(false); dx.value = withSpring(0, spring.swipe); }, [dx]);
	const closeRef = useRef(close);
	closeRef.current = close;
	// 画面から消えるときは台帳からも外す。消えた行の閉じる処理を後から呼ぶと、
	// 別の行が閉じられないまま残る。
	useEffect(() => () => { if (closeOpenedRow === closeRef.current) { closeOpenedRow = undefined; } }, []);

	/** 台帳から自分を外す。**自分が登録者のときだけ**外すこと（他の行の記録を消すと、
	    その行が開いたまま誰にも閉じられなくなる）。 */
	const unregister = useCallback(() => {
		if (closeOpenedRow === closeRef.current) {
			closeOpenedRow = undefined;
		}
	}, []);

	const settle = useCallback((next: 'open' | 'closed' | 'full') => {
		if (next === 'open') {
			if (closeOpenedRow !== undefined && closeOpenedRow !== closeRef.current) {
				closeOpenedRow();
			}
			closeOpenedRow = closeRef.current;
			setOpened(true);
			hapticSelection();
			dx.value = withSpring(toLeft ? -openDistance : openDistance, spring.swipe);
			return;
		}
		unregister();
		setOpened(false);
		dx.value = withSpring(0, spring.swipe);
		if (next === 'full') {
			hapticImpact('medium');
			fullSwipeAction?.onPress();
		}
	}, [dx, fullSwipeAction, openDistance, toLeft, unregister]);

	const runAction = useCallback((action: SwipeAction) => {
		hapticImpact('medium');
		close();
		setOpened(false);
		unregister();
		action.onPress();
	}, [close, unregister]);

	const startX = useSharedValue(0);
	const passedFull = useSharedValue(false);

	const pan = useMemo(() => Gesture.Pan()
		// 判定も含めてJSスレッドで走らせる。worklet から `runOnJS` で予約した処理は、
		// 予約した側が木から外れた後に走ると解放済みの参照を触って落ちる（worklets の
		// 既知の不具合）。片付けた行はまさにその場で消えるので、ここが最も踏みやすい。
		.runOnJS(true)
		// 閉じている間はこの向きのときだけ掴む。逆向きは触らないので、ドロワーや縦スクロールを
		// 妨げない。開いている間だけ両方向を掴んで、引き戻して閉じられるようにする。
		.activeOffsetX(opened ? [-14, 14] : toLeft ? -14 : 14)
		.failOffsetY([-12, 12])
		.onBegin(() => { startX.value = dx.value; passedFull.value = false; })
		.onUpdate(event => {
			const next = startX.value + event.translationX;
			dx.value = toLeft ? Math.min(0, Math.max(next, -limit)) : Math.max(0, Math.min(next, limit));
			if (fullSwipeAction !== undefined) {
				const past = Math.abs(dx.value) >= fullSwipeAt;
				if (past !== passedFull.value) {
					passedFull.value = past;
					// 引き切ったことを、指を離す前に手応えで返す。離してから初めて分かると
					// 「やめる」判断ができない。
					hapticSelection();
				}
			}
		})
		.onEnd(event => {
			const travelled = Math.abs(dx.value);
			const flung = toLeft ? event.velocityX < -700 : event.velocityX > 700;
			if (fullSwipeAction !== undefined && travelled >= fullSwipeAt) {
				settle('full');
				return;
			}
			settle(travelled > openDistance * 0.5 || flung ? 'open' : 'closed');
		}), [dx, startX, passedFull, toLeft, opened, limit, fullSwipeAt, fullSwipeAction, openDistance, settle]);

	const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }] }));
	// 引いた幅ぶんだけ窓を開ける。カードは定位置に置いたまま、窓の縁が指に付いてくる。
	const clipStyle = useAnimatedStyle(() => ({ width: Math.abs(dx.value) }));
	const fullStyle = useAnimatedStyle(() => ({ opacity: Math.abs(dx.value) >= fullSwipeAt ? 1 : 0 }));

	// 出すものが無いなら掴まない。掴むと、動かないのに他の行を閉じてしまう。
	if (actions.length === 0) {
		return <View style={styles.wrap}>{children}</View>;
	}

	return (
		<View style={styles.wrap}>
			<Animated.View style={[styles.clip, toLeft ? styles.clipRight : styles.clipLeft, clipStyle]}>
				<View style={[styles.cards, toLeft ? styles.cardsRight : styles.cardsLeft]}>
					{actions.map(action => (
						<Pressable
							key={action.key}
							style={({ pressed }) => [styles.card, { backgroundColor: action.color }, pressed && styles.cardPressed]}
							onPress={() => runAction(action)}
							accessibilityRole="button"
							accessibilityLabel={action.label}
						>
							<Ionicons name={action.icon} size={17} color="#fff" />
							<Text style={styles.cardText}>{action.label}</Text>
						</Pressable>
					))}
				</View>
				{fullSwipeAction !== undefined ? (
					<Animated.View
						style={[styles.full, toLeft ? styles.fullRight : styles.fullLeft, { backgroundColor: fullSwipeAction.color }, fullStyle]}
						pointerEvents="none"
					>
						<Ionicons name={fullSwipeAction.icon} size={17} color="#fff" />
						<Text style={styles.cardText}>{fullSwipeAction.label}</Text>
					</Animated.View>
				) : null}
			</Animated.View>
			<GestureDetector gesture={pan}>
				<Animated.View style={rowStyle}>{children}</Animated.View>
			</GestureDetector>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { position: 'relative' },
	// 行（agentRowStyles.container）の下マージン8ぶんを避け、行と同じ高さに揃える。
	clip: { position: 'absolute', top: 0, bottom: 8, overflow: 'hidden' },
	clipRight: { right: 0 },
	clipLeft: { left: 0 },
	// カードは窓の中で定位置に固定する。窓ごと動かすと、指の速さでカードが流れて読めない。
	cards: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row', gap: CARD_GAP },
	cardsRight: { right: 0 },
	cardsLeft: { left: 0 },
	card: {
		width: CARD_WIDTH, alignItems: 'center', justifyContent: 'center', gap: 5,
		borderRadius: radius.card, ...squircle,
	},
	cardPressed: { opacity: 0.72 },
	cardText: { color: '#fff', fontSize: 11, fontWeight: '700' },
	// 引き切ったときに窓いっぱいへ広がる面。中身は行に近い側へ寄せる（指の先に付いてくる）。
	full: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: radius.card, ...squircle },
	fullRight: { justifyContent: 'flex-end', paddingRight: 26 },
	fullLeft: { justifyContent: 'flex-start', paddingLeft: 26 },
});

/** スワイプのアクション面の色。危険なものだけ赤で、他は地の濃さで段階を付ける。 */
export const swipeActionColors = {
	neutral: '#3a3a44',
	strong: '#4a4a56',
	// 面としての赤。文字色の red をそのまま地に使うと明るすぎて、白抜きの文字が読めない。
	destructive: '#c0413f',
} as const;
