// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	Animated,
	Easing,
	Keyboard,
	LayoutAnimation,
	Modal,
	PanResponder,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	View,
	useWindowDimensions,
	type KeyboardEvent,
} from 'react-native';
import { keyboardCoverage } from '../keyboardCoverage.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { colors, radius, space } from '../theme.js';

/**
 * 下から出るシート（Orca の BottomDrawer）。エージェントの起動・名前の変更・削除の確認・
 * 選択肢など、画面の上に一時的に出すものは全部この上に作る（中央に出るダイアログは使わない）。
 *
 * 見た目は Orca / モック（concept-orca.html の `.drawer`）どおり:
 *  - 地は `colors.bg`、上端の角丸 16、左右の余白 12
 *  - 上につまみ（36×4、弱い灰を 40%）。つまみの帯を下へ引くと付いてきて、離した位置か速さで閉じる
 *  - 中身が上端までスクロールされているときは、中身を下へ引いても閉じられる
 *  - 背後に 50% の黒い幕。幕を押すと閉じる
 *  - キーボードが出ると、覆った分だけシートを持ち上げる（判定は既存の `keyboardCoverage`）
 *  - iPad などの広い幅では幅を 480pt に抑えて中央に置く
 *
 * 実装の約束（既存の `src/components/bottomSheet.tsx` で踏んだものを引き継ぐ）:
 *  - ジェスチャは `PanResponder`（素の JS）。RNGH は Modal の中に別の GestureHandlerRootView が要るうえ、
 *    worklet から予約した処理は予約元が木から外れた後に走ると落ちる
 *  - 閉じる動きが終わってから木から外し、そのあとで `onAfterClose` を呼ぶ。
 *    **別のシートを開く・画面を移るのは `onAfterClose` で行う。** 閉じる途中で次のネイティブの
 *    モーダルを出すと iOS が取りこぼし、画面を移ると最初のタップが幕に吸われる
 */

/** 開く・閉じる動きの長さ（ms）。モックの値。 */
const OPEN_MS = 300;
const CLOSE_MS = 220;
/** ここまで引き下げたら閉じる（pt）。速さ（pt/ms）が乗っていればこれ未満でも閉じる。 */
const DISMISS_DISTANCE = 80;
const DISMISS_VELOCITY = 0.5;
/** 上へ引いたときは付いてこさせず、この割合だけ動かす（それ以上は広がらない合図）。 */
const RUBBER_BAND = 0.25;
/** 幕がドラッグで薄れていく距離（pt）。 */
const BACKDROP_FADE_DISTANCE = 300;
/** 広い幅でのシートの最大幅（pt。Orca の modalMaxWidth）。 */
const WIDE_MAX_WIDTH = 480;
/** つまみの大きさ（pt）。 */
const HANDLE_WIDTH = 36;
const HANDLE_HEIGHT = 4;
/** 中身のスクロールが上端にあるとみなす誤差（pt）。 */
const TOP_SCROLL_EPSILON = 1;
/** 引き始めとみなす縦の移動量（pt）。 */
const DRAG_SLOP = 8;

/** iOS のキーボードが画面の下からどれだけ覆っているか（pt）。 */
function useKeyboardInset(active: boolean): number {
	const [inset, setInset] = useState(0);
	const windowHeight = useWindowDimensions().height;
	useEffect(() => {
		if (!active || Platform.OS !== 'ios') {
			setInset(0);
			return undefined;
		}
		const apply = (next: number, event: KeyboardEvent) => {
			setInset(current => {
				if (current === next) {
					return current;
				}
				LayoutAnimation.configureNext({
					duration: event.duration > 0 ? event.duration : 250,
					update: { type: 'keyboard' },
				});
				return next;
			});
		};
		const change = Keyboard.addListener('keyboardWillChangeFrame', event => {
			apply(keyboardCoverage(event.endCoordinates, windowHeight), event);
		});
		const hide = Keyboard.addListener('keyboardWillHide', event => apply(0, event));
		return () => {
			change.remove();
			hide.remove();
		};
	}, [active, windowHeight]);
	return inset;
}

