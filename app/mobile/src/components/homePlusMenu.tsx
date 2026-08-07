// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Easing, LayoutAnimation, Platform, Pressable, StyleSheet, Text, UIManager, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassGroup, GlassSurface, liquidGlass } from './glassSurface.js';
import { ParaGlassMorphShape } from '../../modules/para-glass-morph/index.js';
import { HEADER_PILL_HEIGHT } from './screenHeader.js';
import { ProviderLogo } from './providerLogo.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticImpact } from '../haptics.js';

/** メニューの幅。3つ並べた上段のラベルが2行で収まる最小幅。 */
const MENU_WIDTH = 274;
/** ヘッダーのボタンのピルの高さ。閉じているときのガラスはこの高さのカプセル。 */
const PILL_HEIGHT = HEADER_PILL_HEIGHT;
/** モーフ（カプセル⇄パネル）にかける時間（秒）。ネイティブ側のspringと歩調を合わせる。 */
const MORPH_S = 0.55;
/** 中身の濃さの遷移（ミリ秒）。モーフと歩調を合わせる。 */
const MORPH_MS = MORPH_S * 1000;
/** パネルの角丸。ピル（カプセル）から育つ先の形。 */
const PANEL_RADIUS = 30;
/** パネルのガラスへの色被せ（#RRGGBBAA）。濃くしすぎるとガラスに見えなくなる。 */
const PANEL_TINT = '#1010134D';

