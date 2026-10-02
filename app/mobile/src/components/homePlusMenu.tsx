// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { ParaPlusMenuButton, type ParaPlusMenuItem } from '../../modules/para-plus-menu/index.js';
import { PARA_HEADER_PILL_BUTTON, PARA_HEADER_SLOT_HEIGHT } from '../paraHeader.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { HIT_SIZE, colors, radius, squircle, type } from '../theme.js';
import { haptic } from '../haptics.js';
import {
	buildHomeCreateMenuItems,
	buildHomeHeaderMenuItems,
	type HomeHeaderMenuAction,
	type HomeHeaderMenuItem,
	type HomePlusMenuAction,
} from './homeHeaderMenuBehavior.js';

export type { HomeHeaderMenuAction, HomePlusMenuAction } from './homeHeaderMenuBehavior.js';

/**
 * ホームヘッダーの＋メニュー。
 *
 * **メニューはOSに出させる。** ＋は `UIButton` で、標準の `UIMenu` を持つ
 * （`modules/para-plus-menu/`）。iOS 26 はボタン→メニューの変形を自前で描くので、
 * 液体のモーフ・ばね・中身のピント送り・押し込みの手応えが全部そのまま手に入る。
 *
 * 以前はこれを自作していた（SwiftUIの `glassEffectID` でカプセル⇄パネルをモーフさせ、
 * 中身はRNが上に重ねる）。方向は合っていたが、
 *  - RN側の暗幕が**最終サイズのまま**フェードインするので、下でガラスが育っていても見えない
 *  - LINEの録画をコマ送りすると、形は**角丸の長方形を一度も通らない**（卵型に膨らみ、
 *    閉じるときはピーナッツ型に凹む）。凹んだ形は frame と cornerRadius の補間では作れない
 * の2点で、作り込んでも届かないと分かったので畳んだ。
 *
 * 項目はプレーンな縦5つ。上段のプロバイダ3列（ロゴ付き）はやめて
 * 「エージェントを起動」の**入れ子**に畳んだ——これで `UIMenu` の標準形
 * （アイコン＋1行ラベル＋区切り線）にそのまま乗る。
 *
 * **このボタンを `GlassGroup`（`GlassEffectContainer`）の中へ入れてはいけない。**
 * iOS 26.1 で `Menu` をコンテナ内に置くとモーフが壊れる報告がある。
 */

interface HomePlusMenuProps {
	onSelect: (action: HomeHeaderMenuAction) => void;
	/** 「すべて確認済みにする」の対象件数。0件のときはその項目を出さない。 */
	ackCount: number;
	/** 開く先のスペースが決まっているか。決まっていないとメモは開けないので項目ごと出さない。 */
	hasSpace: boolean;
	compact?: boolean;
	archivedCount?: number;
	voiceActive?: boolean;
}

/** ヘッダーのピルの中に置く＋ボタン。押すとOSがメニューを出す。 */
export function HomePlusMenuButton({
	onSelect,
	ackCount,
	hasSpace,
	compact,
	archivedCount,
	voiceActive,
}: HomePlusMenuProps) {
	const menuItems = useMemo(() => buildHomeHeaderMenuItems({
		compact: compact === true,
		archivedCount: archivedCount ?? 0,
		voiceActive: voiceActive === true,
		ackCount,
		hasSpace,
	}), [ackCount, archivedCount, compact, hasSpace, voiceActive]);

	if (ParaPlusMenuButton !== undefined) {
		const nativeItems = toNativeItems(menuItems);
		return (
			<ParaPlusMenuButton
				style={compact === true ? styles.compactButton : styles.nativeButton}
				symbol={compact === true ? 'ellipsis.circle' : 'plus'}
				items={nativeItems}
				accessibilityTitle={compact === true ? 'ホーム操作' : '作成と表示のメニュー'}
				onSelect={event => {
					haptic('move');
					onSelect(event.nativeEvent.id as HomeHeaderMenuAction);
				}}
			/>
		);
	}
	return <FallbackPlusMenu items={menuItems} trigger={compact === true ? 'compact' : 'header'} onSelect={onSelect} />;
}

function toNativeItems(items: readonly HomeHeaderMenuItem[]): ParaPlusMenuItem[] {
	return items.map(item => ({
		id: item.id,
		title: item.title,
		systemImage: item.systemImage,
		startsSection: item.startsSection,
		children: item.children?.map(child => ({ id: child.id, title: child.title, systemImage: child.systemImage })),
	}));
}

/** 右下の＋の直径。 */
export const HOME_CREATE_FAB_SIZE = 52;

