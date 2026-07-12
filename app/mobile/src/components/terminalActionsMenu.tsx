// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
// 削除確認アラート（警告アイコン付き）の概算高さ。
const CONFIRM_HEIGHT_ESTIMATE = 190;

/**
 * ホーム一覧の長押しで開く、ターミナルの「名前を変更」「ピン留め」「削除」アクションメニュー。
 * 長押し位置にiOSネイティブ風のコンテキストメニューをポップアップし、「名前を変更」を
 * 選ぶと同モーダル内でシステムアラート風の入力ダイアログに切り替わる（案1準拠、uui.html参照）。
 * 「削除」はPC側の実ターミナルも閉じる破壊的操作のため、同様に同モーダル内で
 * 警告アイコン付きの確認ダイアログへ切り替える（acv.html パターンA準拠）。
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
	const [draft, setDraft] = useState('');
	const inputRef = useRef<TextInput>(null);

	useEffect(() => {
		if (target) {
			setMode('menu');
			setDraft(target.title);
		}
	}, [target]);

	if (!target || !anchor) {
		return null;
	}

	const close = () => {
		setMode('menu');
		onClose();
	};

	const submitRename = () => {
		const title = draft.trim();
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
	const heightEstimate = mode === 'confirm-delete' ? CONFIRM_HEIGHT_ESTIMATE : MENU_HEIGHT_ESTIMATE;
	const menuTop = Math.min(Math.max(anchor.y, 16), screenHeight - heightEstimate - 16);

	return (
		<Modal visible transparent animationType="fade" onRequestClose={close}>
			<Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="閉じる" />
			{mode === 'menu' ? (
				<View style={[styles.menu, { top: menuTop, left: menuLeft }]}>
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
				</View>
			) : mode === 'rename' ? (
				<View style={styles.alertWrap} pointerEvents="box-none">
					<Pressable style={styles.alertBackstop} onPress={close} accessibilityLabel="閉じる" />
					<View style={styles.alert}>
						<Text style={styles.alertTitle}>ターミナル名を変更</Text>
						<Text style={styles.alertSub}>PCのターミナルタブ名にも反映されます</Text>
						<TextInput
							ref={inputRef}
							style={styles.alertInput}
							value={draft}
							onChangeText={setDraft}
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
					</View>
				</View>
			) : (
				<View style={styles.alertWrap} pointerEvents="box-none">
					<Pressable style={styles.alertBackstop} onPress={close} accessibilityLabel="閉じる" />
					<View style={styles.alert}>
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
					</View>
				</View>
			)}
		</Modal>
	);
}

const styles = StyleSheet.create({
	menu: {
		position: 'absolute', width: MENU_WIDTH, backgroundColor: 'rgba(40,40,44,0.96)', borderRadius: 14,
		borderWidth: 1, borderColor: colors.glassBorder, overflow: 'hidden',
		shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 12,
	},
	menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 15 },
	menuItemLabel: { color: colors.text, fontSize: 15 },
	menuItemLabelDestructive: { color: colors.red },
	menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder },
	alertWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	alertBackstop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
	alert: { width: 270, backgroundColor: 'rgba(46,46,50,0.97)', borderRadius: 16, overflow: 'hidden' },
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
