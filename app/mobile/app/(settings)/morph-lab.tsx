// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import Reanimated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Host, Group, RNHostView } from '@expo/ui/swift-ui';
import { blur as blurModifier } from '@expo/ui/swift-ui/modifiers';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface } from '../../src/components/glassSurface.js';
import { ScreenHeader } from '../../src/components/screenHeader.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, mono, radius, squircle } from '../../src/theme.js';
import { hapticSelection } from '../../src/haptics.js';

/**
 * 設定 →「ヘッダーの動きを試す」。**出荷する画面ではなく、見た目を決めるための実験台。**
 *
 * ヘッダーが「一覧の島」から「詳細の丸」へ変わる動きを、部品ごとに入り切りして
 * 実機で見比べるためだけの画面。文章で相談しても互いの想像がずれるので、実物を並べる。
 *
 * ## ここで確かめたいこと
 * 1. **`blur` が本当に効くのか。** iOSには生きているビューをぼかす公開APIがSwiftUIの
 *    `.blur` しかなく、それが `@expo/ui` 経由でRNの子（`UIViewRepresentable` でホストされた
 *    ビュー）に効くかは誰も検証していない。**ここが全ての選択肢の分水嶺**なので、
 *    アニメーションと切り離した「手動でぼかす」段も用意してある
 * 2. **どの部品が「美しさ」に効いているのか。** LINEの実機録画を60fpsでコマ送りして測った
 *    仕様は「幅が縮む＋中身がぼける＋旧と新が同時に見える＋器と中身で別のカーブ」だが、
 *    どれが本質かは見比べないと分からない
 *
 * ## 実装上の割り切り（本番と違う点）
 * - **幅は実測せず定数**。本番は中身から幅を決めているが、ここでは「幅の動き」だけを
 *   見たいので明示的に補間する。これが綺麗に見えるなら、本番も実測した明示幅へ寄せる価値がある
 * - **ぼかしの半径はReactのstateで渡す**（`@expo/ui` のmodifierは数値しか受け取らない）。
 *   山（0→最大→0）は2回の更新で作り、間の補間はSwiftUI側の `animation` に任せる。
 *   ここが滑らかにならない場合は「RNのprop更新はSwiftUIのアニメーショントランザクションに
 *   乗らない」という既知の疑い（`para-glass-morph` の削除時の実測記録）が裏付けられる
 */

/** 一覧の島の幅（アバター＋「すべてのスペース」）。 */
const LIST_LEFT_W = 200;
/** 詳細の戻るボタン（丸）の幅。 */
const DETAIL_LEFT_W = 44;
/** 一覧の右のピル（アイコン4つ）の幅。 */
const LIST_RIGHT_W = 152;
/** 詳細の右の丸。 */
const DETAIL_RIGHT_W = 44;
/** LINEの実測: タイトルは右から68pt滑り込む。 */
const TITLE_SLIDE = 68;

/** LINEの実測値。器は短く、中身は長くease-outの尾を引く。 */
const SHELL_MS = 215;
const CONTENT_MS = 333;

interface Recipe {
	readonly key: string;
	readonly name: string;
	readonly desc: string;
	readonly width: boolean;
	readonly opacity: boolean;
	readonly scale: boolean;
	readonly blur: boolean;
	readonly titleSlide: boolean;
	readonly splitCurve: boolean;
}

/**
 * 見比べる案。**「いまのアプリ」を先頭に置いて基準にする**——良くなったかどうかは
 * 比較でしか判断できない。
 */
const RECIPES: readonly Recipe[] = [
	{
		key: 'now', name: '① いまのアプリと同じ',
		desc: '幅＋不透明度のクロスフェード。カーブは1本。これが今の見た目です',
		width: true, opacity: true, scale: false, blur: false, titleSlide: false, splitCurve: false,
	},
	{
		key: 'instant', name: '② 動かさない',
		desc: '即座に入れ替える。＋メニューで一度この判断をしています',
		width: false, opacity: false, scale: false, blur: false, titleSlide: false, splitCurve: false,
	},
	{
		key: 'scale', name: '③ ＋スケール',
		desc: '①に「消える側は縮み、出る側は拡大しながら入る」を足す。Appleの blurReplace の既定と同じ向き',
		width: true, opacity: true, scale: true, blur: false, titleSlide: false, splitCurve: false,
	},
	{
		key: 'blur', name: '④ ＋ぼかし',
		desc: '③にガウスぼかしを足す。LINEで測ったのはこれ。ぼかしが中身の正体を消すので二重像に見えなくなる、はず',
		width: true, opacity: true, scale: true, blur: true, titleSlide: false, splitCurve: false,
	},
	{
		key: 'full', name: '⑤ LINE実測に寄せる',
		desc: '④に「器215ms／中身333msでカーブを分ける」と「タイトルを右から68pt滑り込ませる」を足す',
		width: true, opacity: true, scale: true, blur: true, titleSlide: true, splitCurve: true,
	},
	{
		key: 'blurOnly', name: '⑥ ぼかしだけ',
		desc: '不透明度を動かさず、ぼかしと幅だけで入れ替える。中身が薄くならないので沈み込みが出ない',
		width: true, opacity: false, scale: false, blur: true, titleSlide: false, splitCurve: false,
	},
	{
		key: 'noWidth', name: '⑦ 幅を動かさない',
		desc: '器の形は即座に変え、中身だけぼかして入れ替える。幅の動きが本当に要るのかを見る',
		width: false, opacity: true, scale: true, blur: true, titleSlide: false, splitCurve: false,
	},
];