export interface BottomDrawerProps {
	readonly visible: boolean;
	/** 幕・つまみ・引き下げ・Android の戻るで呼ばれる。親は `visible` を false にする。 */
	readonly onClose: () => void;
	/** 閉じる動きが終わって木から外れた後に1回呼ばれる。次のシートを開く・画面を移るのはここで。 */
	readonly onAfterClose?: () => void;
	readonly children: ReactNode;
	/** 中身をスクロールさせるか（既定 true）。中に自前の一覧（FlatList など）を置くときは false。 */
	readonly scrollable?: boolean;
	/** 読み上げでシートを何と呼ぶか。 */
	readonly accessibilityLabel?: string;
	readonly testID?: string;
}

export function BottomDrawer({ visible, onClose, onAfterClose, children, scrollable = true, accessibilityLabel, testID }: BottomDrawerProps) {
	const [mounted, setMounted] = useState(visible);
	// 開くときは描画の前に木へ入れる（effect を待つと、空の1フレームを挟んでから動き出す）。
	if (visible && !mounted) {
		setMounted(true);
	}

	const progress = useRef(new Animated.Value(0)).current;
	const drag = useRef(new Animated.Value(0)).current;
	const scrollOffset = useRef(0);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onAfterCloseRef = useRef(onAfterClose);
	onAfterCloseRef.current = onAfterClose;

	const insets = useStableInsets();
	const { height: windowHeight } = useWindowDimensions();
	const wide = useIsRegularWidth();
	const keyboardInset = useKeyboardInset(visible);

	useEffect(() => {
		if (visible) {
			drag.setValue(0);
			scrollOffset.current = 0;
			const open = Animated.timing(progress, { toValue: 1, duration: OPEN_MS, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true });
			open.start();
			return () => open.stop();
		}
		if (!mounted) {
			return undefined;
		}
		Keyboard.dismiss();
		const close = Animated.timing(progress, { toValue: 0, duration: CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true });
		// 途中で止められた（開き直した・親ごと消えた）ときは finished が false になり、何もしない。
		close.start(({ finished }) => {
			if (!finished) {
				return;
			}
			setMounted(false);
			onAfterCloseRef.current?.();
		});
		return () => close.stop();
	}, [visible, mounted, progress, drag]);

	const panHandlers = useMemo(() => {
		const follow = (dy: number) => drag.setValue(dy > 0 ? dy : dy * RUBBER_BAND);
		const settle = (dy: number, vy: number) => {
			if (dy > DISMISS_DISTANCE || vy > DISMISS_VELOCITY) {
				onCloseRef.current();
				return;
			}
			Animated.spring(drag, { toValue: 0, damping: 28, stiffness: 400, mass: 1, useNativeDriver: true }).start();
		};
		const snapBack = () => Animated.spring(drag, { toValue: 0, damping: 28, stiffness: 400, mass: 1, useNativeDriver: true }).start();
		const handle = PanResponder.create({
			onStartShouldSetPanResponder: () => false,
			onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > DRAG_SLOP / 2 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
			onPanResponderMove: (_event, gesture) => follow(gesture.dy),
			onPanResponderRelease: (_event, gesture) => settle(gesture.dy, gesture.vy),
			onPanResponderTerminate: snapBack,
		});
		// 中身: 上端までスクロールされていて、下へ引いたときだけスクロールから奪う。
		const content = PanResponder.create({
			onStartShouldSetPanResponder: () => false,
			onMoveShouldSetPanResponderCapture: (_event, gesture) =>
				scrollOffset.current <= TOP_SCROLL_EPSILON && gesture.dy > DRAG_SLOP && Math.abs(gesture.dy) > Math.abs(gesture.dx),
			onPanResponderMove: (_event, gesture) => follow(gesture.dy),
			onPanResponderRelease: (_event, gesture) => settle(gesture.dy, gesture.vy),
			onPanResponderTerminate: snapBack,
		});
		return { handle: handle.panHandlers, content: content.panHandlers };
	}, [drag]);

	if (!mounted) {
		return null;
	}

	const translateY = Animated.add(
		progress.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0], extrapolate: 'clamp' }),
		drag,
	);
	const backdropOpacity = Animated.multiply(
		progress,
		drag.interpolate({ inputRange: [0, BACKDROP_FADE_DISTANCE], outputRange: [1, 0], extrapolate: 'clamp' }),
	);
	const lifted = keyboardInset > 0;
	const maxHeight = Math.max(0, windowHeight - insets.top - space.lg - keyboardInset);

	return (
		<Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={() => onCloseRef.current()}>
			<Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
				<Pressable style={StyleSheet.absoluteFill} onPress={() => onCloseRef.current()} accessibilityRole="button" accessibilityLabel="閉じる" />
			</Animated.View>
			<View style={[styles.anchor, wide ? styles.anchorWide : undefined, { paddingBottom: keyboardInset }]} pointerEvents="box-none">
				<Animated.View
					testID={testID}
					accessibilityViewIsModal
					accessibilityLabel={accessibilityLabel}
					style={[
						styles.drawer,
						{
							maxHeight,
							maxWidth: wide ? WIDE_MAX_WIDTH : undefined,
							paddingBottom: lifted ? space.sm : Math.max(insets.bottom, space.lg),
							transform: [{ translateY }],
						},
					]}
				>
					<View style={styles.handleArea} {...panHandlers.handle} accessibilityRole="button" accessibilityLabel="シートを閉じる" onAccessibilityTap={() => onCloseRef.current()}>
						<View style={styles.handle} />
					</View>
					{scrollable ? (
						<View style={styles.contentWrap} {...panHandlers.content}>
							<ScrollView
								bounces={false}
								keyboardShouldPersistTaps="handled"
								showsVerticalScrollIndicator={false}
								scrollEventThrottle={16}
								onScroll={event => { scrollOffset.current = Math.max(0, event.nativeEvent.contentOffset.y); }}
							>
								{children}
							</ScrollView>
						</View>
					) : (
						<View style={styles.contentStatic}>{children}</View>
					)}
					{/* ばねで持ち上がりすぎたときに下の隙間を見せないための延長。 */}
					<View style={styles.bottomExtension} pointerEvents="none" />
				</Animated.View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	backdrop: {
		position: 'absolute',
		top: 0,
		right: 0,
		bottom: 0,
		left: 0,
		backgroundColor: colors.scrim,
	},
	anchor: {
		flex: 1,
		justifyContent: 'flex-end',
	},
	anchorWide: {
		alignItems: 'center',
	},
	drawer: {
		width: '100%',
		backgroundColor: colors.bg,
		borderTopLeftRadius: radius.sheet,
		borderTopRightRadius: radius.sheet,
		paddingHorizontal: space.md,
		shadowColor: colors.shadow,
		shadowOffset: { width: 0, height: -2 },
		shadowOpacity: 0.2,
		shadowRadius: 10,
		elevation: 8,
	},
	handleArea: {
		alignItems: 'center',
		paddingTop: space.sm,
		paddingBottom: space.md,
	},
	handle: {
		width: HANDLE_WIDTH,
		height: HANDLE_HEIGHT,
		borderRadius: radius.pill,
		backgroundColor: colors.textMuted,
		opacity: 0.4,
	},
	contentWrap: {
		flexShrink: 1,
		minHeight: 0,
	},
	contentStatic: {
		flexShrink: 1,
		minHeight: 0,
	},
	bottomExtension: {
		position: 'absolute',
		left: 0,
		right: 0,
		bottom: -500,
		height: 500,
		backgroundColor: colors.bg,
	},
});
