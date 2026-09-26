// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { BackHandler, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { GlassSurface } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { AgentRowClone, type AgentRowData, type AgentRowRect } from './agentRow.js';
import { homeAgentMenuItems, type HomeAgentMenuAction, type HomeAgentMenuTarget } from './homeAgentActionsMenuItems.js';
import { promptTerminalName } from '../promptTerminalName.js';
import { HIT_SIZE, alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { hapticImpact, hapticWarning } from '../haptics.js';

export type { HomeAgentMenuTarget } from './homeAgentActionsMenuItems.js';

const MENU_WIDTH = 220;
/** 1項目の高さの見積もり（実測を待たずに画面内へ収めるためのもの）。 */
const MENU_ITEM_ESTIMATE = HIT_SIZE + 2;

/**
 * ホームのエージェント行の操作メニュー。行の長押しと、行の右端の ⋯ の両方から開く
 * （同じメニューにして、長押しを知らなくても同じ操作に辿り着けるようにする）。
 *
 * 項目は「名前を変更」「ピン留め」「確認済みにする」「アーカイブ」「削除」。スワイプで出る
 * 3つ（確認済み・アーカイブ・削除）もここに入れ、スワイプを知らなくても片付けられるようにする。
 * どの項目を出すかは {@link homeAgentMenuItems} が決める。
 *
 * 見せ方は旧・長押しメニュー（terminalActionsMenu.tsx、この部品に置き換えて削除）を引き継ぐ: 背景を暗転＋軽いブラーで
 * 沈め、対象行だけを浮かせたクローンを残す（iOS のコンテキストメニューの作法）。面は
 * GlassSurface、RN Modal は使わず OverlayPortal に描く（Modal のフェードは祖先 opacity の
 * アニメーションでガラスの効果を消してしまうため、出現は scale だけで行う）。
 * 「削除」はPC側の実ターミナルも閉じる取り消せない操作なので、確認ダイアログへ切り替える。
 */
export function HomeAgentActionsMenu({ target, anchor, rect, rowData, onClose, onRename, onTogglePin, onAck, onArchive, onDelete }: {
	target: HomeAgentMenuTarget | undefined;
	anchor: { x: number; y: number } | undefined;
	/** 対象行のウィンドウ座標。リフトクローンの位置決めに使う（未取得なら省略可）。 */
	rect: AgentRowRect | undefined;
	/** リフトクローンとして再描画する行データ。 */
	rowData: AgentRowData | undefined;
	onClose: () => void;
	onRename: (terminalKey: string, title: string) => void;
	onTogglePin: (terminalKey: string) => void;
	onAck: (terminalKey: string) => void;
	onArchive: (terminalKey: string, title: string) => void;
	onDelete: (terminalKey: string) => void;
}) {
	const [mode, setMode] = useState<'menu' | 'confirm-delete'>('menu');
	useEffect(() => {
		if (target) {
			setMode('menu');
		}
	}, [target]);

	const open = target !== undefined && anchor !== undefined;

	const close = () => {
		setMode('menu');
		onClose();
	};

	// Android物理戻るボタンで閉じる（Modal時代のonRequestClose相当）
	useEffect(() => {
		if (!open) {
			return;
		}
		const sub = BackHandler.addEventListener('hardwareBackPress', () => {
			close();
			return true;
		});
		return () => sub.remove();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	if (!target || !anchor) {
		return null;
	}

	const commitDelete = () => {
		// 破壊的操作の手応えは「実行時」に鳴らす（確認ダイアログ表示時にも鳴っているので、
		// ここで二重に鳴るのは意図した統一。agentInfoSheet と同じ）。
		hapticWarning();
		onDelete(target.terminalKey);
		close();
	};

	const run = (action: HomeAgentMenuAction) => {
		const { terminalKey, title } = target;
		switch (action) {
			case 'rename':
				// 先に閉じてからOSのアラートを出す。`target` は閉じると消えるので、
				// 必要な値（キーと現在の名前）を先に捕まえてから渡す。
				close();
				promptTerminalName(title, next => onRename(terminalKey, next));
				return;
			case 'pin':
				hapticImpact('light');
				onTogglePin(terminalKey);
				close();
				return;
			case 'ack':
				hapticImpact('light');
				onAck(terminalKey);
				close();
				return;
			case 'archive':
				hapticImpact('light');
				close();
				onArchive(terminalKey, title);
				return;
			case 'delete':
				hapticWarning();
				setMode('confirm-delete');
				return;
		}
	};

	const items = homeAgentMenuItems(target);
	const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
	const menuHeight = items.length * MENU_ITEM_ESTIMATE;
	const menuLeft = Math.min(Math.max(anchor.x - MENU_WIDTH / 2, 16), screenWidth - MENU_WIDTH - 16);
	// リフトクローンがある場合はその下端を基準にして、浮いた行とメニューが重ならないようにする。
	const menuAnchorTop = rect ? rect.y + rect.height + 10 : anchor.y;
	const menuTop = Math.min(Math.max(menuAnchorTop, 16), screenHeight - menuHeight - 16);

	return (
		<OverlayPortal>
			<DimScrim onPress={close} />
			{rowData && rect ? <AgentRowClone data={rowData} rect={rect} /> : null}
			{mode === 'menu' ? (
				<PopIn style={[styles.menuPos, { top: menuTop, left: menuLeft }]}>
					<GlassSurface style={styles.menu}>
						{items.map((item, index) => (
							<View key={item.action}>
								{index > 0 ? <View style={styles.menuDivider} /> : null}
								<Pressable
									style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
									onPress={() => run(item.action)}
									accessibilityRole="button"
									accessibilityLabel={item.label}
								>
									<Text style={[styles.menuItemLabel, item.destructive === true && styles.menuItemLabelDestructive]}>{item.label}</Text>
									<Ionicons name={item.icon} size={16} color={item.destructive === true ? colors.red : colors.textDim} />
								</Pressable>
							</View>
						))}
					</GlassSurface>
				</PopIn>
			) : (
				<View style={styles.alertWrap} pointerEvents="box-none">
					<PopIn>
						<GlassSurface style={styles.alert}>
							<View style={styles.alertIconWrap}>
								<View style={styles.alertIcon}>
									<Ionicons name="trash-outline" size={20} color={colors.red} />
								</View>
							</View>
							<Text style={styles.alertTitle}>ターミナルを削除しますか？</Text>
							<Text style={styles.alertSub}>「{target.title}」とPCの実ターミナルも閉じられます。この操作は取り消せません。</Text>
							<View style={styles.alertBtns}>
								<Pressable style={styles.alertBtn} onPress={close} accessibilityRole="button">
									<Text style={styles.alertBtnText}>キャンセル</Text>
								</Pressable>
								<View style={styles.alertBtnDivider} />
								<Pressable style={styles.alertBtn} onPress={commitDelete} accessibilityRole="button">
									<Text style={[styles.alertBtnText, styles.alertBtnDanger]}>削除</Text>
								</Pressable>
							</View>
						</GlassSurface>
					</PopIn>
				</View>
			)}
		</OverlayPortal>
	);
}

/**
 * 背景全体を暗転+軽いブラーで沈める、タップで閉じるバックドロップ。スクリム自体は
 * glass面ではないので、フェードインの opacity アニメーションを使える（PopIn の 160ms と
 * 揃える）。Blurが使えない環境でも半透明の暗幕だけで破綻なく成立する。
 */
function DimScrim({ onPress }: { onPress: () => void }) {
	const progress = useSharedValue(0);
	useEffect(() => {
		progress.value = withTiming(1, { duration: 160, easing: Easing.out(Easing.cubic) });
	}, [progress]);
	const animatedStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
	return (
		<Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
			<BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
			<Pressable style={[StyleSheet.absoluteFill, styles.scrimDim]} onPress={onPress} accessibilityLabel="閉じる" />
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	scrimDim: { backgroundColor: colors.scrim },
	menuPos: { position: 'absolute', width: MENU_WIDTH },
	// ネイティブglassは素材自体が縁の光を持つため、枠線は描かない（glassComposerと同じ流儀）
	menu: { borderRadius: radius.card, ...squircle, overflow: 'hidden' },
	menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: HIT_SIZE, paddingHorizontal: 15 },
	menuItemPressed: { backgroundColor: tint(colors.text, alpha.faint) },
	menuItemLabel: { color: colors.text, fontSize: type.title },
	menuItemLabelDestructive: { color: colors.red },
	menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder },
	alertWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
	alert: { width: 270, borderRadius: radius.card, ...squircle, overflow: 'hidden' },
	alertIconWrap: { alignItems: 'center', paddingTop: 16 },
	alertIcon: { width: 40, height: 40, borderRadius: radius.pill, ...squircle, backgroundColor: tint(colors.red, alpha.wash), alignItems: 'center', justifyContent: 'center' },
	alertTitle: { color: colors.text, fontSize: type.title, fontWeight: '700', textAlign: 'center', paddingTop: 18, paddingHorizontal: 16 },
	alertSub: { color: colors.textDim, fontSize: type.meta, textAlign: 'center', paddingTop: 4, paddingHorizontal: 16, paddingBottom: 12, lineHeight: 17 },
	alertBtns: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.glassBorder },
	alertBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT_SIZE },
	alertBtnDivider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder },
	alertBtnText: { color: colors.text, fontSize: type.title },
	alertBtnDanger: { color: colors.red, fontWeight: '700' },
});