/**
 * ホームの画面右下の丸い＋（新規作成の入口）。押すとエージェントの起動（Claude / Codex /
 * ターミナル）・ワークツリーの作成・メモのメニューが開く。**この画面の主ボタン**なので
 * 白地に黒の＋にする（主ボタンは1画面に1つ）。
 *
 * メニューはヘッダーの＋と同じくOSに出させる（`UIMenu`）。見た目はRNの子が描き、
 * タップはネイティブのボタンが受ける（`symbol=""`。terminalPicker.tsx と同じ作り）。
 * 置き場所（タブバーの上・右端）は呼び出し側が決める。
 */
export function HomeCreateFab({ hasSpace, onSelect }: {
	hasSpace: boolean;
	onSelect: (action: HomePlusMenuAction) => void;
}) {
	const menuItems = useMemo(() => buildHomeCreateMenuItems({ hasSpace }), [hasSpace]);
	const select = (action: HomeHeaderMenuAction) => {
		// 作成メニューには作成系の項目しか無いので、ヘッダー専用の操作はここへ来ない。
		if (action !== 'archive' && action !== 'voice-notifications' && action !== 'notifications') {
			onSelect(action);
		}
	};
	if (ParaPlusMenuButton !== undefined) {
		return (
			<ParaPlusMenuButton
				style={styles.fab}
				symbol=""
				items={toNativeItems(menuItems)}
				accessibilityTitle="新規作成"
				onSelect={event => {
					haptic('move');
					select(event.nativeEvent.id as HomeHeaderMenuAction);
				}}
			>
				<View style={styles.fabFace} pointerEvents="none">
					<Ionicons name="add" size={26} color={colors.onPrimary} />
				</View>
			</ParaPlusMenuButton>
		);
	}
	return <FallbackPlusMenu items={menuItems} trigger="fab" onSelect={select} />;
}

/**
 * ネイティブの標準メニューが無いビルド（Android・このモジュールを含まない旧バイナリ）向け。
 *
 * ここでモーフを真似ることはしない。**素直にパネルを出す**——中途半端に似せると、
 * 本物を知っている人には壊れて見えるだけなので、別の見せ方だと分かる形にしておく。
 * 入れ子もやめて、エージェントの3つをそのまま並べる。
 */
function FallbackPlusMenu({ items, trigger, onSelect }: {
	items: readonly HomeHeaderMenuItem[];
	/** 押す場所。`fab` は画面右下の＋で、パネルは上ではなく＋の上へ向かって開く。 */
	trigger: 'header' | 'compact' | 'fab';
	onSelect: (action: HomeHeaderMenuAction) => void;
}) {
	const [open, setOpen] = useState(false);
	const [fabTop, setFabTop] = useState<number | undefined>(undefined);
	const insets = useStableInsets();
	const { height } = useWindowDimensions();
	const compact = trigger === 'compact';
	const fab = trigger === 'fab';
	const panelTop = insets.top + PARA_HEADER_SLOT_HEIGHT + 10;
	// 右下の＋から開くときは、＋の上端から上へ伸ばす（位置は押したときに実測する）。
	const panelBottom = fab && fabTop !== undefined ? height - fabTop + 10 : undefined;
	const panelMaxHeight = panelBottom !== undefined
		? Math.max(0, height - panelBottom - insets.top - PANEL_BOTTOM_GAP)
		: Math.max(0, height - panelTop - insets.bottom - PANEL_BOTTOM_GAP);

	// Android物理戻るボタンで閉じる。RNのModalではない自作Portalに載せているので、
	// ここで拾わないとメニューが開いたままタブ画面から抜ける
	// （homeAgentActionsMenu / agentStatusPopover / pcSwitcher と同じ扱い）。
	useEffect(() => {
		if (!open) {
			return;
		}
		const sub = BackHandler.addEventListener('hardwareBackPress', () => {
			setOpen(false);
			return true;
		});
		return () => sub.remove();
	}, [open]);

	const pick = (action: HomeHeaderMenuAction) => {
		haptic('move');
		setOpen(false);
		onSelect(action);
	};

	return (
		<>
			<Pressable
				style={({ pressed }) => [
					fab ? styles.fab : styles.fallbackButton,
					compact && styles.compactButton,
					pressed && (fab ? styles.fabPressed : styles.pressed),
				]}
				// 見た目34ptの＋も当たり判定は44ptにする（compact と右下の＋はそれ自体が44pt以上）。
				hitSlop={trigger === 'header' ? FALLBACK_BUTTON_HIT_SLOP : undefined}
				onPress={event => {
					haptic('move');
					if (fab) {
						const { pageY, locationY } = event.nativeEvent;
						setFabTop(pageY - locationY);
					}
					setOpen(value => !value);
				}}
				accessibilityRole="button"
				accessibilityLabel={compact ? 'ホーム操作' : fab ? '新規作成' : '作成と表示のメニュー'}
				accessibilityState={{ expanded: open }}
			>
				{fab ? (
					<View style={styles.fabFace} pointerEvents="none">
						<Ionicons name={open ? 'close' : 'add'} size={26} color={colors.onPrimary} />
					</View>
				) : (
					<Ionicons name={open ? 'close' : compact ? 'ellipsis-horizontal' : 'add'} size={21} color={colors.text} />
				)}
			</Pressable>
			{open ? (
				<OverlayPortal>
					<Pressable
						style={styles.scrim}
						onPress={() => setOpen(false)}
						accessibilityRole="button"
						accessibilityLabel="メニューを閉じる"
					/>
					{/* 位置はセーフエリアとお知らせの押し下げから決める（固定値だと
					    Androidのステータスバーやトースト表示中にヘッダーへ食い込む）。 */}
					<PopIn style={[styles.fallbackPanelPos, panelBottom !== undefined ? { bottom: panelBottom } : { top: panelTop }]}>
						<GlassSurface style={[styles.fallbackPanel, { maxHeight: panelMaxHeight }]}>
							<View style={styles.plate} pointerEvents="none" />
							<ScrollView style={[styles.fallbackScroll, { maxHeight: panelMaxHeight }]} contentContainerStyle={styles.fallbackBody} keyboardShouldPersistTaps="always">
								<FallbackMenuRows items={items} pick={pick} />
							</ScrollView>
						</GlassSurface>
					</PopIn>
				</OverlayPortal>
			) : null}
		</>
	);
}

