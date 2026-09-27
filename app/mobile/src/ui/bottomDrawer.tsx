// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Gesture, GestureDetector, GestureHandlerRootView, type PanGesture } from 'react-native-gesture-handler';
import {
	Animated,
	Easing,
	Keyboard,
	LayoutAnimation,
	Modal,
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
import { useShortcutSlot } from '../ipad/shortcutRegistry.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { HIT_SIZE, colors, radius, space } from '../theme.js';
import {
	backdropFadeDistance,
	dragOffset,
	shouldDismissDrag,
} from './drawerDrag.js';

/**
 * 下から出るシート（Orca の BottomDrawer）。エージェントの起動・名前の変更・削除の確認・
 * 選択肢など、画面の上に一時的に出すものは全部この上に作る（中央に出るダイアログは使わない）。
 *
 * 見た目は Orca / モック（concept-orca.html の `.drawer`）どおり:
 *  - 地は `colors.bg`、上端の角丸 16、左右の余白 12
 *  - 上につまみ（36×4、弱い灰を 40%）。つまみの帯（高さ 44pt）と見出しの行（`DrawerTitle` /
 *    `DrawerCaption`）を下へ引くと指に付いてきて、離した位置か速さで閉じる
 *  - 中身が上端までスクロールされているときは、中身を下へ引いても閉じられる
 *  - 背後に 50% の黒い幕。幕を押すと閉じる。引き下げた量に応じて薄くなる
 *  - キーボードが出ると、覆った分だけシートを持ち上げる（判定は既存の `keyboardCoverage`）
 *  - iPad などの広い幅では幅を 480pt に抑えて中央に置く
 *
 * 実装の約束（既存の `src/components/bottomSheet.tsx` で踏んだものを引き継ぐ）:
 *  - ジェスチャは react-native-gesture-handler（理由は buildGrabGesture のコメント）。Modal は別の画面として
 *    出るので、中に GestureHandlerRootView を置き直す。コールバックは JS で走らせる（runOnJS）
 *  - 中身がスクロールするシートは、上端でさらに下へ引いた跳ね返りの量で閉じる（中身のスクロールと
 *    シートのドラッグを取り合わせない）
 *  - **位置は1つの値（`offset`、下げた量 pt）だけで持つ。** 開閉のアニメーションもドラッグの
 *    `setValue` もばねの戻りも、同じ値を動かす。開閉用の値とドラッグ用の値を `Animated.add` で足す形にしない
 *  - 閉じる動きが終わってから木から外し、そのあとで `onAfterClose` を呼ぶ。
 *    **別のシートを開く・画面を移るのは `onAfterClose` で行う。** 閉じる途中で次のネイティブの
 *    モーダルを出すと iOS が取りこぼし、画面を移ると最初のタップが幕に吸われる
 */

/** 開く・閉じる動きの長さ（ms）。モックの値。 */
const OPEN_MS = 300;
const CLOSE_MS = 220;
/** 広い幅でのシートの最大幅（pt。Orca の modalMaxWidth）。 */
const WIDE_MAX_WIDTH = 480;
/** つまみの大きさ（pt）。 */
const HANDLE_WIDTH = 36;
const HANDLE_HEIGHT = 4;
/** 縦にこれだけ動いたら掴んだとみなす／横にこれだけ動いたら諦める（pt）。 */
const DRAG_ACTIVATE = 6;
const DRAG_FAIL_X = 24;
/** 中身を上端より下へ引いて離したとき、ここを超えていれば閉じる（pt。スクロールの跳ね返り量）。 */
const CONTENT_PULL_DISMISS = 70;
/** 離したあと元の位置へ戻るばね。 */
const SNAP_BACK_SPRING = { damping: 28, stiffness: 400, mass: 1 } as const;

/** 掴んだときの動き（シート本体が持つ）。見出しの行が自分の GestureDetector を作るために受け取る。 */
interface DrawerGrabCallbacks {
	readonly begin: () => void;
	readonly update: (dy: number) => void;
	readonly end: (dy: number, vyPerMs: number, completed: boolean) => void;
}

/** 見出しの行（`DrawerTitle` / `DrawerCaption`）をつまみと同じように掴めるようにするための受け渡し。 */
const DrawerGrabContext = createContext<DrawerGrabCallbacks | undefined>(undefined);

/**
 * 縦のドラッグでシートを動かすジェスチャ。
 *
 * **PanResponder ではなく react-native-gesture-handler を使う。** 実機（iOS 26・Fabric）で、Modal の中の
 * PanResponder は指を置いた瞬間（onStartShouldSetResponder）までは呼ばれるのに、動かしたときの
 * onMoveShouldSetResponder が一度も呼ばれず、指に付いてこなかった（生の onTouchMove は届いていた）。
 * コールバックは JS で走らせ（runOnJS）、worklet から予約した処理が木から外れた後に走る問題を避ける。
 * 横に大きく動いたら諦め、中のボタンのタップは縦に動き出すまで妨げない。
 */
function buildGrabGesture(callbacks: DrawerGrabCallbacks): PanGesture {
	return Gesture.Pan()
		.runOnJS(true)
		.activeOffsetY([-DRAG_ACTIVATE, DRAG_ACTIVATE])
		.failOffsetX([-DRAG_FAIL_X, DRAG_FAIL_X])
		.onStart(() => callbacks.begin())
		.onUpdate(event => callbacks.update(event.translationY))
		// velocityY は pt/秒。判定（shouldDismissDrag）は pt/ms で持っている。
		.onEnd((event, success) => callbacks.end(event.translationY, event.velocityY / 1000, success));
}

/** シートの中で「ここも掴める」ようにしたい行が使うジェスチャ。シートの外では undefined。 */
export function useDrawerGrabGesture(): PanGesture | undefined {
	const callbacks = useContext(DrawerGrabContext);
	// manual-memo: audited — ジェスチャを描画ごとに作り直すと、掴んでいる最中に差し替わってドラッグが途切れるため
	return useMemo(() => (callbacks === undefined ? undefined : buildGrabGesture(callbacks)), [callbacks]);
}

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

	const insets = useStableInsets();
	const { height: windowHeight } = useWindowDimensions();
	const wide = useIsRegularWidth();
	const keyboardInset = useKeyboardInset(visible);
	// 閉じた位置（下げた量）。画面の高さぶん下げれば必ず画面外。
	const hiddenOffset = windowHeight;

	/** シートを下げている量（pt）。0 で開ききり、`hiddenOffset` で画面外。位置はこの1つの値だけで持つ。 */
	const offset = useRef(new Animated.Value(hiddenOffset)).current;
	/** 閉じきって木から外れた状態か。開き直すときに画面外から始めるかどうかの判定に使う。 */
	const closed = useRef(true);
	const [sheetHeight, setSheetHeight] = useState(0);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onAfterCloseRef = useRef(onAfterClose);
	onAfterCloseRef.current = onAfterClose;
	// 外付けキーボードの Esc で閉じる（iPad）。重なっていれば上のシートから。
	useShortcutSlot('escape', visible ? { escape: () => onCloseRef.current() } : undefined);

	useEffect(() => {
		if (visible) {
			if (closed.current) {
				closed.current = false;
				offset.setValue(hiddenOffset);
			}
			const open = Animated.timing(offset, { toValue: 0, duration: OPEN_MS, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true });
			open.start();
			return () => open.stop();
		}
		if (!mounted) {
			return undefined;
		}
		Keyboard.dismiss();
		// 引き下げて離したときは、その位置から続けて下ろす（値が1つなので途切れない）。
		const close = Animated.timing(offset, { toValue: hiddenOffset, duration: CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true });
		// 途中で止められた（開き直した・親ごと消えた）ときは finished が false になり、何もしない。
		close.start(({ finished }) => {
			if (!finished) {
				return;
			}
			closed.current = true;
			setMounted(false);
			onAfterCloseRef.current?.();
		});
		return () => close.stop();
	}, [visible, mounted, offset, hiddenOffset]);

	// manual-memo: audited — ジェスチャの受け渡し先（見出しの行）が参照の同一性で作り直しを判断するため
	const grab = useMemo<DrawerGrabCallbacks>(() => {
		const snapBack = () => Animated.spring(offset, { toValue: 0, ...SNAP_BACK_SPRING, useNativeDriver: true }).start();
		return {
			begin: () => offset.stopAnimation(),
			update: dy => offset.setValue(dragOffset(dy)),
			end: (dy, vy, completed) => {
				if (completed && shouldDismissDrag(dy, vy)) {
					// 親が visible を false にすると、閉じる動きが今の位置から続く。
					onCloseRef.current();
					return;
				}
				snapBack();
			},
		};
	}, [offset]);
	// manual-memo: audited — つまみの GestureDetector に渡すジェスチャ。描画ごとに作り直すとドラッグが途切れるため
	const handleGesture = useMemo(() => buildGrabGesture(grab), [grab]);

	if (!mounted) {
		return null;
	}

	const backdropOpacity = offset.interpolate({
		inputRange: [0, backdropFadeDistance(sheetHeight)],
		outputRange: [1, 0],
		extrapolate: 'clamp',
	});
	const lifted = keyboardInset > 0;
	const maxHeight = Math.max(0, windowHeight - insets.top - space.lg - keyboardInset);

	return (
		<Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={() => onCloseRef.current()}>
			{/* Modal は別の画面として出るので、ジェスチャの根をここに置き直す（アプリの根のものは届かない）。 */}
			<GestureHandlerRootView style={styles.gestureRoot}>
			<Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
				<Pressable style={StyleSheet.absoluteFill} onPress={() => onCloseRef.current()} accessibilityRole="button" accessibilityLabel="閉じる" />
			</Animated.View>
			<View style={[styles.anchor, wide ? styles.anchorWide : undefined, { paddingBottom: keyboardInset }]} pointerEvents="box-none">
				<Animated.View
					testID={testID}
					accessibilityViewIsModal
					accessibilityLabel={accessibilityLabel}
					onLayout={event => setSheetHeight(Math.round(event.nativeEvent.layout.height))}
					style={[
						styles.drawer,
						{
							maxHeight,
							maxWidth: wide ? WIDE_MAX_WIDTH : undefined,
							paddingBottom: lifted ? space.sm : Math.max(insets.bottom, space.lg),
							transform: [{ translateY: offset }],
						},
					]}
				>
					<GestureDetector gesture={handleGesture}>
						<View style={styles.handleArea} accessibilityRole="button" accessibilityLabel="シートを閉じる" onAccessibilityTap={() => onCloseRef.current()}>
							<View style={styles.handle} />
						</View>
					</GestureDetector>
					<DrawerGrabContext.Provider value={grab}>
						{scrollable ? (
							<View style={styles.contentWrap}>
								<ScrollView
									// 上端でさらに下へ引くと跳ね返りで中身が下がる。離したときに十分引いていれば閉じる
									// （中身のスクロールとシートのドラッグを取り合わせないため、中身の側はこの形にしている）。
									bounces
									alwaysBounceVertical={false}
									onScrollEndDrag={event => {
										if (event.nativeEvent.contentOffset.y < -CONTENT_PULL_DISMISS) {
											onCloseRef.current();
										}
									}}
									keyboardShouldPersistTaps="handled"
									showsVerticalScrollIndicator={false}
									scrollEventThrottle={16}
								>
									{children}
								</ScrollView>
							</View>
						) : (
							<View style={styles.contentStatic}>{children}</View>
						)}
					</DrawerGrabContext.Provider>
					{/* ばねで持ち上がりすぎたときに下の隙間を見せないための延長。 */}
					<View style={styles.bottomExtension} pointerEvents="none" />
				</Animated.View>
			</View>
			</GestureHandlerRootView>
		</Modal>
	);
}

const styles = StyleSheet.create({
	gestureRoot: {
		flex: 1,
	},
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
	// 掴める帯は指で確実に捉えられる高さ（44pt）にし、つまみはその中央に置く。
	handleArea: {
		height: HIT_SIZE,
		alignItems: 'center',
		justifyContent: 'center',
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
