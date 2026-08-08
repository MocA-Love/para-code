// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { GlassGroup, GlassSurface } from './glassSurface.js';
import { HeaderEdgeFade } from './headerEdgeFade.js';
import { FilesSearchField } from './filesSearchField.js';
import { morphParaHeaderNext, useParaHeaderStore, PARA_HEADER_PILL_BUTTON as PILL_BUTTON, PARA_HEADER_SLOT_HEIGHT as SLOT_HEIGHT, type ParaHeaderIcon } from '../paraHeader.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { useIsRegularWidth } from '../hooks/useSizeClass.js';
import { CONTENT_MAX_WIDTH } from '../ipad/ipadLayout.js';
import { useFilesSearch } from '../filesSearch.js';
import { colors, mono, radius, squircle, withAlpha } from '../theme.js';

/**
 * 全画面で共有する**唯一のヘッダー**（`app/_layout.tsx` に1つだけ置く）。
 *
 * 持っているのは5つのスロットだけ——左／中央のタイトル／右A／右B／帯。画面は
 * `useParaHeader()` で「自分の仕様」を書き込むだけで、**Viewはここのものが使い回される**。
 * だから遷移のときにガラスの器が生き残り、`LayoutAnimation` で枠が補間されて融合が起きる
 * （設計と落とし穴は `src/paraHeader.ts` の説明を読むこと）。
 *
 * **スロットの器（ガラス）は必ずこの層が持つこと。** 画面から `<GlassSurface>` ごと
 * ReactNode で受け取ると、遷移で要素の同一性が切れて器が作り直され、融合が消える。
 * 中身（アイコン・ネイティブボタン）は差し替わってよい（クロスフェードするだけ）。
 */

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
	// **ファイルの検索欄はここが直接描く。** 画面が仕様として渡すと、開閉のたびに
	// 「画面が変わる描画」と「ヘッダーが変わる描画」の2回に分かれ、`LayoutAnimation` の予約が
	// 前者に食われて滑り出さない（予約は中身に関係なく次の1描画に消費される）。ここで
	// ストアを直接読めば、タップで起きる描画1回にヘッダーの変化まで収まる。
	// 経路で絞るのは、検索を開いたまま別のタブへ移ったときに帯を残さないため。
	const searchVisible = useFilesSearch(state => state.visible);
	const pathname = usePathname();
	const filesSearchVisible = searchVisible && pathname === '/files';

	// **モーダル（設定・ペアリング）のために伏せる必要はない。** ネイティブのモーダルは
	// この層より前面に presented されるので、出したままでも見えない。ルート区画で伏せると
	// モーダルがせり上がる前にヘッダーだけ先に消えて、そこだけ動きが噛み合わなくなる。
	//
	// **伏せている間に高さを0へ落とさない。** 高さを読むのは表示中の画面だけなので、
	// 0を配ると自前ヘッダーの画面を閉じて戻った2フレームだけ本文が上端へ詰まる。
	if (spec === undefined || spec.hidden === true) {
		return null;
	}

	const { left, mid, title, rightA, rightB, band, wide } = spec;
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
				{left === undefined ? null : left.kind === 'back' ? (
					<GlassSurface style={styles.circle} interactive>
						<Pressable
							style={styles.circleHit}
							onPress={left.onPress}
							disabled={left.disabled}
							accessibilityRole="button"
							accessibilityLabel={left.label}
						>
							<Ionicons name="chevron-back" size={20} color={colors.text} />
						</Pressable>
					</GlassSurface>
				) : (
					<GlassSurface
						style={[styles.island, left.maxWidth !== undefined && { maxWidth: left.maxWidth }]}
						interactive={left.disabled !== true}
						tintColor={left.tint}
					>
						<Pressable
							style={styles.islandHit}
							onPress={left.onPress}
							disabled={left.disabled === true || left.onPress === undefined}
							accessibilityRole={left.onPress === undefined ? undefined : 'button'}
							accessibilityLabel={left.label}
						>
							<View style={[styles.islandAvatar, { backgroundColor: withAlpha(left.color ?? colors.accent, 0.28) ?? colors.surface2 }]}>
								{left.avatarIcon !== undefined
									? <Ionicons name={left.avatarIcon} size={15} color={left.color ?? colors.accent} />
									: <Text style={[styles.islandAvatarText, { color: left.color ?? colors.accent }]}>{left.avatarText ?? '—'}</Text>}
							</View>
							<View style={styles.islandText}>
								<Text style={styles.islandName} numberOfLines={1}>{left.name ?? ''}</Text>
								{left.sub !== undefined && left.sub.length > 0
									? <Text style={[styles.islandSub, left.subColor !== undefined && { color: left.subColor }]} numberOfLines={1}>{left.sub}</Text>
									: null}
							</View>
						</Pressable>
						{left.badge === true ? <View style={styles.islandBadge} /> : null}
					</GlassSurface>
				)}

				{/* 中央の島（ターミナル名など）。無い画面は隙間だけを空ける。
				    タイトルは行の中に置かず絶対配置で画面の中央に据えるので、
				    左右のボタン数が増えても中心がずれない。 */}
				{mid === undefined ? (
					<View style={styles.spacer} pointerEvents="none" />
				) : (
					<GlassSurface style={styles.midIsland} interactive>
						{mid.node}
						{mid.badge === true ? <View style={styles.islandBadge} /> : null}
					</GlassSurface>
				)}
				<GlassGroup style={styles.rightGroup} spacing={12}>
					{rightA === undefined ? null : rightA.kind === 'text' ? (
						<GlassSurface style={styles.textPill} interactive>
							<Pressable style={styles.textPillHit} onPress={rightA.onPress} accessibilityRole="button" accessibilityLabel={rightA.label}>
								<Text style={[styles.textPillLabel, rightA.color !== undefined && { color: rightA.color }]} numberOfLines={1}>{rightA.label}</Text>
							</Pressable>
						</GlassSurface>
					) : (
						<GlassSurface style={styles.pill}>
							{rightA.items.map(item => <IconButton key={item.key} item={item} />)}
						</GlassSurface>
					)}
					{rightB === undefined ? null : (
						<GlassSurface style={styles.circle} interactive>
							<Pressable
								style={styles.circleHit}
								onPress={rightB.onPress}
								accessibilityRole="button"
								accessibilityLabel={rightB.label}
							>
								<Ionicons name={rightB.icon ?? 'close'} size={rightB.size ?? 19} color={rightB.color ?? colors.text} />
							</Pressable>
						</GlassSurface>
					)}
				</GlassGroup>
			</View>
			{title === undefined || mid !== undefined ? null : (
				<Pressable
					style={[styles.titleLayer, { top: insets.top }]}
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
			)}
			{band === undefined && !filesSearchVisible ? null : (
				<View style={[styles.band, column && styles.rowColumn]} pointerEvents="box-none">
					{filesSearchVisible
						? <FilesSearchField onClose={() => { morphParaHeaderNext(); useFilesSearch.getState().close(); }} />
						: band}
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

	circle: { width: SLOT_HEIGHT, height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle },
	circleHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },

	island: { height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle, maxWidth: 224 },
	// 左の島と右のピルの間を埋める島。中身の見た目は画面が持つ。
	midIsland: { flex: 1, minWidth: 0, height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle },
	islandHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 7, paddingRight: 15 },
	islandAvatar: { width: 30, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	islandAvatarText: { fontSize: 13, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
	islandText: { flexShrink: 1, minWidth: 0 },
	islandName: { color: colors.text, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
	islandSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
	// 他スペースに応答待ちが居ることの合図。件数は出さない（チップ列とタブバーのバッジと
	// 母数が違う数字を並べると、どれが本当か分からなくなる）。
	islandBadge: {
		position: 'absolute', top: -3, left: -3, width: 10, height: 10, borderRadius: radius.pill,
		backgroundColor: colors.red, borderWidth: 2, borderColor: colors.bg,
	},

	// 中のボタンにはガラスを重ねない（Apple HIG）。押下は白のハイライトで返す。
	pill: { height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, gap: 2 },
	pillButton: { width: PILL_BUTTON, height: PILL_BUTTON, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	pillButtonPressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
	iconBadge: { position: 'absolute', top: 3, right: 3, width: 9, height: 9, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.bg },
	iconBadgeRed: { backgroundColor: colors.red },
	iconBadgeGreen: { backgroundColor: colors.green },

	textPill: { height: SLOT_HEIGHT, borderRadius: radius.pill, ...squircle, maxWidth: 160 },
	textPillHit: { flex: 1, justifyContent: 'center', paddingHorizontal: 14 },
	textPillLabel: { color: colors.text, fontSize: 12.5, fontWeight: '600' },

	// 左右のボタン（44 + 余白）を避けた帯の中で中央寄せする。
	// **`top` はセーフエリアぶんを自分で足す。** ここの絶対配置は親（`wrap`）の
	// **ボーダーボックス**基準で、`wrap` の `paddingTop` は効かない（実機で確認: `top: 0` に
	// すると島の行ではなくステータスバーの位置に出て、時刻や電池と重なった）。
	titleLayer: { position: 'absolute', left: 72, right: 72, height: SLOT_HEIGHT, alignItems: 'center', justifyContent: 'center' },
	titleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	title: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, flexShrink: 1 },
	titleSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
});