export default function MorphLabScreen() {
	const insets = useStableInsets();
	const [headerHeight, setHeaderHeight] = useState(0);
	const column = useContentColumnStyle();

	const [recipeKey, setRecipeKey] = useState('now');
	const recipe = RECIPES.find(r => r.key === recipeKey) ?? RECIPES[0]!;
	/** 出ている状態。押すたびに往復する。 */
	const [detail, setDetail] = useState(false);
	/** 直前の状態（消えていく側を描くため）。 */
	const previousRef = useRef(false);
	/** 手動のぼかし確認。アニメーションと切り離して「効くのか」だけを見る段。 */
	const [manualBlur, setManualBlur] = useState(0);
	/** 山のいまの半径（Reactのstateで渡すしかない）。 */
	const [blurRadius, setBlurRadius] = useState(0);
	const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	/** 器の進捗。0 = 旧、1 = 新。 */
	const shell = useSharedValue(1);
	/** 中身の進捗。カーブを分けるときだけ器と別に走る。 */
	const content = useSharedValue(1);

	const toggle = () => {
		hapticSelection();
		previousRef.current = detail;
		const next = !detail;
		setDetail(next);
		const shellMs = recipe.width || recipe.opacity || recipe.scale || recipe.blur ? SHELL_MS : 0;
		const contentMs = recipe.splitCurve ? CONTENT_MS : shellMs;
		shell.value = 0;
		content.value = 0;
		shell.value = withTiming(1, { duration: shellMs, easing: Easing.out(Easing.quad) });
		content.value = withTiming(1, { duration: contentMs, easing: Easing.out(Easing.cubic) });

		// ぼかしの山。**2回の更新で作る**（modifierは数値しか受け取らないため）。
		// 間の補間はSwiftUI側に任せる。滑らかにならなければ、prop更新がアニメーション
		// トランザクションに乗らないという疑いが裏付けられる。
		if (blurTimer.current !== undefined) {
			clearTimeout(blurTimer.current);
		}
		if (recipe.blur) {
			setBlurRadius(12);
			blurTimer.current = setTimeout(() => setBlurRadius(0), Math.max(1, contentMs / 2));
		} else {
			setBlurRadius(0);
		}
	};

	const leftFrom = previousRef.current ? DETAIL_LEFT_W : LIST_LEFT_W;
	const leftTo = detail ? DETAIL_LEFT_W : LIST_LEFT_W;
	const rightFrom = previousRef.current ? DETAIL_RIGHT_W : LIST_RIGHT_W;
	const rightTo = detail ? DETAIL_RIGHT_W : LIST_RIGHT_W;
	const animateWidth = recipe.width;
	const animateOpacity = recipe.opacity;
	const animateScale = recipe.scale;
	const animateTitle = recipe.titleSlide;

	const leftShell = useAnimatedStyle(() => ({
		width: animateWidth ? leftFrom + (leftTo - leftFrom) * shell.value : leftTo,
	}));
	const rightShell = useAnimatedStyle(() => ({
		width: animateWidth ? rightFrom + (rightTo - rightFrom) * shell.value : rightTo,
	}));
	const entering = useAnimatedStyle(() => ({
		opacity: animateOpacity ? content.value : 1,
		transform: animateScale ? [{ scale: 0.88 + 0.12 * content.value }] : [],
	}));
	const fading = useAnimatedStyle(() => ({
		opacity: animateOpacity ? 1 - content.value : 0,
		transform: animateScale ? [{ scale: 1 - 0.12 * content.value }] : [],
	}));
	const titleStyle = useAnimatedStyle(() => ({
		opacity: animateOpacity ? content.value : 1,
		transform: animateTitle ? [{ translateX: TITLE_SLIDE * (1 - content.value) }] : [],
	}));

	const showTitle = detail;
	const previousShowsTitle = previousRef.current;

	return (
		<View style={styles.screen}>
			<ScreenHeader title="ヘッダーの動きを試す" onHeightChange={setHeaderHeight} />
			<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingTop: headerHeight, paddingBottom: insets.bottom + 32 }, column]}>

				{/* ───────── 実験台 ───────── */}
				<Text style={styles.sectionTitle}>見本</Text>
				<View style={styles.stage}>
					<View style={styles.stageRow}>
						<Reanimated.View style={[styles.slot, leftShell]}>
							<GlassSurface style={styles.shell}>
								<BlurWrap radius={recipe.blur ? blurRadius : 0} enabled={recipe.blur}>
									<Reanimated.View style={[styles.fill, entering]}>
										{detail ? <BackContent /> : <IslandContent />}
									</Reanimated.View>
								</BlurWrap>
								<Reanimated.View style={[styles.overlay, fading]} pointerEvents="none">
									{previousRef.current ? <BackContent /> : <IslandContent />}
								</Reanimated.View>
							</GlassSurface>
						</Reanimated.View>

						<View style={styles.stageSpacer} pointerEvents="none" />

						<Reanimated.View style={[styles.slot, rightShell]}>
							<GlassSurface style={styles.shell}>
								<BlurWrap radius={recipe.blur ? blurRadius : 0} enabled={recipe.blur}>
									<Reanimated.View style={[styles.fill, entering]}>
										{detail ? <GlobeContent /> : <PillContent />}
									</Reanimated.View>
								</BlurWrap>
								<Reanimated.View style={[styles.overlay, fading]} pointerEvents="none">
									{previousRef.current ? <GlobeContent /> : <PillContent />}
								</Reanimated.View>
							</GlassSurface>
						</Reanimated.View>
					</View>

					{/* 中央のタイトル。詳細のときだけ出る。行の中には置かず絶対配置で中央に据える
					    （左右のボタンの幅が変わっても中心がずれないように）。 */}
					<View style={styles.titleLayer} pointerEvents="none">
						{showTitle || previousShowsTitle ? (
							<Reanimated.View style={showTitle ? titleStyle : fading}>
								<Text style={styles.title} numberOfLines={1}>エージェント</Text>
								<Text style={styles.titleSub} numberOfLines={1}>AZ-4 / 5177</Text>
							</Reanimated.View>
						) : null}
					</View>
				</View>

				<Pressable style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]} onPress={toggle}>
					<Ionicons name="swap-horizontal" size={18} color={colors.bg} />
					<Text style={styles.toggleLabel}>{detail ? '一覧へ戻る' : '詳細へ進む'}</Text>
				</Pressable>
				<Text style={styles.hint}>何度も往復させて見比べてください。往きと戻りで印象が違います</Text>

				{/* ───────── 案の選択 ───────── */}
				<Text style={styles.sectionTitle}>案</Text>
				<View style={styles.card}>
					{RECIPES.map((r, index) => (
						<View key={r.key}>
							{index > 0 ? <View style={styles.separator} /> : null}
							<Pressable style={styles.row} onPress={() => { hapticSelection(); setRecipeKey(r.key); }}>
								<View style={styles.rowBody}>
									<Text style={[styles.rowTitle, r.key === recipeKey && styles.rowTitleOn]}>{r.name}</Text>
									<Text style={styles.rowDesc}>{r.desc}</Text>
								</View>
								{r.key === recipeKey
									? <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
									: <Ionicons name="ellipse-outline" size={20} color={colors.textDim} />}
							</Pressable>
						</View>
					))}
				</View>

				{/* ───────── ぼかしが効くかの単独確認 ───────── */}
				<Text style={styles.sectionTitle}>ぼかしが効くかだけを見る</Text>
				<View style={styles.card}>
					<Text style={styles.rowDesc}>
						アニメーションと切り離して、静止したままぼかします。**上が素の表示、下がぼかしを通した表示**なので、
						見分け方は3通りです ——
						{'\n'}・半径0で上下が同じ → 仕組みは動いている
						{'\n'}・下が空っぽ → ぼかし以前に大きさが決まっていない（配置の問題）
						{'\n'}・半径20でも上下が同じ → **ぼかしがRNの中身に効かない**（案④⑤⑥⑦がすべて不成立）
					</Text>
					<View style={styles.blurPreviewRow}>
						<Text style={styles.blurPreviewLabel}>素の表示</Text>
						<GlassSurface style={styles.blurPreviewShell}>
							<View style={styles.fill}><IslandContent /></View>
						</GlassSurface>
						<Text style={styles.blurPreviewLabel}>ぼかしを通した表示</Text>
						<GlassSurface style={styles.blurPreviewShell}>
							<BlurWrap radius={manualBlur} enabled>
								<View style={styles.fill}><IslandContent /></View>
							</BlurWrap>
						</GlassSurface>
					</View>
					<View style={styles.stepper}>
						{[0, 4, 8, 12, 20].map(value => (
							<Pressable
								key={value}
								style={({ pressed }) => [styles.stepBtn, manualBlur === value && styles.stepBtnOn, pressed && styles.stepBtnPressed]}
								onPress={() => { hapticSelection(); setManualBlur(value); }}
							>
								<Text style={[styles.stepValue, manualBlur === value && styles.stepValueOn]}>{value}</Text>
							</Pressable>
						))}
					</View>
					<Text style={styles.hintTight}>半径（pt）</Text>
				</View>

				{/* ───────── 部品を個別に ───────── */}
				<Text style={styles.sectionTitle}>いま当たっているもの</Text>
				<View style={styles.card}>
					<Ingredient label="器の幅を動かす" on={recipe.width} />
					<View style={styles.separator} />
					<Ingredient label="不透明度で入れ替える" on={recipe.opacity} />
					<View style={styles.separator} />
					<Ingredient label="スケール（消える側は縮み、出る側は拡大）" on={recipe.scale} />
					<View style={styles.separator} />
					<Ingredient label="中身をぼかす" on={recipe.blur} />
					<View style={styles.separator} />
					<Ingredient label="タイトルを右から滑り込ませる" on={recipe.titleSlide} />
					<View style={styles.separator} />
					<Ingredient label={`カーブを分ける（器${SHELL_MS}ms／中身${CONTENT_MS}ms）`} on={recipe.splitCurve} />
				</View>

				{/* ───────── OSに任せた場合 ───────── */}
				<Text style={styles.sectionTitle}>OSに任せた場合を見る</Text>
				<View style={styles.card}>
					<Text style={styles.rowDesc}>
						上の7案はどれも**自前で動きを書いた場合**です。いっぽうLINEで測った動きは、
						**iOS 26の標準ナビゲーションバーがpush/popのときに自分で描いているもの**だと判定しました
						（Apple公式が「バー項目の集合が変わるとUIKitが自動で遷移をアニメーションし、
						位置と内容から同じ項目を推定して対応付ける」と明言しています）。
						{'\n\n'}
						こちらは標準バーを出して実際にpushする画面です。**カプセルが丸い戻るボタンへ
						形ごと移り変われば、動きを自分で書く必要はありません。**
					</Text>
					<Pressable
						style={({ pressed }) => [styles.nativeBtn, pressed && styles.stepBtnPressed]}
						onPress={() => { hapticSelection(); router.push('/morph-native'); }}
					>
						<Ionicons name="open-outline" size={17} color={colors.accent} />
						<Text style={styles.nativeBtnLabel}>標準バーで試す</Text>
						<Ionicons name="chevron-forward" size={15} color={colors.textDim} />
					</Pressable>
				</View>

				<Text style={styles.footnote}>
					この画面は見た目を決めるための実験台です。決まったら本番のヘッダーへ移して、この画面は消します。
				</Text>
			</ScrollView>
		</View>
	);
}

