// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { BackHandler, Dimensions, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface, liquidGlass } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { colors } from '../theme.js';
import { hapticImpact, hapticSelection, hapticWarning } from '../haptics.js';

export interface TerminalActionsMenuTarget {
	id: number;
	title: string;
	pinned: boolean;
}

const MENU_WIDTH = 220;
// メニュー項目3つ+区切り線の概算高さ（実測値を使わずクランプするための見積もり）。
const MENU_HEIGHT_ESTIMATE = 150;

/**
 * ホーム一覧の長押しで開く、ターミナルの「名前を変更」「ピン留め」「削除」アクションメニュー。
 * 長押し位置にコンテキストメニューをポップアップし、「名前を変更」を選ぶと
 * システムアラート風の入力ダイアログに切り替わる（案1準拠、uui.html参照）。
 * 「削除」はPC側の実ターミナルも閉じる破壊的操作のため、警告アイコン付きの
 * 確認ダイアログへ切り替える（acv.html パターンA準拠）。
 *
 * 面はGlassSurface（iOS 26+は本物のLiquid Glass、それ未満はBlurViewフォールバック）。
 * RN Modalは使わずOverlayPortal（overlayHost.tsx参照）でルートへ描画する。
 * Modalのfadeは祖先opacityのアニメーションでglass効果を消してしまうため、
 * 出現アニメーションもopacityを使わないscaleのみで行う。
 */
