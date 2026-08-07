// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, KeyboardEvent, LayoutAnimation, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface } from './glassSurface.js';
import { HeaderEdgeFade } from './headerEdgeFade.js';
import { colors, squircle } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import { keyboardCoverage } from '../keyboardCoverage.js';
import { screenCornerRadius } from '../screenCornerRadius.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { useStableInsets } from '../hooks/useStableInsets.js';

/** iPadの広い幅でシートを中央寄せするときの最大幅（pt）。 */
const SHEET_MAX_WIDTH = 640;

/**
 * ハーフシートを画面の縁から浮かせる量（pt）。
 *
 * iOS 26 のハーフシートは四辺が浮いていて、その隙間から背後の内容が覗く
 * （Apple: “half sheets are inset from the edge of the display to allow content to
 * peek through from beneath them”）。浮かせること自体が意味を持つので、
 * 隙間を詰めすぎない。
 */
const SHEET_INSET = 8;

/** シート上端の角丸。 */
const SHEET_TOP_RADIUS = 38;

/**
 * シート下端の角丸。**ディスプレイの角と同心**にする（外の半径 − 余白 ＝ 内の半径）。
 *
 * 浮かせると下の2角がちょうど端末の角の内側に入るので、ここが同心でないと
 * 角の曲がり始めが食い違って「別のOSの部品」に見える。角丸を取得できない環境
 * （Androidの角丸なし端末など）では上端と同じ値にする。
 */
const SHEET_BOTTOM_RADIUS = screenCornerRadius > 0
	? Math.max(SHEET_TOP_RADIUS, screenCornerRadius - SHEET_INSET)
	: SHEET_TOP_RADIUS;

/** 高さの上限（画面比）。 */
const SHEET_MAX_RATIO = 0.72;

/** ここまで引き下げたら閉じる（pt）。速度が乗っていればこれ未満でも閉じる。 */
const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 0.8;

/**
 * ボトムシート共通コンポーネント。
 *
 * **器（出方・形・掴めるか）はここが1箇所で持つ**ので、ここを直すと並び替え・音声通知・
 * 送信予定・モデルとEffort・エージェント情報・スペース作成が一度に変わる。
 *
 * iOS 26 に合わせて:
 *  - 四辺を {@link SHEET_INSET} 浮かせ、全周を丸める（下2角はディスプレイと同心）
 *  - 出入りは**ばね**。距離は**実測したシートの高さ**を使う（固定値だと、低いシートが
 *    画面外はるか下から飛んできて、高いシートは最初から半分見えた状態で始まる）
 *  - グラバーは**実際に掴める**。下へ引くとシートが付いてきて、離した位置か速度で閉じる
 *  - 上端に scroll edge effect を敷いて、スクロール中の行がタイトルの真下で硬く切れないようにする
 *
 * キーボード対応: シートは画面下端に固定されているため、シート内のKeyboardAvoidingViewでは
 * シート自体が持ち上がらず、下部の入力欄がキーボードに完全に隠れる。iOSではキーボードの
 * 実フレーム（keyboardWillChangeFrame）を監視してシートの bottom をその高さぶん持ち上げ、
 * 併せて maxHeight を残りの表示領域に収まるよう縮める。どれだけ覆っているかの判定は
 * `keyboardCoverage`（小さなアクセサリバーやiPadのフローティングキーボードを除外する）
 * に任せ、useKeyboardVisible と同じ規則で揃える。
 * AndroidはwindowSoftInputMode=adjustResizeがModalごと縮めるため何もしない。
 *
 * **ガラスについて**: 面は `glass` を渡したときだけ {@link GlassSurface}（iOS 26+ は
 * 本物の Liquid Glass）になる。ドラッグは `transform` だけを動かし、**祖先の `opacity` は
 * 絶対にアニメーションさせない**——ガラスは不透明度を0にすると効果ごと死ぬため、
 * ここに opacity のフェードを足した瞬間に面が消える（暗幕は別の兄弟なので影響しない）。
 * ジェスチャは RNGH ではなく `PanResponder` を使う。RNGH は `Modal` の中では別の
 * `GestureHandlerRootView` が要るうえ、worklet 経由の予約は「予約元が消える場所」で
 * 落ちる既知の不具合を踏む（swipeRow.tsx のコメント参照）。ここは素のJSで足りる。
 */