/**
 * 中身をSwiftUIのホストに入れてぼかす。**`enabled` が偽のときは何も挟まない**
 * ——ホストを常に挟むと、ぼかしが効かない場合に原因の切り分けができなくなる。
 *
 * `Group` を挟むのは `RNHostView` が `modifiers` を受け取らないため
 * （`RNHostViewProps` は `modifiers` を持たない）。
 */
function BlurWrap({ radius, enabled, children }: { radius: number; enabled: boolean; children: React.ReactElement }) {
	if (!enabled) {
		return children;
	}
	// `matchContents` は付けない。付けると「中身に合わせる」と「親の大きさで満たす」が
	// 矛盾して大きさが決まらない。ここは器の大きさをそのまま使いたいので親任せにする。
	return (
		<Host style={StyleSheet.absoluteFill}>
			<Group modifiers={[blurModifier(radius)]}>
				<RNHostView>{children}</RNHostView>
			</Group>
		</Host>
	);
}

function IslandContent() {
	return (
		<View style={styles.islandHit}>
			<View style={styles.avatar}><Text style={styles.avatarText}>P</Text></View>
			<View style={styles.islandText}>
				<Text style={styles.islandName} numberOfLines={1}>すべてのスペース</Text>
			</View>
		</View>
	);
}

function BackContent() {
	return (
		<View style={styles.centerHit}>
			<Ionicons name="chevron-back" size={20} color={colors.text} />
		</View>
	);
}

