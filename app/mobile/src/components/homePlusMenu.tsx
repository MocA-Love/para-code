// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { ParaPlusMenuButton, type ParaPlusMenuItem } from '../../modules/para-plus-menu/index.js';
import { HEADER_PILL_HEIGHT } from './screenHeader.js';
import { useToastInset } from '../paraToast.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { colors, radius, squircle } from '../theme.js';
import { hapticImpact } from '../haptics.js';

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

export type HomePlusMenuAction =
	| 'launch-claude'
	| 'launch-codex'
	| 'new-terminal'
	| 'new-worktree'
	| 'space-note'
	| 'sort'
	| 'ack-all';

interface HomePlusMenuProps {
	onSelect: (action: HomePlusMenuAction) => void;
	/** 「すべて確認済みにする」の対象件数。0件のときはその項目を出さない。 */
	ackCount: number;
	/** 開く先のスペースが決まっているか。決まっていないとメモは開けないので項目ごと出さない。 */
	hasSpace: boolean;
}

/** SF Symbols（ネイティブ）と Ionicons（フォールバック）の対応表。 */
const AGENT_CHILDREN: { action: HomePlusMenuAction; title: string; sf: string; ion: keyof typeof Ionicons.glyphMap }[] = [
	{ action: 'launch-claude', title: 'Claude', sf: 'sparkles', ion: 'sparkles-outline' },
	{ action: 'launch-codex', title: 'Codex', sf: 'chevron.left.forwardslash.chevron.right', ion: 'code-slash-outline' },
	{ action: 'new-terminal', title: 'ターミナル', sf: 'terminal', ion: 'terminal-outline' },
];

/** ヘッダーのピルの中に置く＋ボタン。押すとOSがメニューを出す。 */
export function HomePlusMenuButton({ onSelect, ackCount, hasSpace }: HomePlusMenuProps) {
	const items = useMemo<ParaPlusMenuItem[]>(() => {
		const list: ParaPlusMenuItem[] = [
			{
				id: 'agent',
				title: 'エージェントを起動',
				systemImage: 'sparkles',
				children: AGENT_CHILDREN.map(child => ({ id: child.action, title: child.title, systemImage: child.sf })),
			},
			{ id: 'new-worktree', title: 'ワークツリーを作成', systemImage: 'arrow.triangle.branch', startsSection: true },
		];
		if (hasSpace) {
			list.push({ id: 'space-note', title: 'メモ', systemImage: 'doc.text' });
		}
		list.push({ id: 'sort', title: '並び替えと絞り込み', systemImage: 'arrow.up.arrow.down', startsSection: true });
		if (ackCount > 0) {
			list.push({ id: 'ack-all', title: 'すべて確認済みにする', systemImage: 'checkmark.circle' });
		}
		return list;
	}, [ackCount, hasSpace]);

	if (ParaPlusMenuButton !== undefined) {
		return (
			<ParaPlusMenuButton
				style={styles.nativeButton}
				items={items}
				accessibilityTitle="作成と表示のメニュー"
				onSelect={event => {
					hapticImpact('light');
					// 入れ子の親（'agent'）自体は選ばれない（OSが子を出すだけ）。
					const id = event.nativeEvent.id as HomePlusMenuAction;
					onSelect(id);
				}}
			/>
		);
	}
	return <FallbackPlusMenu onSelect={onSelect} ackCount={ackCount} hasSpace={hasSpace} />;
}

/**
 * ネイティブの標準メニューが無いビルド（Android・このモジュールを含まない旧バイナリ）向け。
 *
 * ここでモーフを真似ることはしない。**素直にパネルを出す**——中途半端に似せると、
 * 本物を知っている人には壊れて見えるだけなので、別の見せ方だと分かる形にしておく。
 * 入れ子もやめて、エージェントの3つをそのまま並べる。
 */
function FallbackPlusMenu({ onSelect, ackCount, hasSpace }: HomePlusMenuProps) {
	const [open, setOpen] = useState(false);
	const insets = useStableInsets();
	const toastInset = useToastInset();

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

	const pick = (action: HomePlusMenuAction) => {
		hapticImpact('light');
		setOpen(false);
		onSelect(action);
	};

	return (
		<>
			<Pressable
				style={({ pressed }) => [styles.fallbackButton, pressed && styles.pressed]}
				hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
				onPress={() => { hapticImpact('light'); setOpen(value => !value); }}
				accessibilityRole="button"
				accessibilityLabel="作成と表示のメニュー"
				accessibilityState={{ expanded: open }}
			>
				<Ionicons name={open ? 'close' : 'add'} size={21} color={colors.text} />
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
					<PopIn style={[styles.fallbackPanelPos, { top: insets.top + toastInset + HEADER_PILL_HEIGHT + 10 }]}>
						<GlassSurface style={styles.fallbackPanel}>
							<View style={styles.plate} pointerEvents="none" />
							<View style={styles.fallbackBody}>
								{AGENT_CHILDREN.map(child => (
									<MenuRow key={child.action} icon={child.ion} label={`${child.title} を起動`} onPress={() => pick(child.action)} />
								))}
								<View style={styles.divider} />
								<MenuRow icon="git-branch-outline" label="ワークツリーを作成" onPress={() => pick('new-worktree')} />
								{hasSpace ? <MenuRow icon="document-text-outline" label="メモ" onPress={() => pick('space-note')} /> : null}
								<View style={styles.divider} />
								<MenuRow icon="swap-vertical-outline" label="並び替えと絞り込み" onPress={() => pick('sort')} />
								{ackCount > 0 ? <MenuRow icon="checkmark-done-outline" label="すべて確認済みにする" onPress={() => pick('ack-all')} /> : null}
							</View>
						</GlassSurface>
					</PopIn>
				</OverlayPortal>
			) : null}
		</>
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

/** フォールバックのパネル幅。 */
const PANEL_WIDTH = 262;

const styles = StyleSheet.create({
	// ネイティブのボタン。ピルの中の他のボタンと同じ当たり判定にする。
	nativeButton: { width: 34, height: HEADER_PILL_HEIGHT - 6, borderRadius: radius.pill },
	fallbackButton: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },

	scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
	fallbackPanelPos: { position: 'absolute', right: 12, width: PANEL_WIDTH },
	fallbackPanel: { borderRadius: 26, ...squircle, overflow: 'hidden' },
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