if (Platform.OS === 'android') {
	UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

/**
 * ピルがメニューへ覆われて育つ「真モーフ」を使えるか。
 *
 * 使えるときはピル自身のガラスもこのコンポーネントのガラス層が描くので、
 * 呼び出し側は {@link HeaderActionPill} を `plain` にしてガラスを重ねないこと。
 */
export const plusMenuCoversPill: boolean = liquidGlass;

export type HomePlusMenuAction =
	| 'launch-claude'
	| 'launch-codex'
	| 'new-terminal'
	| 'new-worktree'
	| 'space-note'
	| 'sort'
	| 'ack-all';

interface HomePlusMenuProps {
	visible: boolean;
	onClose: () => void;
	onSelect: (action: HomePlusMenuAction) => void;
	/** 「すべて確認済みにする」の対象件数。0件のときはその行を出さない。 */
	ackCount: number;
	/** 開く先のスペースが決まっているか。決まっていないとメモは開けないので行ごと出さない。 */
	hasSpace: boolean;
	/** ＋を含むボタンのピル。メニューはこのピルを覆って広がる。 */
	children: ReactNode;
}

/**
 * ホームヘッダーの＋から開くメニュー。
 *
 * LINEの＋メニューと同じく、**ピルの下に別の面が生えるのではなく、ピル自身が
 * メニューへ育つ**。iOS 26のLiquid Glassでは、常設したガラスのframeを
 * `LayoutAnimation` で変えることで素材の融合モーフとして描く。それ以外の環境は
 * 従来の「高さを伸ばす」擬似モーフへフォールバックする。
 */
export function HomePlusMenu(props: HomePlusMenuProps) {
	if (plusMenuCoversPill) {
		return <MorphPlusMenu {...props} />;
	}
	return <FallbackPlusMenu {...props} />;
}

/**
 * 覆うモーフ版。役割を層で分ける:
 *
 *  - **ガラス層（GlassSurface）**: 形だけを持ち、常時マウントする。閉=ピルと同一frame
 *    のカプセル、開=パネル。**frameの変化を `LayoutAnimation`（UIKitのアニメーション）
 *    に任せると、素材がそれを追ってカプセル→パネルへ育つ**。これがLINEの覆うモーフの
 *    正体で、frame駆動でしか起きない（高さ0からのマウントやSwiftUIのmodifier差し替えでは
 *    出ないことを実機で確認済み。@expo/ui の glassEffectId 経路は値の変更が
 *    アニメーションのトランザクションに乗らずスナップした）。
 *  - **ピルの中身（RN）**: ガラス層の上に載る。開くとパネルに覆われるので触れなくする。
 *  - **メニューの中身（RN）**: 地の板と行。モーフに合わせて濃さだけを動かす。
 *
 * 中身をRNに残すのが要点。ボタン（音声通知・ベル等）は状態を持つ既存実装をそのまま使う。
 *
 * **Reanimated は使わない。** ガラスへ直接プロパティを書くと落ちるし（glassSurface.tsx
 * の警告参照）、worklet からの `runOnJS` は解放後に走ると落ちる。ここのアニメーションは
 * `LayoutAnimation`（frame）とRNの `Animated`（中身の濃さ）だけで完結する。
 */
function MorphPlusMenu({ visible, onClose, onSelect, ackCount, hasSpace, children }: HomePlusMenuProps) {
	// 中身の高さ。畳んでいる間も本来の大きさで置いてあるので、閉じたままでも測れる。
	const [contentHeight, setContentHeight] = useState(0);
	// ピルの実幅。アーカイブボタンの有無で変わるので実測してガラスのカプセルに渡す。
	const [pillWidth, setPillWidth] = useState(112);
	const pillWidthRef = useRef(112);
	// 角丸とtintの切り替え用。伸び始めた瞬間からパネルの丸みにする（高さが小さいうちは
	// CALayerが半径を高さ/2へ丸めるので、カプセルのまま滑らかに繋がる）。
	const [open, setOpen] = useState(visible);
	// ガラスを包む枠の大きさ。**JSドライバのAnimatedで毎フレーム実寸を書き換える。**
	// LayoutAnimation（UIKit側の一括アニメ）はこの構成（新アーキテクチャ＋絶対配置の
	// width/height変更）では補間されず、frameがスナップすることを録画で確認した。
	// 連続したframe変化そのものが融合モーフの駆動源なので、ここはJS駆動で確実に流す。
	// 動かすのは素のAnimated.Viewで、ガラス自体には触れない（Reanimatedも使わない）。
	const size = useRef(new Animated.ValueXY({ x: 112, y: PILL_HEIGHT })).current;
	// 地の板はモーフと同時に濃くなる（遅らせると伸びている最中が素通しで「薄い」印象になる）。
	const plate = useRef(new Animated.Value(visible ? 1 : 0)).current;
	// 行はモーフの後半で出す。伸び切る前の面に文字が乗ると読めてしまう。
	const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;

	// 閉じている間にピルの幅が変わったら（アーカイブボタンの出入り）、アニメせず追従する。
	const onPillLayout = (width: number) => {
		const w = Math.max(PILL_HEIGHT, Math.round(width));
		pillWidthRef.current = w;
		setPillWidth(w);
		if (!visible) {
			size.setValue({ x: w, y: PILL_HEIGHT });
		}
	};

	useEffect(() => {
		// JS駆動のframeアニメはフォールバック専用。ネイティブモーフがあるビルドでは
		// 誰も見ていない値を0.6秒補間するだけなので回さない（Hook自体は分岐しない）。
		if (ParaGlassMorphShape === undefined) {
			setOpen(visible);
			const target = visible
				? { x: MENU_WIDTH, y: Math.max(contentHeight, PILL_HEIGHT) }
				: { x: pillWidthRef.current, y: PILL_HEIGHT };
			// 開くときは少し行き過ぎて戻るspring（LINEの弾み）。閉じは弾ませない——
			// 縮む方向のオーバーシュートはピルより小さく凹んで見えて気持ち悪い。
			Animated.spring(size, {
				toValue: target,
				speed: visible ? 14 : 18,
				bounciness: visible ? 9 : 2,
				// width/heightはレイアウトプロパティなのでネイティブドライバでは動かせない。
				useNativeDriver: false,
			}).start();
		}
		Animated.timing(plate, {
			toValue: visible ? 1 : 0,
			duration: visible ? MORPH_MS * 0.7 : MORPH_MS * 0.45,
			easing: Easing.out(Easing.quad),
			useNativeDriver: true,
		}).start();
		Animated.timing(fade, {
			toValue: visible ? 1 : 0,
			duration: visible ? MORPH_MS * 0.5 : MORPH_MS * 0.35,
			delay: visible ? MORPH_MS * 0.45 : 0,
			easing: Easing.out(Easing.quad),
			useNativeDriver: true,
		}).start();
		// contentHeightを依存に入れない——開いている最中の再測定で不意に跳ねさせない。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible, size, plate, fade]);

	// 開いている間に中身の行数が変わったら（PC側のstate更新でackCount等が変わる）、
	// フォールバック経路の枠の高さだけ即値で追従させる。menuClipは即座に新しい高さに
	// なるので、放っておくと面と中身がずれる。バウンスは初回オープンだけでよい。
	useEffect(() => {
		if (visible && ParaGlassMorphShape === undefined) {
			size.setValue({ x: MENU_WIDTH, y: Math.max(contentHeight, PILL_HEIGHT) });
		}
	}, [contentHeight, visible, size]);

	return (
		<View style={styles.group} pointerEvents="box-none">
			{/* ガラス層。タッチは受けず、形のモーフだけを描く。閉じている間はピルの
			    ガラスとして振る舞い（呼び出し側はplainのピルを渡す）、開くとそのまま
			    パネルへ育つ。
			    ネイティブモジュールがあるビルドでは、カプセル⇄パネルの液体モーフ
			    （glassEffectID + withAnimationのspring）をSwiftUIが描く。無いビルド
			    （JSだけ更新された旧バイナリ）では、JS駆動のframeアニメで代替する。 */}
			{ParaGlassMorphShape !== undefined ? (
				<ParaGlassMorphShape
					style={[styles.morphGlass, { width: MENU_WIDTH, height: Math.max(contentHeight, PILL_HEIGHT) }]}
					pointerEvents="none"
					isExpanded={visible}
					pillWidth={pillWidth}
					pillHeight={PILL_HEIGHT}
					panelWidth={MENU_WIDTH}
					panelHeight={Math.max(contentHeight, PILL_HEIGHT)}
					panelCornerRadius={PANEL_RADIUS}
					panelTint={PANEL_TINT}
					expandDuration={MORPH_S}
					expandBounce={0.25}
					collapseDuration={0.35}
					collapseBounce={0.08}
				/>
			) : (
				<Animated.View
					style={[styles.morphGlass, { width: size.x, height: size.y }]}
					pointerEvents="none"
				>
					<GlassSurface
						style={[StyleSheet.absoluteFill, { borderRadius: open ? PANEL_RADIUS : PILL_HEIGHT / 2 }, styles.morphGlassInner]}
						tintColor={open ? '#101013' : undefined}
						tintOpacity={0.45}
					/>
				</Animated.View>
			)}
			{/* ピルの中身。ガラスは下の層が描くので、呼び出し側は plain のピルを渡す。
			    開くとパネルに覆われるが、地の板は屈折を残すため半透明なので、
			    そのままだとボタンが透けて見える。モーフに合わせて消す（吸収の表現も兼ねる）。
			    pointerEventsは読み上げから外さないので、隠れている間はVoiceOverからも隠す。 */}
			<Animated.View
				style={{ opacity: plate.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}
				onLayout={event => onPillLayout(event.nativeEvent.layout.width)}
				pointerEvents={visible ? 'none' : 'auto'}
				accessibilityElementsHidden={visible}
				importantForAccessibility={visible ? 'no-hide-descendants' : 'auto'}
			>
				{children}
			</Animated.View>
			{/* メニューの中身。パネルの形に切り抜き、濃さだけを動かす。
			    pointerEventsは指を止めるだけで読み上げからは外れないので、閉じている間は
			    アクセシビリティツリーからも明示的に隠す。 */}
			<View
				style={[styles.menuClip, contentHeight > 0 && { height: contentHeight }]}
				pointerEvents={visible ? 'auto' : 'none'}
				accessibilityElementsHidden={!visible}
				importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
			>
				<Animated.View style={[styles.plate, { opacity: plate }]} pointerEvents="none" />
				<Animated.View style={{ opacity: fade }}>
					<View style={styles.morphContent} onLayout={event => setContentHeight(Math.round(event.nativeEvent.layout.height))}>
						<MenuList onClose={onClose} onSelect={onSelect} ackCount={ackCount} hasSpace={hasSpace} />
					</View>
				</Animated.View>
				{/* ピルの足跡を「閉じる」の当たりにする。＋を押した指がもう一度同じ場所を押す
				    動きは自然に起きるので、そこに実行系の項目を置かない。中身はこの帯のぶん
				    下から始まる（morphContentのpaddingTop）。 */}
				<Pressable
					style={styles.closeHotspot}
					onPress={onClose}
					accessibilityRole="button"
					accessibilityLabel="メニューを閉じる"
				/>
			</View>
		</View>
	);
}

/**
 * フォールバック版（Liquid Glass非対応環境）。ピルの下からメニューが伸びる従来の形。
 *
 * ボタンのピルとメニューを同じ器（`GlassGroup`）の直下に置き、高さを0から本来の高さへ
 * 伸ばす。枠の変化は `LayoutAnimation` に任せる——UIKit側の普通の仕組みなので、
 * 器はそれを融合の動きとして拾う（対応環境ならこれでも融合が出るが、真モーフ版が
 * あるのでここへ来るのは素材がフォールバックのときだけ）。
 */
function FallbackPlusMenu({ visible, onClose, onSelect, ackCount, hasSpace, children }: HomePlusMenuProps) {
	const [contentHeight, setContentHeight] = useState(0);
	const [open, setOpen] = useState(visible);
	const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;

	useEffect(() => {
		// 枠の変化をUIKitのアニメーションとして起こす。器はこれを融合の動きとして拾う。
		LayoutAnimation.configureNext({
			duration: MORPH_MS,
			create: { type: 'easeInEaseOut', property: 'opacity' },
			update: { type: 'easeInEaseOut' },
			delete: { type: 'easeInEaseOut', property: 'opacity' },
		});
		setOpen(visible);
		Animated.timing(fade, {
			toValue: visible ? 1 : 0,
			duration: visible ? MORPH_MS * 0.65 : MORPH_MS * 0.5,
			delay: visible ? MORPH_MS * 0.35 : 0,
			easing: Easing.out(Easing.quad),
			useNativeDriver: true,
		}).start();
	}, [visible, fade]);

	return (
		<GlassGroup style={styles.group} spacing={16}>
			{children}
			<GlassSurface
				style={[styles.fallbackMenu, { height: open ? contentHeight : 0 }]}
				appearance={{ visible: open, duration: MORPH_S }}
				pointerEvents={visible ? 'auto' : 'none'}
			>
				{/* 中身は器の高さに関係なく本来の大きさで置く。器が切り抜くだけなので、
				    畳んでいる間にここで測った高さが、そのまま開いたときの高さになる。 */}
				<View style={styles.fallbackContent} onLayout={event => setContentHeight(event.nativeEvent.layout.height)}>
					<Animated.View style={[styles.plate, { opacity: fade }]} pointerEvents="none" />
					<Animated.View style={{ opacity: fade }}>
						<MenuList onClose={onClose} onSelect={onSelect} ackCount={ackCount} hasSpace={hasSpace} />
					</Animated.View>
				</View>
			</GlassSurface>
		</GlassGroup>
	);
}

/** メニューの中身（上段3列＋行）。真モーフ版とフォールバック版で共有する。 */
function MenuList({ onClose, onSelect, ackCount, hasSpace }: {
	onClose: () => void;
	onSelect: (action: HomePlusMenuAction) => void;
	ackCount: number;
	hasSpace: boolean;
}) {
	const pick = (action: HomePlusMenuAction) => {
		hapticImpact('light');
		onClose();
		onSelect(action);
	};
	return (
		<View>
			<View style={styles.top}>
				<TopItem label={'Claude\nを起動'} onPress={() => pick('launch-claude')}>
					<ProviderLogo provider="claude" size={26} />
				</TopItem>
				<TopItem label={'Codex\nを起動'} onPress={() => pick('launch-codex')}>
					<ProviderLogo provider="codex" size={26} />
				</TopItem>
				<TopItem label={'ターミナル\nを作成'} onPress={() => pick('new-terminal')}>
					<Ionicons name="terminal-outline" size={24} color={colors.text} />
				</TopItem>
			</View>
			<View style={styles.divider} />
			<MenuRow icon="git-branch-outline" label="ワークツリーを作成" onPress={() => pick('new-worktree')} />
			{hasSpace ? <MenuRow icon="document-text-outline" label="スペースのメモ" onPress={() => pick('space-note')} /> : null}
			<View style={styles.divider} />
			<MenuRow icon="swap-vertical-outline" label="並び替えと絞り込み" onPress={() => pick('sort')} />
			{ackCount > 0 ? (
				<MenuRow icon="checkmark-done-outline" label="すべて確認済みにする" onPress={() => pick('ack-all')} />
			) : null}
		</View>
	);
}

/**
 * メニューの下に敷く地。
 *
 * ヘッダーより下の層に置くので、島は暗くならずに残る。メニューがどこから開いたかを
 * 見失わない。
 */
export function PlusMenuScrim({ visible, onClose }: { visible: boolean; onClose: () => void }) {
	const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;
	const [mounted, setMounted] = useState(visible);

	useEffect(() => {
		if (visible) {
			setMounted(true);
		}
		Animated.timing(fade, {
			toValue: visible ? 1 : 0,
			duration: MORPH_MS,
			easing: Easing.out(Easing.quad),
			useNativeDriver: true,
		}).start();
		if (visible) {
			return undefined;
		}
		// 消え切ってから木から外す。アニメーションの完了コールバックに頼らないのは、
		// 木から外れた後にコールバックが走ると落ちる経路を踏まないため。
		const timer = setTimeout(() => setMounted(false), MORPH_MS);
		return () => clearTimeout(timer);
	}, [visible, fade]);

	if (!mounted) {
		return null;
	}
	return (
		<Animated.View style={[styles.scrim, { opacity: fade }]}>
			<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="メニューを閉じる" />
		</Animated.View>
	);
}

function TopItem({ label, children, onPress }: { label: string; children: ReactNode; onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.topItem, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label.replace('\n', '')}
		>
			{children}
			<Text style={styles.topLabel}>{label}</Text>
		</Pressable>
	);
}

function MenuRow({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
		>
			<View style={styles.rowIcon}><Ionicons name={icon} size={18} color="#d6d6de" /></View>
			<Text style={styles.rowLabel}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9, backgroundColor: 'rgba(0,0,0,0.45)' },
	// 器はピルの大きさのまま。メニューは絶対配置なので、ヘッダーの高さを押し広げない
	// （押し広げると本文の余白が跳ねる）。
	group: { alignItems: 'flex-end' },

	// モーフするガラス。ピルの右上を原点に、閉=ピルのframe／開=パネルのframeを取る。
	morphGlass: { position: 'absolute', top: 0, right: 0 },
	morphGlassInner: { ...squircle },
	// メニューの中身をパネルの形に切り抜く枠。ガラス層の形（roundedRectangle 30）と
	// ぴったり重ねる。
	menuClip: {
		position: 'absolute', top: 0, right: 0, width: MENU_WIDTH,
		borderRadius: PANEL_RADIUS, ...squircle, overflow: 'hidden',
	},
	// 上の余白はピルの足跡（閉じる帯）のぶん。LINEのメニューも上端から最初の項目まで
	// ほぼ同じ余白を取っている。
	morphContent: { paddingTop: PILL_HEIGHT, paddingBottom: 6 },
	closeHotspot: { position: 'absolute', top: 0, left: 0, right: 0, height: PILL_HEIGHT },
	// フォールバック版のメニュー面。ピルのすぐ下・右端を揃えて置く。
	fallbackMenu: {
		position: 'absolute', top: PILL_HEIGHT + 6, right: 0, width: MENU_WIDTH,
		borderRadius: PANEL_RADIUS, ...squircle, overflow: 'hidden',
	},
	fallbackContent: { position: 'absolute', top: 0, left: 0, width: MENU_WIDTH, paddingBottom: 6 },
	// 素のガラスのままだと、後ろの一覧の文字が項目名と重なって読めない。
	// ただし埋めすぎるとガラスに見えない（「ただの黒い板」になる）。ぼかしは素材が
	// 持っているので、ここは文字のコントラストを一段だけ持ち上げる薄さに抑える。
	plate: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,16,19,0.30)' },
	top: { flexDirection: 'row', paddingTop: 16, paddingBottom: 14, paddingHorizontal: 6 },
	topItem: { flex: 1, alignItems: 'center', gap: 7, paddingHorizontal: 4, paddingVertical: 4, borderRadius: radius.card, ...squircle },
	topLabel: { color: colors.text, fontSize: 11, lineHeight: 15, textAlign: 'center' },
	divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 18, backgroundColor: 'rgba(255,255,255,0.12)' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 14, height: 48, paddingHorizontal: 20 },
	rowIcon: { width: 22, alignItems: 'center' },
	rowLabel: { color: colors.text, fontSize: 14.5 },
	pressed: { backgroundColor: 'rgba(255,255,255,0.10)' },
});
