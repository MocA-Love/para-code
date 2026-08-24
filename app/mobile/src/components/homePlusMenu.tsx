// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { ParaPlusMenuButton, type ParaPlusMenuItem } from '../../modules/para-plus-menu/index.js';
import { PARA_HEADER_PILL_BUTTON, PARA_HEADER_SLOT_HEIGHT } from '../paraHeader.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import {
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
	notificationQuestionCount?: number;
}

/** ヘッダーのピルの中に置く＋ボタン。押すとOSがメニューを出す。 */
export function HomePlusMenuButton({
	onSelect,
	ackCount,
	hasSpace,
	compact,
	archivedCount,
	voiceActive,
	notificationQuestionCount,
}: HomePlusMenuProps) {
	const menuItems = useMemo(() => buildHomeHeaderMenuItems({
		compact: compact === true,
		archivedCount: archivedCount ?? 0,
		voiceActive: voiceActive === true,
		notificationQuestionCount: notificationQuestionCount ?? 0,
		ackCount,
		hasSpace,
	}), [ackCount, archivedCount, compact, hasSpace, notificationQuestionCount, voiceActive]);

	if (ParaPlusMenuButton !== undefined) {
		const nativeItems: ParaPlusMenuItem[] = menuItems.map(item => ({
			id: item.id,
			title: item.title,
			systemImage: item.systemImage,
			startsSection: item.startsSection,
			children: item.children?.map(child => ({ id: child.id, title: child.title, systemImage: child.systemImage })),
		}));
		return (
			<ParaPlusMenuButton
				style={compact === true ? styles.compactButton : styles.nativeButton}
				symbol={compact === true ? 'ellipsis.circle' : 'plus'}
				items={nativeItems}
				accessibilityTitle={compact === true ? 'ホーム操作' : '作成と表示のメニュー'}
				onSelect={event => {
					hapticImpact('light');
					onSelect(event.nativeEvent.id as HomeHeaderMenuAction);
				}}
			/>
		);
	}
	return <FallbackPlusMenu items={menuItems} compact={compact === true} onSelect={onSelect} />;
}

/**
 * ネイティブの標準メニューが無いビルド（Android・このモジュールを含まない旧バイナリ）向け。
 *
 * ここでモーフを真似ることはしない。**素直にパネルを出す**——中途半端に似せると、
 * 本物を知っている人には壊れて見えるだけなので、別の見せ方だと分かる形にしておく。
 * 入れ子もやめて、エージェントの3つをそのまま並べる。
 */
function FallbackPlusMenu({ items, compact, onSelect }: {
	items: readonly HomeHeaderMenuItem[];
	compact: boolean;
	onSelect: (action: HomeHeaderMenuAction) => void;
}) {
	const [open, setOpen] = useState(false);
	const insets = useStableInsets();
	const { height } = useWindowDimensions();
	const panelTop = insets.top + PARA_HEADER_SLOT_HEIGHT + 10;
	const panelMaxHeight = Math.max(0, height - panelTop - insets.bottom - PANEL_BOTTOM_GAP);

	// Android物理戻るボタンで閉じる。RNのModalではない自作Portalに載せているので、
	// ここで拾わないとメニューが開いたままタブ画面から抜ける
	// （terminalActionsMenu / agentStatusPopover / pcSwitcher と同じ扱い）。
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
		hapticImpact('light');
		setOpen(false);
		onSelect(action);
	};

	return (
		<>
			<Pressable
				style={({ pressed }) => [styles.fallbackButton, compact && styles.compactButton, pressed && styles.pressed]}
				hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
				onPress={() => { hapticImpact('light'); setOpen(value => !value); }}
				accessibilityRole="button"
				accessibilityLabel={compact ? 'ホーム操作' : '作成と表示のメニュー'}
				accessibilityState={{ expanded: open }}
			>
				<Ionicons name={open ? 'close' : compact ? 'ellipsis-horizontal' : 'add'} size={21} color={colors.text} />
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
					<PopIn style={[styles.fallbackPanelPos, { top: panelTop }]}>
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
			<View style={styles.rowIcon}><Ionicons name={icon} size={18} color="#d6d6de" /></View>
			<Text style={styles.rowLabel}>{label}</Text>
		</Pressable>
	);
}

/** フォールバックのパネル幅。 */
const PANEL_WIDTH = 262;
const PANEL_BOTTOM_GAP = 12;

const styles = StyleSheet.create({
	// ネイティブのボタン。ピルの中の他のボタンと同じ当たり判定にする。
	nativeButton: { width: PARA_HEADER_PILL_BUTTON, height: PARA_HEADER_PILL_BUTTON, borderRadius: radius.pill },
	compactButton: { width: 44, height: 44, borderRadius: radius.pill },
	fallbackButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },

	scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
	fallbackPanelPos: { position: 'absolute', right: 12, width: PANEL_WIDTH },
	fallbackPanel: { borderRadius: 26, ...squircle, overflow: 'hidden' },
	fallbackScroll: { flexGrow: 0 },
	// 素のガラスだと後ろの一覧の文字が項目名と重なって読めない。ただし埋めすぎると
	// ガラスに見えないので、コントラストを一段だけ持ち上げる薄さに抑える。
	plate: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,16,19,0.30)' },
	fallbackBody: { paddingVertical: 6 },
	divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 18, marginVertical: 5, backgroundColor: 'rgba(255,255,255,0.12)' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 14, height: 46, paddingHorizontal: 20 },
	rowIcon: { width: 22, alignItems: 'center' },
	rowLabel: { color: colors.text, fontSize: 14.5 },
	pressed: { backgroundColor: 'rgba(255,255,255,0.10)' },
});