/** iOSのキーボード被覆高さ（画面下端から）。シートの持ち上げ量に使う。 */
function useKeyboardInset(): number {
	const [inset, setInset] = useState(0);
	const windowHeight = useWindowDimensions().height;
	useEffect(() => {
		if (Platform.OS !== 'ios') {
			return;
		}
		const applyInset = (next: number, event: KeyboardEvent) => {
			setInset(current => {
				if (current === next) {
					return current;
				}
				// キーボードのアニメーションカーブに合わせてレイアウト変化を滑らかにする
				LayoutAnimation.configureNext({
					duration: event.duration > 0 ? event.duration : 250,
					update: { type: 'keyboard' },
				});
				return next;
			});
		};
		const change = Keyboard.addListener('keyboardWillChangeFrame', event => {
			// iPadのフローティングキーボードは下端を覆わない。素朴に screenY から
			// 引くと数百pt持ち上げてしまい、シートが画面外へ消える。
			applyInset(keyboardCoverage(event.endCoordinates, windowHeight), event);
		});
		const hide = Keyboard.addListener('keyboardWillHide', event => applyInset(0, event));
		return () => {
			change.remove();
			hide.remove();
		};
	}, [windowHeight]);
	return inset;
}

export function BottomSheet({ visible, onClose, onConfirm, title, children, fullHeight = false, glass = false }: {
	visible: boolean;
	/** 背景タップ・Androidバックボタン・（onConfirm未指定時は唯一の）閉じるボタンで呼ばれる「キャンセル」。 */
	onClose: () => void;
	/** 指定するとヘッダーが左✕（キャンセル=onClose）／右✓（確定）の2ボタン構成になる。未指定なら従来通り右上✕のみ。 */
	onConfirm?: () => void;
	title: string;
	children: ReactNode;
	/** 既定は高さ72%固定。trueにするとセーフエリア上端まで広げたほぼ全画面表示になる（通知一覧など）。 */
	fullHeight?: boolean;
	/** モーダル単位でLiquid Glassを有効化する。内部の操作要素は不透明のままにする。 */
	glass?: boolean;
}) {
	const anim = useRef(new Animated.Value(0)).current;
	const [mounted, setMounted] = useState(visible);
	const insets = useStableInsets();
	const keyboardInset = useKeyboardInset();
	const { height: windowHeight, width: windowWidth } = useWindowDimensions();
	// iPadの広い幅では画面いっぱいのシートにせず、中央へ寄せた読みやすい幅に収める
	// （純正のフォームシートと同じ考え方。左右いっぱいだと1行が長く、操作も端まで散らばる）。
	const regular = useIsRegularWidth();
	const sideInset = regular ? Math.max(SHEET_INSET, Math.round((windowWidth - SHEET_MAX_WIDTH) / 2)) : SHEET_INSET;

	// 全高まで広げるシートは端まで使い、**不透明**にする
	// （Apple: “When a half sheet expands to full height, it transitions to a more opaque
	// appearance to help maintain focus on the task.”）。ガラスはハーフシートのときだけ。
	const inset = !fullHeight;
	const glassEnabled = glass && !fullHeight;

	// スライド量は**実測したシートの高さ**。測る前は画面の高さを使う（必ず画面外から始まる）。
	const [sheetHeight, setSheetHeight] = useState(0);
	// グラバー＋見出しの高さ。本文の上端に落とす影をここへ揃える。
	const [headHeight, setHeadHeight] = useState(62);
	// 位置が「物理下端から SHEET_INSET」なので、送り出す距離も同じ基準にする
	// （`insets.bottom` を足すと 34pt 余分に動く。中身側の `paddingBottom` が
	// ホームインジケータぶんを既に持っているため、位置の側は素の8ptでよい）。
	const travel = sheetHeight > 0 ? sheetHeight + SHEET_INSET : windowHeight;

	const maxHeight = keyboardInset > 0
		? Math.max(240, Math.min(windowHeight * SHEET_MAX_RATIO, windowHeight - keyboardInset - insets.top - 12))
		: windowHeight * SHEET_MAX_RATIO;

	useEffect(() => {
		if (visible) {
			setMounted(true);
			// **高さを測るまで動かさない。** `travel` は実測前は画面の高さなので、
			// そのままばねを始めると1〜2フレーム後に出力レンジが実寸（半分以下）へ
			// 差し替わり、シートが画面外から画面中央付近へ跳ぶ（各シートの初回だけ起きる）。
			if (sheetHeight === 0) {
				return;
			}
			// 開くときだけ少し行き過ぎて戻る。縮む方向のオーバーシュートは
			// 目標より小さく凹んで見えて気持ち悪いので、閉じは弾ませない。
			Animated.spring(anim, { toValue: 1, speed: 14, bounciness: 6, useNativeDriver: true }).start();
		} else {
			Animated.timing(anim, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true })
				.start(({ finished }) => { if (finished) { setMounted(false); } });
		}
	}, [visible, anim, sheetHeight]);

	// グラバー（と見出しの帯）を下へ引くと、シートが指に付いてくる。
	// `anim` そのものを動かすので、離したときの戻りも開閉と同じ1本の値で扱える。
	const pan = useMemo(() => PanResponder.create({
		// タップは見出しのボタンへ通す。縦に動き始めたときだけ掴む。
		onStartShouldSetPanResponder: () => false,
		onMoveShouldSetPanResponder: (_event, gesture) =>
			gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
		onPanResponderMove: (_event, gesture) => {
			const progress = 1 - Math.max(0, gesture.dy) / Math.max(1, travel);
			anim.setValue(Math.max(0, Math.min(1, progress)));
		},
		onPanResponderRelease: (_event, gesture) => {
			// 離した位置だけで決めない。速く短く払ったときに戻ってしまう。
			if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
				hapticImpact('light');
				onClose();
				return;
			}
			Animated.spring(anim, { toValue: 1, speed: 16, bounciness: 4, useNativeDriver: true }).start();
		},
		onPanResponderTerminate: () => {
			Animated.spring(anim, { toValue: 1, speed: 16, bounciness: 4, useNativeDriver: true }).start();
		},
	}), [anim, travel, onClose]);

	if (!mounted) {
		return null;
	}

	const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [travel, 0], extrapolate: 'clamp' });

	const radiusStyle = inset
		? {
			borderTopLeftRadius: SHEET_TOP_RADIUS, borderTopRightRadius: SHEET_TOP_RADIUS,
			borderBottomLeftRadius: SHEET_BOTTOM_RADIUS, borderBottomRightRadius: SHEET_BOTTOM_RADIUS,
			...squircle,
		}
		: { borderTopLeftRadius: 28, borderTopRightRadius: 28, ...squircle };

	const head = onConfirm ? (
		<>
			<Pressable style={styles.headerBtn} onPress={() => { hapticImpact('light'); onClose(); }} accessibilityRole="button" accessibilityLabel="キャンセル">
				<Ionicons name="close" size={16} color={colors.textDim} />
			</Pressable>
			<Text style={styles.title}>{title}</Text>
			<Pressable style={[styles.headerBtn, styles.confirmBtn]} onPress={() => { hapticImpact('light'); onConfirm(); }} accessibilityRole="button" accessibilityLabel="確定">
				<Ionicons name="checkmark" size={16} color={colors.bg} />
			</Pressable>
		</>
	) : (
		<>
			<Text style={styles.title}>{title}</Text>
			<Pressable style={styles.close} onPress={() => { hapticImpact('light'); onClose(); }} accessibilityLabel="閉じる">
				<Ionicons name="close" size={14} color={colors.textDim} />
			</Pressable>
		</>
	);

	return (
		<Modal visible transparent animationType="none" onRequestClose={onClose}>
			<Animated.View style={[StyleSheet.absoluteFill, styles.overlay, { opacity: anim }]}>
				<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="閉じる" />
			</Animated.View>
			{/* 外枠は影のためだけの層。影は `overflow: 'hidden'` と同じ要素に置くと
			    切り抜かれて消えるので、切り抜かない側へ分けている。 */}
			<Animated.View
				style={[
					styles.shadow,
					radiusStyle,
					inset
						? { left: sideInset, right: sideInset, bottom: keyboardInset + SHEET_INSET }
						: { left: 0, right: 0, bottom: keyboardInset },
					fullHeight ? { top: insets.top } : undefined,
					// ガラスのときは地色を透かす。ここに不透明の地が残るとガラスが死ぬ。
					// 影は素材の縁より外側に落ちるので、透かしても輪郭の分離は保てる。
					glassEnabled ? styles.shadowGlass : undefined,
					{ transform: [{ translateY }] },
				]}
				pointerEvents="box-none"
			>
				<View
					style={[
						styles.sheet,
						radiusStyle,
						fullHeight ? styles.sheetFill : { maxHeight },
						glassEnabled ? styles.glassSheet : undefined,
					]}
					onLayout={event => setSheetHeight(Math.round(event.nativeEvent.layout.height))}
				>
					{/* 輪郭はシート自身の枠線（全周）が持つので、素材側では描かない。
					    両方描くと非対応環境で1px の二重線になる。逆に言うと、
					    `styles.sheet` の `borderWidth` を外すと「透明度を下げる」設定で
					    浮いたシートの輪郭が完全に消えるので、外さないこと。 */}
					{glassEnabled ? <GlassSurface style={[StyleSheet.absoluteFill, radiusStyle]} fallbackBorder={false} /> : null}
					{/* 掴める帯。グラバーだけでなく見出しの行まで含める（純正のシートと同じ）。 */}
					<View {...pan.panHandlers} onLayout={event => setHeadHeight(Math.round(event.nativeEvent.layout.height))}>
						<View style={styles.handle} />
						<View style={styles.head}>{head}</View>
					</View>
					{/* 本文の上端に影を落とす。無いとスクロール中の行が見出しの真下で硬く切れる。
					    **地色（不透明）を敷いてはいけない**——ガラスの上に濃い灰色の帯が乗って
					    素材が死ぬ。薄い黒なら、ガラスでも不透明でも「奥へ入っていく」だけになる。
					    位置は見出しの実測値。手計算の固定値だと Dynamic Type で文字が伸びたときに
					    帯が見出しの内側へ食い込む。 */}
					<View style={[styles.topFade, { top: headHeight }]} pointerEvents="none">
						<HeaderEdgeFade id="paraSheetFade" color="#000000" opacity={0.32} />
					</View>
					{children}
				</View>
			</Animated.View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: { backgroundColor: 'rgba(0,0,0,.5)' },
	// 影は浮かせたシートを地から離すために要る。切り抜かない層に置くこと。
	// **この層が地色と角丸を持つ。** 透明なままだと iOS は影の形を作れず影が出ないし、
	// Android の `elevation` は View の矩形 outline から描くので角丸の背後に矩形の
	// ハローが出る。中身の切り抜きは内側の層が担当する。
	shadow: {
		position: 'absolute',
		backgroundColor: colors.panel,
		shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 10 },
		elevation: 24,
	},
	sheet: {
		overflow: 'hidden',
		backgroundColor: colors.panel,
		borderWidth: 1, borderColor: colors.glassBorder,
	},
	shadowGlass: { backgroundColor: 'transparent' },
	// 全高のときだけ器の高さいっぱいに広げる（top と bottom の両方が決まっているため）。
	sheetFill: { flex: 1 },
	glassSheet: { backgroundColor: 'transparent' },
	handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
	head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 12 },
	// 見出しの下に重ねる帯。本文はこの下を流れる（`top` は実測値を当てる）。
	topFade: { position: 'absolute', left: 0, right: 0, height: 20, zIndex: 1 },
	title: { color: colors.text, fontSize: 16, fontWeight: '700' },
	close: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	headerBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	confirmBtn: { backgroundColor: colors.accent },
});
