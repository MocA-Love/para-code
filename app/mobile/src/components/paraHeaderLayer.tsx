// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { GlassSurface } from './glassSurface.js';
import { HeaderEdgeFade } from './headerEdgeFade.js';
import { FilesSearchField } from './filesSearchField.js';
import { useParaHeaderMorph, type ParaHeaderFade } from './paraHeaderMorph.js';
import { useParaHeaderStore, PARA_HEADER_HIDDEN, PARA_HEADER_PILL_BUTTON as PILL_BUTTON, PARA_HEADER_SLOT_HEIGHT as SLOT_HEIGHT, type ParaHeaderIcon, type ParaHeaderLeft, type ParaHeaderSpec } from '../paraHeader.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { CONTENT_MAX_WIDTH } from '../ipad/ipadLayout.js';
import { useFilesSearch } from '../filesSearch.js';
import { colors, mono, radius, squircle, withAlpha } from '../theme.js';

/**
 * 全画面で共有する**唯一のヘッダー**（`app/_layout.tsx` に1つだけ置く）。
 *
 * 持っているのは5つのスロットだけ——左／中央の島／タイトル／右A／右B／帯。画面は
 * `useParaHeader()` で「自分の仕様」を書き込むだけで、**Viewはここのものが使い回される**。
 *
 * **形が変わるときの動きは `paraHeaderMorph.ts` が持つ**（Reanimatedの共有値1本）。
 * `LayoutAnimation` にも RN の `Animated` にも頼らない——どちらもJSスレッドに依存し、
 * 画面遷移でJSが詰まるとヘッダーが数百ms空になった。経緯と根拠はそちらの説明を読むこと。
 *
 * **スロットの器（ガラス）は必ずこの層が持つこと。** 画面から `<GlassSurface>` ごと
 * ReactNode で受け取ると、遷移で要素の同一性が切れて器が作り直され、動きが消える。
 * 中身（アイコン・ネイティブボタン）は差し替わってよい。
 *
 * **ガラスに不透明度を当ててはいけない**（0にすると効果ごと死ぬ）。薄くするのは器の
 * **中身**だけ。器の大きさは包み（`styles.slot`）の幅で変え、器は `flexGrow` でそれに従う。
 *
 * モーフ中は**旧の中身と新の中身が同時に載る**。旧は必ず `styles.overlay`（絶対配置）で
 * 重ねること——器の幅は中身から決まるので、旧を流れに入れると幅が両者の広い方になり、
 * 縮む動きが出なくなる。
 *
 * 右のガラス同士の融合（`GlassContainer`）は使っていない。包みを1枚挟むと器の直下の
 * 兄弟でなくなって効かないため。**LINEのヘッダーにも融合（くびれ）は無い**ことを実機録画の
 * コマ送りで確認済みなので、これは妥協ではなく元から要らない。
 */

/**
 * 中身に当てる不透明度。出てくる側には `morph.entering` を渡し、消えていく側は
 * 包みの絶対配置レイヤーに `morph.fading` を当てるので `undefined` を渡す。
 */
type FadeStyle = ParaHeaderFade | undefined;

/**
 * 左スロットの中身（器は外側が持つ）。**旧と新で同じものを2回描く**ため部品にしてある。
 *
 * 島のときは不透明度を**葉（アバターと文字）へ直に**当てる。ここに包みを1枚挟むと、
 * 器の幅を中身から決めている計算にflex階層が増えて中身が出なくなる（実機で踏んだ）。
 */