export function TerminalActionsMenu({ target, anchor, onClose, onRename, onTogglePin, onDelete }: {
	target: TerminalActionsMenuTarget | undefined;
	anchor: { x: number; y: number } | undefined;
	onClose: () => void;
	onRename: (id: number, title: string) => void;
	onTogglePin: (id: number) => void;
	onDelete: (id: number) => void;
}) {
	const [mode, setMode] = useState<'menu' | 'rename' | 'confirm-delete'>('menu');
	// リネーム入力の下書き。OverlayHost経由の再描画1拍遅れでcontrolled inputの
	// カーソルが乱れないよう、TextInputはuncontrolled（defaultValue）にしてrefで持つ。
	const draftRef = useRef('');
	const inputRef = useRef<TextInput>(null);

	useEffect(() => {
		if (target) {
			setMode('menu');
			draftRef.current = target.title;
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

	const submitRename = () => {
		const title = draftRef.current.trim();
		if (title.length > 0 && title !== target.title) {
			onRename(target.id, title);
		}
		close();
	};

	const commitDelete = () => {
		onDelete(target.id);
		close();
	};

	const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
	const menuLeft = Math.min(Math.max(anchor.x - MENU_WIDTH / 2, 16), screenWidth - MENU_WIDTH - 16);
	const menuTop = Math.min(Math.max(anchor.y, 16), screenHeight - MENU_HEIGHT_ESTIMATE - 16);

	return (
		<OverlayPortal>
			<Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="閉じる" />
			{mode === 'menu' ? (
				<PopIn style={[styles.menuPos, { top: menuTop, left: menuLeft }]}>
					<GlassSurface style={[styles.menu, !liquidGlass && styles.menuFallbackBorder]}>
						<Pressable
							style={styles.menuItem}
							onPress={() => { hapticSelection(); setMode('rename'); setTimeout(() => inputRef.current?.focus(), 60); }}
						>
							<Text style={styles.menuItemLabel}>名前を変更</Text>
							<Ionicons name="pencil" size={16} color={colors.textDim} />
						</Pressable>
						<View style={styles.menuDivider} />
						<Pressable
							style={styles.menuItem}
							onPress={() => { hapticImpact('light'); onTogglePin(target.id); close(); }}
						>
							<Text style={styles.menuItemLabel}>{target.pinned ? 'ピン留めを解除' : 'ピン留め'}</Text>
							<Ionicons name={target.pinned ? 'bookmark' : 'bookmark-outline'} size={16} color={colors.textDim} />
						</Pressable>
						<View style={styles.menuDivider} />
						<Pressable
							style={styles.menuItem}
							onPress={() => { hapticWarning(); setMode('confirm-delete'); }}
						>
							<Text style={[styles.menuItemLabel, styles.menuItemLabelDestructive]}>削除</Text>
							<Ionicons name="trash-outline" size={16} color={colors.red} />
						</Pressable>
					</GlassSurface>
				</PopIn>
			) : mode === 'rename' ? (
				<KeyboardAvoidingView style={styles.alertWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined} pointerEvents="box-none">
					<PopIn>
						<GlassSurface style={[styles.alert, !liquidGlass && styles.alertFallbackBorder]}>
							<Text style={styles.alertTitle}>ターミナル名を変更</Text>
							<Text style={styles.alertSub}>PCのターミナルタブ名にも反映されます</Text>
							<TextInput
								ref={inputRef}
								style={styles.alertInput}
								defaultValue={target.title}
								onChangeText={text => { draftRef.current = text; }}
								selectTextOnFocus
								autoFocus
								returnKeyType="done"
								onSubmitEditing={submitRename}
							/>
							<View style={styles.alertBtns}>
								<Pressable style={styles.alertBtn} onPress={close}>
									<Text style={styles.alertBtnText}>キャンセル</Text>
								</Pressable>
								<View style={styles.alertBtnDivider} />
								<Pressable style={styles.alertBtn} onPress={submitRename}>
									<Text style={[styles.alertBtnText, styles.alertBtnPrimary]}>保存</Text>
								</Pressable>
							</View>
						</GlassSurface>
					</PopIn>
				</KeyboardAvoidingView>
			) : (
				<View style={styles.alertWrap} pointerEvents="box-none">
					<PopIn>
						<GlassSurface style={[styles.alert, !liquidGlass && styles.alertFallbackBorder]}>
							<View style={styles.alertIconWrap}>
								<View style={styles.alertIcon}>
									<Ionicons name="trash-outline" size={20} color={colors.red} />
								</View>
							</View>
							<Text style={styles.alertTitle}>ターミナルを削除しますか？</Text>
							<Text style={styles.alertSub}>「{target.title}」とPCの実ターミナルも閉じられます。この操作は取り消せません。</Text>
							<View style={styles.alertBtns}>
								<Pressable style={styles.alertBtn} onPress={close}>
									<Text style={styles.alertBtnText}>キャンセル</Text>
								</Pressable>
								<View style={styles.alertBtnDivider} />
								<Pressable style={styles.alertBtn} onPress={commitDelete}>
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

const styles = StyleSheet.create({
	menuPos: { position: 'absolute', width: MENU_WIDTH },
	// ネイティブglassは素材自体が縁の光を持つため、フォールバック時のみ枠線を描く（glassComposerと同じ流儀）
	menu: { borderRadius: 14, overflow: 'hidden' },
	menuFallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 15 },
	menuItemLabel: { color: colors.text, fontSize: 15 },
	menuItemLabelDestructive: { color: colors.red },
	menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder },
	alertWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
	alert: { width: 270, borderRadius: 16, overflow: 'hidden' },
	alertFallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	alertIconWrap: { alignItems: 'center', paddingTop: 16 },
	alertIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(244,114,114,0.14)', alignItems: 'center', justifyContent: 'center' },
	alertTitle: { color: colors.text, fontSize: 15, fontWeight: '700', textAlign: 'center', paddingTop: 18, paddingHorizontal: 16 },
	alertSub: { color: colors.textDim, fontSize: 12, textAlign: 'center', paddingTop: 4, paddingHorizontal: 16, paddingBottom: 12, lineHeight: 17 },
	alertInput: {
		marginHorizontal: 14, marginBottom: 14, backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: colors.borderStrong,
		borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, color: colors.text, fontSize: 14,
	},
	alertBtns: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.14)' },
	alertBtn: { flex: 1, alignItems: 'center', paddingVertical: 13 },
	alertBtnDivider: { width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.14)' },
	alertBtnText: { color: colors.text, fontSize: 16 },
	alertBtnPrimary: { color: colors.accent, fontWeight: '700' },
	alertBtnDanger: { color: colors.red, fontWeight: '700' },
});