function PillContent() {
	return (
		<View style={styles.pillHit}>
			{(['file-tray-outline', 'volume-medium-outline', 'notifications-outline', 'add'] as const).map(name => (
				<View key={name} style={styles.pillButton}>
					<Ionicons name={name} size={17} color={colors.text} />
				</View>
			))}
		</View>
	);
}

function GlobeContent() {
	return (
		<View style={styles.centerHit}>
			<Ionicons name="globe-outline" size={19} color={colors.text} />
		</View>
	);
}

function Ingredient({ label, on }: { label: string; on: boolean }) {
	return (
		<View style={styles.row}>
			<View style={styles.rowBody}><Text style={styles.rowTitle}>{label}</Text></View>
			<Switch value={on} disabled trackColor={{ true: colors.accent, false: colors.surface2 }} />
		</View>
	);
}

const SLOT_H = 44;

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	scroll: { flex: 1 },
	sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginTop: 22, marginBottom: 8, marginHorizontal: 20, letterSpacing: 0.3 },
	card: { backgroundColor: colors.panel, borderRadius: radius.card, ...squircle, marginHorizontal: 16, paddingHorizontal: 14, paddingVertical: 4 },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 0 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
	rowTitleOn: { color: colors.accent },
	rowDesc: { color: colors.textDim, fontSize: 11.5, lineHeight: 16, marginTop: 2 },

	// 実験台。ヘッダーと同じ寸法・同じ地色にして、本番の見え方に近づける。
	stage: { marginHorizontal: 16, backgroundColor: colors.bg, borderRadius: radius.card, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingVertical: 18, paddingHorizontal: 16, overflow: 'hidden' },
	stageRow: { flexDirection: 'row', alignItems: 'center', gap: 8, height: SLOT_H },
	stageSpacer: { flex: 1 },
	slot: { height: SLOT_H },
	shell: { flex: 1, height: SLOT_H, borderRadius: radius.pill, ...squircle, overflow: 'hidden' },
	fill: { flex: 1 },
	overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
	titleLayer: { position: 'absolute', left: 0, right: 0, top: 18, height: SLOT_H, alignItems: 'center', justifyContent: 'center' },
	title: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, textAlign: 'center' },
	titleSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1, textAlign: 'center', fontFamily: mono.default },

	islandHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 7, paddingRight: 15 },
	avatar: { width: 30, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(9,175,217,.28)', flexShrink: 0 },
	avatarText: { color: colors.accent, fontSize: 13, fontWeight: '800', fontFamily: mono.default },
	islandText: { flexShrink: 1, minWidth: 0 },
	islandName: { color: colors.text, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
	centerHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	pillHit: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, gap: 2 },
	pillButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },

	toggle: { marginTop: 14, marginHorizontal: 16, height: 46, borderRadius: radius.pill, ...squircle, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
	togglePressed: { opacity: 0.85 },
	toggleLabel: { color: colors.bg, fontSize: 15, fontWeight: '700' },
	hint: { color: colors.textDim, fontSize: 11.5, marginTop: 8, marginHorizontal: 20, textAlign: 'center' },
	hintTight: { color: colors.textDim, fontSize: 11, marginBottom: 10, textAlign: 'center' },

	blurPreviewRow: { alignItems: 'flex-start', marginTop: 12, marginBottom: 12, gap: 6 },
	blurPreviewLabel: { color: colors.textDim, fontSize: 10.5, marginTop: 4 },
	blurPreviewShell: { width: LIST_LEFT_W, height: SLOT_H, borderRadius: radius.pill, ...squircle, overflow: 'hidden' },
	stepper: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginBottom: 6 },
	stepBtn: { minWidth: 46, height: 34, borderRadius: radius.control, ...squircle, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	stepBtnOn: { backgroundColor: colors.accent },
	stepBtnPressed: { opacity: 0.8 },
	stepValue: { color: colors.text, fontSize: 13, fontWeight: '700' },
	stepValueOn: { color: colors.bg },
	nativeBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, marginTop: 4 },
	nativeBtnLabel: { flex: 1, color: colors.accent, fontSize: 14, fontWeight: '700' },

	footnote: { color: colors.textDim, fontSize: 11, lineHeight: 16, marginTop: 24, marginHorizontal: 20 },
});