function LeftContent({ left, fade }: { left: ParaHeaderLeft; fade: FadeStyle }) {
	if (left.kind === 'back') {
		return (
			<Reanimated.View style={[styles.overlay, fade]}>
				<Pressable
					style={styles.circleHit}
					onPress={left.onPress}
					disabled={left.disabled}
					accessibilityRole="button"
					accessibilityLabel={left.label}
				>
					<Ionicons name="chevron-back" size={20} color={colors.text} />
				</Pressable>
			</Reanimated.View>
		);
	}
	return (
		<Pressable
			style={styles.islandHit}
			onPress={left.onPress}
			disabled={left.disabled === true || left.onPress === undefined}
			accessibilityRole={left.onPress === undefined ? undefined : 'button'}
			accessibilityLabel={left.label}
		>
			<Reanimated.View style={[styles.islandAvatar, { backgroundColor: withAlpha(left.color ?? colors.accent, 0.28) ?? colors.surface2 }, fade]}>
				{left.avatarIcon !== undefined
					? <Ionicons name={left.avatarIcon} size={15} color={left.color ?? colors.accent} />
					: <Text style={[styles.islandAvatarText, { color: left.color ?? colors.accent }]}>{left.avatarText ?? '—'}</Text>}
			</Reanimated.View>
			<Reanimated.View style={[styles.islandText, fade]}>
				<Text style={styles.islandName} numberOfLines={1}>{left.name ?? ''}</Text>
				{left.sub !== undefined && left.sub.length > 0
					? <Text style={[styles.islandSub, left.subColor !== undefined && { color: left.subColor }]} numberOfLines={1}>{left.sub}</Text>
					: null}
			</Reanimated.View>
		</Pressable>
	);
}

/** 右Aスロットの中身（文字のピル／アイコンのピル）。 */
function RightAContent({ rightA, fade }: { rightA: NonNullable<ParaHeaderSpec['rightA']>; fade: FadeStyle }) {
	if (rightA.kind === 'text') {
		return (
			<Pressable style={styles.textPillHit} onPress={rightA.onPress} accessibilityRole="button" accessibilityLabel={rightA.label}>
				<Reanimated.Text style={[styles.textPillLabel, rightA.color !== undefined && { color: rightA.color }, fade]} numberOfLines={1}>{rightA.label}</Reanimated.Text>
			</Pressable>
		);
	}
	return (
		<>
			{rightA.items.map(item => (
				<Reanimated.View key={item.key} style={fade}>
					<IconButton item={item} />
				</Reanimated.View>
			))}
		</>
	);
}

/** 右Bスロット（丸ボタン）の中身。 */
function RightBContent({ rightB, fade }: { rightB: NonNullable<ParaHeaderSpec['rightB']>; fade: FadeStyle }) {
	return (
		<Reanimated.View style={[styles.overlay, fade]}>
			<Pressable
				style={styles.circleHit}
				onPress={rightB.onPress}
				accessibilityRole="button"
				accessibilityLabel={rightB.label}
			>
				<Ionicons name={rightB.icon ?? 'close'} size={rightB.size ?? 19} color={rightB.color ?? colors.text} />
			</Pressable>
		</Reanimated.View>
	);
}

function IconButton({ item }: { item: ParaHeaderIcon }) {
	if (item.node !== undefined) {
		return <>{item.node}</>;
	}
	return (
		<Pressable
			style={({ pressed }) => [styles.pillButton, pressed && styles.pillButtonPressed]}
			hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
			onPress={item.onPress}
			accessibilityRole="button"
			accessibilityLabel={item.label}
		>
			<Ionicons name={item.icon ?? 'ellipse-outline'} size={item.size ?? 17} color={item.color ?? colors.text} />
			{item.badge === undefined ? null : (
				<View style={[styles.iconBadge, item.badge === 'red' ? styles.iconBadgeRed : styles.iconBadgeGreen]} />
			)}
		</Pressable>
	);
}

