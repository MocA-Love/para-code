// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useCallback, useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/** ヘッダーの丸ボタン。44ptはHIGの最小タップ領域そのもの。 */
export const HEADER_BUTTON = 44;

/**
 * モーダルで開く画面（設定とその子画面、起動）の共通ヘッダー。
 *
 * **中身だけを渡し、器と動きはOS標準のナビゲーションバーに任せる。**
 * 最上段は左に「タイトルの島」、子画面は左がOSの丸い戻るボタンで中央にタイトル——という
 * 形の違いがそのまま「島が丸へ変わる」モーフになる。iOS 26 は push/pop のときにバー項目の
 * 集合の変化を自分でアニメーションするので、こちらは形を宣言するだけでよい
 * （経緯は `nativeHeaderItems.tsx` の説明を読むこと）。
 *
 * **ガラスは自分で置かない。** バー項目のカスタムビューにはOSが器を付けるので、
 * `GlassSurface` を重ねると枠が二重になる。以前ここが44ptの丸ガラスを2つ浮かべていたのは、
 * 自前のヘッダー層を使っていた頃の作りで、その層はもう使っていない。
 *
 * **左上が「戻る」、右上が「閉じる」**。設定はモーダルを1枚開いて中を水平pushで潜っていくので、
 * 深く入ったあとに一覧まで戻ってから閉じる、という往復が要らないように、どの階層からでも
 * 右上の×でモーダルごと抜けられるようにしてある（LINEの設定と同じ）。
 * ＜は1階層戻る（OSに任せる）、×はモーダルごと閉じる（`router.dismissAll()`）。
 *
 * `onHeightChange` には0を配る。本文の上余白はもう要らない——OSがバーの下から本文を
 * 始めるので、ヘッダーの高さぶん空けると二重に空く。呼び出し側は今までどおり受けた値を
 * `paddingTop` に渡していればよい。
 */
export function ScreenHeader({ title, subtitle, showBack = true, showClose = true, actions, onHeightChange }: {
	title: string;
	/** タイトルの下に添える1行（更新時刻など）。 */
	subtitle?: string;
	/** 一覧の最上段では false。戻る先が同じモーダルの中に無いため。 */
	showBack?: boolean;
	showClose?: boolean;
	/** ×の左に並べる追加のボタン。{@link HeaderCircleButton} を使うこと。 */
	actions?: ReactNode;
	/** 本文の `paddingTop` に使う値。バーへ移したので常に0を配る。 */
	onHeightChange?: (height: number) => void;
}) {
	const router = useRouter();

	useEffect(() => {
		onHeightChange?.(0);
	}, [onHeightChange]);

	// **戻る先が無い最上段は、タイトルを中央に置かず左の島に入れる。**
	// 中央に据えるのは「ここは行き先の途中で、左右に出口がある」という形なので、
	// 出口が右にしか無い画面でそれをやると、無い戻るボタンの席が空いて見える。
	const headerLeft = useCallback(() => (
		<View style={styles.island}>
			<Text style={styles.title} numberOfLines={1}>{title}</Text>
			{subtitle === undefined ? null : <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
		</View>
	), [title, subtitle]);

	// 子画面のタイトルは中央。中央に使える幅は「画面幅 − 2×max(左, 右)」なので、
	// 左が戻るボタンの丸・右がボタン1〜2個のこの形でしか成立しない。
	const headerTitle = useCallback(() => (
		<View style={styles.titleHost}>
			<Text style={styles.title} numberOfLines={1}>{title}</Text>
			{subtitle === undefined ? null : <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
		</View>
	), [title, subtitle]);

	const closeModal = useCallback(() => {
		hapticSelection();
		// 深く潜っていても1タップでモーダルごと抜ける。閉じる先が無い（＝積み上がりが
		// 1枚だけの）ときは普通に戻るのと同じなので back に落とす。
		if (router.canDismiss()) { router.dismissAll(); } else { router.back(); }
	}, [router]);

	// **1つのビューにまとめて渡す。** OSはこれを1項目として扱い、全体に1つの器を付ける
	// （アイコンが並んだピルと同じ見た目になる）。
	const headerRight = useCallback(() => (
		<View style={styles.rightGroup}>
			{actions}
			{showClose ? <HeaderCircleButton icon="close" label="閉じる" onPress={closeModal} /> : null}
		</View>
	), [actions, showClose, closeModal]);

	// **描画関数と `options` は参照を安定させる。** 毎レンダー新しい関数を渡すとバー項目が
	// 作り直され、モーフの対象としての同一性まで切れる。
	const options = useMemo(() => ({
		headerShown: true,
		title: '',
		// 左に何かを置くとOSの戻るボタンは出なくなる。最上段だけ島を置き、子画面は
		// 戻るボタンをOSに任せる（島がその丸へ変わる動きもOSが描く）。
		...(showBack ? {} : { headerLeft }),
		headerTitle: showBack ? headerTitle : () => null,
		headerRight,
		// 戻るボタンはシェブロンだけにする。文字が付くと幅を食い、中央に使える幅が減る。
		headerBackButtonDisplayMode: 'minimal' as const,
		headerBackTitle: '',
		headerStyle: { backgroundColor: colors.bg },
		headerShadowVisible: false,
	}), [showBack, headerLeft, headerTitle, headerRight]);

	return <Stack.Screen options={options} />;
}

/**
 * ヘッダーに置く丸ボタンの**中身**。
 *
 * ガラスの器は置かない（OSがバー項目に付ける）。寸法も決めない——iOS 26 はカスタムビューを
 * 最低36pt幅まで引き伸ばすので、ここで44ptを主張すると器だけが大きくなる。
 */
export function HeaderCircleButton({ icon, label, color, onPress, disabled }: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	color?: string;
	onPress: () => void;
	disabled?: boolean;
}) {
	return (
		<Pressable
			style={styles.circleHit}
			hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled: disabled === true }}
		>
			<Ionicons name={icon} size={19} color={disabled === true ? colors.textDim : (color ?? colors.text)} />
		</Pressable>
	);
}

const styles = StyleSheet.create({
	// 高さは決めない（バーが決める）。ただし**横幅は最小値を持たせる**——「設定」のような
	// 短い文字だけだと中身が正方形に近くなり、OSが付ける器が横長のカプセルではなく**丸**に
	// なって、丸ボタンに文字を押し込んだように見える（実機で確認済み）。ホームの島が
	// カプセルに見えるのはアバターの26ptぶん横に長いからで、こちらにはそれが無い。
	island: { justifyContent: 'center', paddingHorizontal: 8, minWidth: 88, maxWidth: 220 },
	titleHost: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
	rightGroup: { flexDirection: 'row', alignItems: 'center', gap: 2 },
	circleHit: { width: 32, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	title: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
	subtitle: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
});
