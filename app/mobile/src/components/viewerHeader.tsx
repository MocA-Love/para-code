// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { monoFamily } from '../monoFont.js';
import { HIT_SIZE, alpha, colors, radius, squircle, type } from '../theme.js';
import { hapticImpact, hapticSelection } from '../haptics.js';
import { tintOf } from '../ui/themeColors.js';
import { useThemeColors } from '../ui/themeColorsStore.js';

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * 全画面ビューア（差分 `diffView.tsx`・ファイル `fileViewer.tsx`）の上端。2つで形を1つにする。
 *
 * **閉じる／戻るの出し分け:**
 *  - 別の画面の上に重ねて開き、閉じると元の画面へ帰るとき（エージェントの会話から開いたファイル、
 *    差分から開いたファイル）は、左上に「‹ 遷移元」を出す。右上の ✕ は出さない
 *  - タブから直接開いたときは左に種類のアイコン、右上に ✕ を出す
 * どちらか一方だけを出す。両方あると「戻る」と「閉じる」で行き先が違うのかと迷わせる。
 *
 * 押せる要素はすべて縦 44pt の当たり判定を持つ。見た目の高さは変えたくないので、上下に負の余白を
 * 付けてヘッダーの上下の余白（14pt 以上・12pt）の中へはみ出させる（hitSlop は親の外で効かない
 * ことがあるため、レイアウト上の大きさで確保する）。
 */
export interface ViewerSegment<T extends string> {
	readonly options: readonly { readonly value: T; readonly label: string }[];
	readonly value: T;
	readonly onChange: (value: T) => void;
}

export interface ViewerHeaderAction {
	readonly key: string;
	readonly icon: IoniconName;
	readonly label: string;
	readonly onPress: () => void;
}

export function ViewerHeader<T extends string>({ icon, title, top, backLabel, onClose, segment, accessory, actions, expandable, expanded, onToggleExpanded }: {
	/** 左に出す種類のアイコン（戻るボタンを出すときは出さない）。 */
	icon: IoniconName;
	title: string;
	/** ヘッダーの上余白（シート表示か全画面かで変わる）。 */
	top: number;
	/** 指定すると左上に「‹ backLabel」を出し、右上の ✕ は出さない。 */
	backLabel?: string;
	onClose: () => void;
	segment?: ViewerSegment<T>;
	/** タイトルの右に添える情報（増減の行数など）。 */
	accessory?: ReactNode;
	/** ✕ の手前に並べるアイコンの操作。 */
	actions?: readonly ViewerHeaderAction[];
	/** iPad のシート表示で「全画面に拡大」を出すか。 */
	expandable: boolean;
	expanded: boolean;
	onToggleExpanded: () => void;
}) {
	const close = () => { hapticImpact('light'); onClose(); };
	const theme = useThemeColors();
	return (
		<View style={[styles.header, { paddingTop: top }]}>
			{backLabel !== undefined ? (
				<Pressable style={styles.back} onPress={close} accessibilityRole="button" accessibilityLabel={`${backLabel}に戻る`}>
					<Ionicons name="chevron-back" size={21} color={theme.accent} />
					<Text style={[styles.backText, { color: theme.accent }]} numberOfLines={1}>{backLabel}</Text>
				</Pressable>
			) : <Ionicons name={icon} size={16} color={colors.textDim} />}
			<Text style={styles.title} numberOfLines={1} ellipsizeMode="head">{title}</Text>
			{accessory}
			{segment !== undefined ? (
				<View style={styles.segment}>
					<View style={styles.segmentTrack} pointerEvents="none" />
					{segment.options.map(option => {
						const active = option.value === segment.value;
						return (
							<Pressable
								key={option.value}
								style={styles.segmentBtn}
								onPress={() => { if (!active) { hapticSelection(); segment.onChange(option.value); } }}
								accessibilityRole="button"
								accessibilityState={{ selected: active }}
								accessibilityLabel={option.label}
							>
								<View style={[styles.segmentLabel, active && { backgroundColor: tintOf(theme.accent, alpha.line) }]}>
									<Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
								</View>
							</Pressable>
						);
					})}
				</View>
			) : null}
			{(actions ?? []).map(action => (
				<Pressable key={action.key} style={styles.iconBtn} hitSlop={ICON_SLOP} onPress={() => { hapticImpact('light'); action.onPress(); }} accessibilityRole="button" accessibilityLabel={action.label}>
					<Ionicons name={action.icon} size={19} color={colors.textDim} />
				</Pressable>
			))}
			{expandable ? (
				<Pressable style={styles.iconBtn} hitSlop={ICON_SLOP} onPress={onToggleExpanded} accessibilityRole="button" accessibilityLabel={expanded ? 'シート表示に戻す' : '全画面表示にする'}>
					<Ionicons name={expanded ? 'contract' : 'expand'} size={19} color={colors.textDim} />
				</Pressable>
			) : null}
			{backLabel === undefined ? (
				<Pressable style={styles.iconBtn} hitSlop={ICON_SLOP} onPress={close} accessibilityRole="button" accessibilityLabel="閉じる">
					<Ionicons name="close" size={22} color={colors.text} />
				</Pressable>
			) : null}
		</View>
	);
}

/** ヘッダーの中の要素の間隔。 */
const HEADER_GAP = 8;
/**
 * アイコンの操作の横の hitSlop。隣り合うアイコンの当たり判定が重ならないよう、間隔の半分までにする
 * （重なると、隣のボタンを押したつもりで別の操作が走る）。
 */
const ICON_SLOP_X = HEADER_GAP / 2;
/** アイコンの操作の器の幅。hitSlop（左右 {@link ICON_SLOP_X}）と合わせて 44pt になる幅にする。 */
const ICON_WIDTH = HIT_SIZE - ICON_SLOP_X * 2;
const ICON_SLOP = { left: ICON_SLOP_X, right: ICON_SLOP_X };
/** 44pt の当たり判定を、ヘッダーの上下の余白へはみ出させる量。 */
const BLEED = -12;

const styles = StyleSheet.create({
	header: { flexDirection: 'row', alignItems: 'center', gap: HEADER_GAP, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
	back: { flexDirection: 'row', alignItems: 'center', height: HIT_SIZE, marginVertical: BLEED, marginLeft: -7, marginRight: 2, maxWidth: 140 },
	backText: { color: colors.accent, fontSize: type.body, flexShrink: 1 },
	title: { flex: 1, color: colors.text, fontSize: type.body, fontFamily: monoFamily },
	iconBtn: { width: ICON_WIDTH, height: HIT_SIZE, marginVertical: BLEED, alignItems: 'center', justifyContent: 'center' },
	segment: { flexDirection: 'row', height: HIT_SIZE, marginVertical: BLEED, alignItems: 'center', paddingHorizontal: 2 },
	// 見た目の枠。押せる範囲（44pt）より細く描く。
	segmentTrack: { position: 'absolute', left: 0, right: 0, top: 8, bottom: 8, backgroundColor: colors.panel, borderRadius: radius.control, ...squircle, borderWidth: 1, borderColor: colors.border },
	segmentBtn: { height: HIT_SIZE, minWidth: HIT_SIZE, justifyContent: 'center', alignItems: 'center' },
	segmentLabel: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.key, ...squircle },
	segmentText: { color: colors.textDim, fontSize: type.meta },
	segmentTextActive: { color: colors.text, fontWeight: '600' },
});