export function ParaHeaderLayer() {
	const insets = useStableInsets();
	const regular = useIsRegularWidth();
	const { spec, setHeight } = useParaHeaderStore(useShallow(s => ({ spec: s.spec, setHeight: s.setHeight })));
	// **ファイルの検索欄はここが直接描く。** 画面が仕様として渡すと、開閉が「画面が変わる
	// 描画」と「ヘッダーが変わる描画」の2回に分かれてしまう。ここでストアを直接読めば、
	// タップ1回の変化として扱える（＝下のモーフがそのまま帯にも効く）。
	// 経路で絞るのは、検索を開いたまま別のタブへ移ったときに帯を残さないため。
	const searchVisible = useFilesSearch(state => state.visible);
	const pathname = usePathname();
	const filesSearchVisible = searchVisible && pathname === '/files';

	// 帯は仕様へ畳んでから渡す（画面と層が同じ描画で変わるようにするため）。
	// **帯はモーフの対象外**なので、畳むのは中身の受け渡しのためだけ。
	const effective = useMemo<ParaHeaderSpec>(() => {
		const base = spec ?? PARA_HEADER_HIDDEN;
		return filesSearchVisible
			? { ...base, band: <FilesSearchField onClose={() => useFilesSearch.getState().close()} /> }
			: base;
	}, [spec, filesSearchVisible]);

	const morph = useParaHeaderMorph(effective, pathname);
	const rendered = morph.current;
	const previous = morph.previous;

	// **高さは常に配る。** 以前は「動いている間は配らない」としていたが、モーフの0.7〜0.9秒
	// ずっと本文の上余白が前の画面の値のままになり、一覧の1行目がチップ帯の裏に潜って文字が
	// 重なった。いまは帯を動かさず、スロットの高さも44pt固定なので、モーフ中に高さは変わらない
	// ——毎フレーム配っても実際には値が変わらないので、画面が作り直されることもない。

	// **モーダル（設定・ペアリング）のために伏せる必要はない。** ネイティブのモーダルは
	// この層より前面に presented されるので、出したままでも見えない。
	//
	// **伏せている間に高さを0へ落とさない。** 高さを読むのは表示中の画面だけなので、
	// 0を配ると自前ヘッダーの画面を閉じて戻った2フレームだけ本文が上端へ詰まる。
	if (rendered.hidden === true) {
		return null;
	}

	const { left, mid, title, rightA, rightB, band, wide } = rendered;
	const column = regular && wide !== true;

	return (
		<View
			style={[styles.wrap, { paddingTop: insets.top }]}
			pointerEvents="box-none"
			onLayout={event => setHeight(Math.round(event.nativeEvent.layout.height))}
		>
			{/* 本文がガラスの縁でぶつ切りに見えないよう、島の背後だけ地色へ落とす。
			    以前は画面ごとに別々に敷いていたが、層に1枚あれば足りる。 */}
			<HeaderEdgeFade id="paraHeaderFade" />
			<View style={[styles.row, column && styles.rowColumn]} pointerEvents="box-none">
				{left === undefined ? null : (
					<Reanimated.View
						style={[styles.slot, morph.bounds.left]}
						onLayout={event => morph.measure('left', Math.round(event.nativeEvent.layout.width))}
					>
						{left.kind === 'back' ? (
							<GlassSurface style={styles.circle} interactive>
								<LeftContent left={left} fade={morph.entering} />
								{previous?.left === undefined ? null : (
									<Reanimated.View style={[styles.overlay, morph.fading]} pointerEvents="none">
										<LeftContent left={previous.left} fade={undefined} />
									</Reanimated.View>
								)}
							</GlassSurface>
						) : (
							<GlassSurface
								style={[styles.island, left.maxWidth !== undefined && { maxWidth: left.maxWidth }]}
								interactive={left.disabled !== true}
								tintColor={left.tint}
							>
								<LeftContent left={left} fade={morph.entering} />
								{/* 消えていく中身。**絶対配置なので器の幅の計算には参加しない。** */}
								{previous?.left === undefined ? null : (
									<Reanimated.View style={[styles.overlay, morph.fading]} pointerEvents="none">
										<LeftContent left={previous.left} fade={undefined} />
									</Reanimated.View>
								)}
							</GlassSurface>
						)}
						{/* 赤い点は器の**外**に出す。器に `overflow: hidden` を当てて中身を切り取る
						    ので、中に置くと縁からはみ出す部分が消える。 */}
						{left.kind === 'island' && left.badge === true ? <View style={styles.islandBadge} /> : null}
					</Reanimated.View>
				)}

				{/* 中央の島（ターミナル名など）。無い画面は隙間だけを空ける。
				    タイトルは行の中に置かず絶対配置で画面の中央に据えるので、
				    左右のボタン数が増えても中心がずれない。 */}
				{mid === undefined ? (
					<View style={styles.spacer} pointerEvents="none" />
				) : (
					<GlassSurface style={styles.midIsland} interactive>
						<View style={styles.overlay}>{mid.node}</View>
						{mid.badge === true ? <View style={styles.islandBadge} /> : null}
					</GlassSurface>
				)}
				<View style={styles.rightGroup} pointerEvents="box-none">
					{/* 無くなるスロットも**消えていく間は描き続ける**（器を0へ縮めながら中身を薄くする）。
					    ここで即座に外すと、ターミナルの＋ボタンのように「消える側」が瞬間的に
					    消滅して、モーフしているのは残る側だけになる。 */}
					{rightA === undefined && previous?.rightA === undefined ? null : (
						<Reanimated.View
							style={[styles.slot, morph.bounds.rightA]}
							onLayout={event => morph.measure('rightA', Math.round(event.nativeEvent.layout.width))}
						>
							<GlassSurface
								style={(rightA ?? previous?.rightA)?.kind === 'text' ? styles.textPill : styles.pill}
								interactive={(rightA ?? previous?.rightA)?.kind === 'text'}
							>
								{rightA === undefined ? null : <RightAContent rightA={rightA} fade={morph.entering} />}
								{previous?.rightA === undefined ? null : (
									<Reanimated.View style={[styles.overlay, styles.overlayRow, morph.fading]} pointerEvents="none">
										<RightAContent rightA={previous.rightA} fade={undefined} />
									</Reanimated.View>
								)}
							</GlassSurface>
						</Reanimated.View>
					)}
					{rightB === undefined && previous?.rightB === undefined ? null : (
						<Reanimated.View
							style={[styles.slot, morph.bounds.rightB]}
							onLayout={event => morph.measure('rightB', Math.round(event.nativeEvent.layout.width))}
						>
							<GlassSurface style={styles.circle} interactive={rightB !== undefined}>
								{rightB === undefined ? null : <RightBContent rightB={rightB} fade={morph.entering} />}
								{previous?.rightB === undefined ? null : (
									<Reanimated.View style={[styles.overlay, morph.fading]} pointerEvents="none">
										<RightBContent rightB={previous.rightB} fade={undefined} />
									</Reanimated.View>
								)}
							</GlassSurface>
						</Reanimated.View>
					)}
				</View>
			</View>
			{title === undefined || mid !== undefined ? null : (
				<Reanimated.View style={[styles.titleLayer, { top: insets.top }, morph.entering]} pointerEvents="box-none">
					<Pressable
						style={styles.titleHit}
						onPress={title.onPress}
						disabled={title.onPress === undefined}
						pointerEvents={title.onPress === undefined ? 'none' : 'auto'}
						accessibilityRole={title.onPress === undefined ? undefined : 'button'}
						accessibilityLabel={title.label ?? title.text}
					>
						<View style={styles.titleRow}>
							<Text style={styles.title} numberOfLines={1}>{title.text}</Text>
							{title.chevron === true ? <Ionicons name="chevron-down" size={12} color={colors.textDim} /> : null}
						</View>
						{title.sub !== undefined && title.sub.length > 0
							? <Text style={[styles.titleSub, title.subColor !== undefined && { color: title.subColor }]} numberOfLines={1}>{title.sub}</Text>
							: null}
					</Pressable>
				</Reanimated.View>
			)}
			{/* 帯（絞り込みチップ・ファイル検索欄）は**モーフしない**。高さを動かすと
			    (1) ヘッダーの高さが変わるので本文の上余白が追いつかず1行目が裏に潜り、
			    (2) 中身はガラスのチップなので、動く親でクリップすると素材が壊れる。 */}
			{band === undefined ? null : (
				<View style={[styles.band, column && styles.rowColumn]} pointerEvents="box-none">
					{band}
				</View>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	// 本文の上に浮かべる。画面側は `useParaHeaderHeight()` を `paddingTop` に使う。
	wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, paddingBottom: 12 },
	// 島の行を帯より上のレイヤーに置く。右のボタンから生えるメニューはこの行の中にいるので、
	// 順番のままだと後から描かれる帯がメニューの上に乗ってしまう。
	row: { zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 12 },
	// iPad: 本文（useContentColumnStyle）と左端を揃える。
	rowColumn: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
	band: { zIndex: 1, marginTop: 10, paddingHorizontal: 16 },
	spacer: { flex: 1, minWidth: 0 },
	rightGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },

	// 幅を動かすための包み。**行方向にして中のガラスに `flexGrow` を持たせる**ので、
	// この箱の幅（モーフ中は共有値が決める）にガラスがそのまま追従する。静止時は箱に
	// 制約が無いので、幅は中のガラスの中身なりに決まる。
	slot: { flexShrink: 0, flexDirection: 'row' },
	// 大きさが決まっている器（丸・中央の島）の中身を重ねる層。**絶対配置にするのは、
	// 器の幅を中身から決めている場所（島・ピル）で階層を増やすと、幅の計算が壊れて
	// 中身が出なくなるため**。幅が中身で決まる器では、既存の要素へ直接不透明度を当てる。
	// 消えていく側の中身も必ずこれで重ねる（幅の計算に参加させないため）。
	overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'stretch' },
	// アイコンのピルの中身を重ねるときだけ、器と同じ並べ方にする。
	overlayRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, gap: 2 },

	// 器はどれも `flexGrow: 1` で包みの幅に追従し、`overflow: 'hidden'` で中身を切り取る
	// （切り取り＝細くなって見える）。**`borderRadius` は動かさない**——高さが一定なので
	// カプセルの半径は定数で足りる。毎フレーム変えると `UICornerRadius` を作り直す重い経路に入る。
	circle: { width: SLOT_HEIGHT, height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle, flexGrow: 1, overflow: 'hidden' },
	circleHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },

	island: { height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle, maxWidth: 224, flexGrow: 1, overflow: 'hidden' },
	islandHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 7, paddingRight: 15 },
	// 縮むときに潰れず切り取られるように。潰れると丸が楕円になって器と形が合わない。
	islandAvatar: { width: 30, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
	islandAvatarText: { fontSize: 13, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
	islandText: { flexShrink: 1, minWidth: 0 },
	islandName: { color: colors.text, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
	islandSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
	// 左の島と右のピルの間を埋める島。中身の見た目は画面が持つ。
	midIsland: { flex: 1, minWidth: 0, height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle },
	// 他スペースに応答待ちが居ることの合図。件数は出さない（チップ列とタブバーのバッジと
	// 母数が違う数字を並べると、どれが本当か分からなくなる）。
	islandBadge: {
		position: 'absolute', top: -3, left: -3, width: 10, height: 10, borderRadius: radius.pill,
		backgroundColor: colors.red, borderWidth: 2, borderColor: colors.bg,
	},

	// 中のボタンにはガラスを重ねない（Apple HIG）。押下は白のハイライトで返す。
	pill: { height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, gap: 2, flexGrow: 1, overflow: 'hidden' },
	pillButton: { width: PILL_BUTTON, height: PILL_BUTTON, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
	pillButtonPressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
	iconBadge: { position: 'absolute', top: 3, right: 3, width: 9, height: 9, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.bg },
	iconBadgeRed: { backgroundColor: colors.red },
	iconBadgeGreen: { backgroundColor: colors.green },

	textPill: { height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle, maxWidth: 200, flexGrow: 1, overflow: 'hidden' },
	textPillHit: { flex: 1, justifyContent: 'center', paddingHorizontal: 14 },
	textPillLabel: { color: colors.text, fontSize: 12.5, fontWeight: '600' },

	// **`top` はセーフエリアぶんを自分で足す。** ここの絶対配置は親（`wrap`）の
	// **ボーダーボックス**基準で、`wrap` の `paddingTop` は効かない（実機で確認: `top: 0` に
	// すると島の行ではなくステータスバーの位置に出て、時刻や電池と重なった）。
	titleLayer: { position: 'absolute', left: 72, right: 72, height: SLOT_HEIGHT },
	titleHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	titleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	title: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, flexShrink: 1 },
	titleSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
});
