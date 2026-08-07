// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { GlassGroup, GlassSurface } from './glassSurface.js';
import { HeaderEdgeFade } from './headerEdgeFade.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { CONTENT_MAX_WIDTH } from '../ipad/ipadLayout.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';

/** ヘッダーの丸ボタン。44ptはHIGの最小タップ領域そのもの。 */
export const HEADER_BUTTON = 44;

/**
 * モーダルで開く画面（設定とその子画面、起動、通知）の共通ヘッダー。
 *
 * **左上が「戻る」、右上が「閉じる」**。設定はモーダルを1枚開いて中を水平pushで潜っていくので、
 * 深く入ったあとに一覧まで戻ってから閉じる、という往復が要らないように、どの階層からでも
 * 右上の×でモーダルごと抜けられるようにしてある（LINEの設定と同じ）。
 * ＜は1階層戻る（`router.back()`）、×はモーダルごと閉じる（`router.dismissAll()`）。
 *
 * 面は44の丸ガラス2つだけで、全幅のバーは持たない。本文はその隙間を流れて上端へ抜けていく。
 * 背後は {@link HeaderEdgeFade} で地色に落としてあるので、行がボタンの縁で切れて見えない。
 *
 * **本文には必ず `onHeightChange` で受けた高さを `paddingTop` として渡すこと**（スクロール
 * ビューの `contentContainerStyle` 側に入れる。外側の `paddingTop` にすると本文が下へ
 * 押し出されるだけで、ヘッダーの下を通らなくなる）。
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
	/** 実測した占有高さ。本文の `paddingTop` に使う。 */
	onHeightChange?: (height: number) => void;
}) {
	const insets = useStableInsets();
	const router = useRouter();

	return (
		<View
			style={[styles.wrap, { paddingTop: insets.top }]}
			pointerEvents="box-none"
			onLayout={onHeightChange !== undefined ? event => onHeightChange(event.nativeEvent.layout.height) : undefined}
		>
			<HeaderEdgeFade id="paraScreenHeaderFade" />
			<View style={styles.column} pointerEvents="box-none">
				<View style={styles.row} pointerEvents="box-none">
					{/* 戻る先が無い最上段は、タイトルを中央に置かず**左の島**に入れる。
					    中央に据えるのは「ここは行き先の途中で、左右に出口がある」という形なので、
					    出口が右にしか無い画面でそれをやると、無い戻るボタンの席が空いて見える。 */}
					{showBack ? null : (
						<GlassSurface style={styles.island}>
							<View style={styles.islandBody}>
								<Text style={styles.title}>{title}</Text>
								{subtitle === undefined ? null : <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
							</View>
						</GlassSurface>
					)}
					{showBack ? (
						<HeaderCircleButton
							icon="chevron-back"
							label="戻る"
							onPress={() => { hapticImpact('light'); router.back(); }}
						/>
					) : null}
					<View style={styles.spacer} pointerEvents="none" />
					<GlassGroup style={styles.rightGroup} spacing={12}>
						{actions}
						{showClose ? (
							<HeaderCircleButton
								icon="close"
								label="閉じる"
								// 深く潜っていても1タップでモーダルごと抜ける。閉じる先が無い（＝
								// 積み上がりが1枚だけの）ときは普通に戻るのと同じなので back に落とす。
								onPress={() => { hapticSelection(); if (router.canDismiss()) { router.dismissAll(); } else { router.back(); } }}
							/>
						) : null}
					</GlassGroup>
				</View>
				{/* タイトルは左右のボタン数に関係なく中央に据える。行の中に並べると、
				    右にボタンが増えたぶんだけ中心がずれる。 */}
				{showBack ? (
					<View style={styles.titleLayer} pointerEvents="none">
						<Text style={styles.title} numberOfLines={1}>{title}</Text>
						{subtitle === undefined ? null : <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
					</View>
				) : null}
			</View>
		</View>
	);
}

/** ヘッダーに置く44ptの丸ガラスボタン。 */
export function HeaderCircleButton({ icon, label, color, onPress, disabled }: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	color?: string;
	onPress: () => void;
	disabled?: boolean;
}) {
	return (
		<GlassSurface style={styles.circle} interactive>
			<Pressable
				style={styles.circleHit}
				onPress={onPress}
				disabled={disabled}
				accessibilityRole="button"
				accessibilityLabel={label}
				accessibilityState={{ disabled: disabled === true }}
			>
				<Ionicons name={icon} size={19} color={disabled === true ? colors.textDim : (color ?? colors.text)} />
			</Pressable>
		</GlassSurface>
	);
}

/**
 * ヘッダー右端に置くボタンのまとまり（1枚のガラスのピル）。
 *
 * 中のボタンにはガラスを重ねない（Apple HIG）。押下は白のハイライトで返す。
 * `overflow` は書かない——ベルのバッジが円周で欠ける。
 */
export function HeaderActionPill({ children, plain = false }: {
	children: ReactNode;
	/**
	 * ガラスを描かず、配置だけのピルにする。ホームの＋メニュー（真モーフ）のように
	 * **ガラスを別の層が描いている**場合に使う。ここでも描くと二重のガラスになる。
	 */
	plain?: boolean;
}) {
	if (plain) {
		return <View style={styles.pill}>{children}</View>;
	}
	return <GlassSurface style={styles.pill}>{children}</GlassSurface>;
}

/**
 * {@link HeaderActionPill} の中に入る丸ボタン。
 *
 * 見た目は34ptだが、`hitSlop` で実際の当たり判定を44pt相当まで広げてある。並んでいる
 * ボタンが「音声を開始する」「起動メニューを開く」と粒の違う操作なので、押し間違いが
 * そのまま別の画面へ飛ぶ形になる。
 */
export function HeaderActionButton({ icon, label, color, size = 17, badge, expanded, onPress }: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	color?: string;
	size?: number;
	/** アイコンの右上に載せる印（通知の赤い点など）。 */
	badge?: ReactNode;
	expanded?: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			style={({ pressed }) => [styles.pillButton, pressed && styles.pillButtonPressed]}
			hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={expanded === undefined ? undefined : { expanded }}
		>
			<Ionicons name={icon} size={size} color={color ?? colors.text} />
			{badge}
		</Pressable>
	);
}

/**
 * {@link HeaderActionPill} の高さ。＋メニューの真モーフは閉状態のガラスをこの高さの
 * カプセルとして描くので、こことずれるとモーフの起点が実ピルと合わなくなる。
 */
export const HEADER_PILL_HEIGHT = 40;

const styles = StyleSheet.create({
	pill: { height: HEADER_PILL_HEIGHT, borderRadius: radius.pill, ...squircle, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 3, gap: 2 },
	pillButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
	pillButtonPressed: { backgroundColor: 'rgba(255,255,255,0.16)' },
	wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, paddingBottom: 15 },
	column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
	row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
	island: { height: HEADER_BUTTON, borderRadius: radius.pill, ...squircle, maxWidth: 260 },
	islandBody: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
	spacer: { flex: 1, minWidth: 0 },
	rightGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	circle: { width: HEADER_BUTTON, height: HEADER_BUTTON, borderRadius: radius.pill, ...squircle },
	circleHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	// 左右のボタン（44 + 余白12）を避けた帯の中で中央寄せする。
	titleLayer: { position: 'absolute', left: 68, right: 68, top: 0, height: HEADER_BUTTON, alignItems: 'center', justifyContent: 'center' },
	title: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
	subtitle: { color: colors.textDim, fontSize: 10.5, marginTop: 1 },
});