function FallbackMenuRows({ items, pick }: {
	items: readonly HomeHeaderMenuItem[];
	pick: (action: HomeHeaderMenuAction) => void;
}) {
	return <>{items.map(item => (
		<View key={item.id}>
			{item.startsSection === true ? <View style={styles.divider} /> : null}
			{item.children === undefined
				? <MenuRow icon={item.fallbackIcon as keyof typeof Ionicons.glyphMap} label={item.fallbackTitle} onPress={() => pick(item.id as HomeHeaderMenuAction)} />
				: item.children.map(child => (
					<MenuRow
						key={child.id}
						icon={child.fallbackIcon as keyof typeof Ionicons.glyphMap}
						label={child.fallbackTitle}
						onPress={() => pick(child.id as HomeHeaderMenuAction)}
					/>
				))}
		</View>
	))}</>;
}

function MenuRow({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
		>
			<View style={styles.rowIcon}><Ionicons name={icon} size={18} color={colors.textSoft} /></View>
			<Text style={styles.rowLabel}>{label}</Text>
		</Pressable>
	);
}

/** フォールバックのパネル幅。 */
const PANEL_WIDTH = 262;
const PANEL_BOTTOM_GAP = 12;
/** 見た目34ptのフォールバックの＋を、当たり判定44ptまで広げる余白。 */
const FALLBACK_BUTTON_HIT_SLOP = (HIT_SIZE - 34) / 2;

const styles = StyleSheet.create({
	// ネイティブのボタン。ピルの中の他のボタンと同じ当たり判定にする。
	nativeButton: { width: PARA_HEADER_PILL_BUTTON, height: PARA_HEADER_PILL_BUTTON, borderRadius: radius.pill },
	compactButton: { width: HIT_SIZE, height: HIT_SIZE, borderRadius: radius.pill },
	// 右下の＋。白地（主ボタン）の丸。見た目は fabFace が描き、器は当たり判定と形だけを持つ。
	fab: { width: HOME_CREATE_FAB_SIZE, height: HOME_CREATE_FAB_SIZE, borderRadius: radius.pill },
	fabFace: {
		flex: 1, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
		backgroundColor: colors.primary,
	},
	fabPressed: { opacity: 0.8 },
	fallbackButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },

	scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim },
	fallbackPanelPos: { position: 'absolute', right: 12, width: PANEL_WIDTH },
	fallbackPanel: { borderRadius: radius.composer, ...squircle, overflow: 'hidden' },
	fallbackScroll: { flexGrow: 0 },
	// 素のガラスだと後ろの一覧の文字が項目名と重なって読めない。ただし埋めすぎると
	// ガラスに見えないので、コントラストを一段だけ持ち上げる薄さに抑える。
	plate: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,16,19,0.30)' },
	fallbackBody: { paddingVertical: 6 },
	divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 18, marginVertical: 5, backgroundColor: 'rgba(255,255,255,0.12)' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 14, height: 46, paddingHorizontal: 20 },
	rowIcon: { width: 22, alignItems: 'center' },
	rowLabel: { color: colors.text, fontSize: type.body },
	pressed: { backgroundColor: 'rgba(255,255,255,0.10)' },
});
