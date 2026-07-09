// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { isAgentWaiting } from '../store.js';
import { colors } from '../theme.js';

/**
 * ワークスペース選択（モックアップ mock-2.html 準拠）。ヘッダーのピル型ピッカーをタップすると
 * ボトムシートが開き、ワークスペースを選ぶ。ホーム/エージェント/ターミナル/ソース管理/
 * ファイル/ブラウザの全画面で共有し、選択は全画面で連動する。
 */
export function WsBar() {
	const { workspace, selectedWs, setSelectedWs } = useAppStore(useShallow(s => ({
		workspace: s.workspace, selectedWs: s.selectedWs, setSelectedWs: s.setSelectedWs,
	})));
	const [open, setOpen] = useState(false);
	const [mounted, setMounted] = useState(false);
	const anim = useRef(new Animated.Value(0)).current;
	const isFocused = useIsFocused();

	const list = workspace?.workspaces ?? [];

	const pendingByWs = new Map<string, number>();
	for (const t of workspace?.terminals ?? []) {
		if (isAgentWaiting(t.agentStatus) && t.ws) {
			pendingByWs.set(t.ws, (pendingByWs.get(t.ws) ?? 0) + 1);
		}
	}

	if (list.length === 0) {
		return null;
	}

	const effective = selectedWs && list.some(w => w.id === selectedWs) ? selectedWs : list[0]?.id;
	const current = list.find(w => w.id === effective);
	const currentPending = pendingByWs.get(effective ?? '') ?? 0;

	// mount/unmountの真偽はopenに同期させ、退場アニメの間だけmountedを維持する（bottomSheet.tsxと同じ方式）。
	// これにより「閉じアニメのコールバックが確定しない限りModalが残り続ける」状態を避け、
	// 画面凍結や再レンダー競合時にopacity:0の全画面Pressableがタッチを奪い続ける事故を防ぐ。
	useEffect(() => {
		if (open) {
			setMounted(true);
			Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
		} else {
			Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setMounted(false));
		}
	}, [open, anim]);

	// タブがフォーカスを失ったら、アニメ完了を待たず即座に閉じ状態へ強制リセットする。
	useEffect(() => {
		if (!isFocused) {
			setOpen(false);
			setMounted(false);
			anim.setValue(0);
		}
	}, [isFocused, anim]);

	const openSheet = () => {
		setOpen(true);
	};
	const closeSheet = () => {
		setOpen(false);
	};
	const select = (id: string) => {
		setSelectedWs(id);
		closeSheet();
	};

	const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] });
	const overlayOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

	return (
		<>
			<Pressable style={styles.picker} onPress={openSheet} accessibilityLabel="ワークスペースを選択">
				<View style={[styles.dot, { backgroundColor: currentPending > 0 ? colors.red : colors.green }]} />
				<View style={styles.pickerBody}>
					<Text style={styles.pickerName} numberOfLines={1}>{current?.name ?? '—'}</Text>
					{current?.branch ? (
						<View style={styles.pickerBranchRow}>
							<Ionicons name="git-branch-outline" size={10} color={colors.textDim} />
							<Text style={styles.pickerBranch} numberOfLines={1}>{current.branch}</Text>
						</View>
					) : null}
				</View>
				<Ionicons name="chevron-down" size={14} color={colors.textDim} />
			</Pressable>

			<Modal visible={mounted} transparent animationType="none" onRequestClose={closeSheet}>
				<Animated.View style={[StyleSheet.absoluteFill, styles.overlay, { opacity: overlayOpacity }]} pointerEvents={open ? 'auto' : 'none'}>
					<Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} accessibilityLabel="閉じる" />
				</Animated.View>
				<Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
					<View style={styles.sheetHandle} />
					<View style={styles.sheetHead}>
						<Text style={styles.sheetTitle}>ワークスペース</Text>
						<Pressable style={styles.sheetClose} onPress={closeSheet} accessibilityLabel="閉じる">
							<Ionicons name="close" size={14} color={colors.textDim} />
						</Pressable>
					</View>
					<ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetScrollContent}>
						{list.map(ws => {
							const active = ws.id === effective;
							const pending = pendingByWs.get(ws.id) ?? 0;
							return (
								<Pressable key={ws.id} style={[styles.sheetRow, active && styles.sheetRowActive]} onPress={() => select(ws.id)}>
									<View style={styles.sheetIcon}>
										<Ionicons name="cube-outline" size={18} color={colors.textDim} />
										<View style={[styles.sheetDot, { backgroundColor: pending > 0 ? colors.red : colors.green }]} />
									</View>
									<View style={styles.sheetBody}>
										<Text style={styles.sheetName} numberOfLines={1}>{ws.name}</Text>
										{ws.branch ? <Text style={styles.sheetMeta} numberOfLines={1}>{ws.branch}</Text> : null}
									</View>
									{pending > 0 ? <View style={styles.sheetBadge}><Text style={styles.sheetBadgeText}>{pending}</Text></View> : null}
									{active ? <Ionicons name="checkmark" size={16} color={colors.accent} /> : null}
								</Pressable>
							);
						})}
					</ScrollView>
				</Animated.View>
			</Modal>
		</>
	);
}

/** 現在有効な選択ワークスペースIDを返すフック（未選択時は先頭）。 */
export function useEffectiveWs(): { id: string; name: string; branch?: string } | undefined {
	const { workspace, selectedWs } = useAppStore(useShallow(s => ({ workspace: s.workspace, selectedWs: s.selectedWs })));
	const list = workspace?.workspaces ?? [];
	return list.find(w => w.id === selectedWs) ?? list[0];
}

const styles = StyleSheet.create({
	picker: {
		flexDirection: 'row', alignItems: 'center', gap: 8,
		backgroundColor: colors.glassBg, borderWidth: 1, borderColor: colors.glassBorder,
		borderRadius: 16, paddingVertical: 8, paddingHorizontal: 12, marginHorizontal: 16, marginBottom: 10,
	},
	dot: { width: 8, height: 8, borderRadius: 4, marginLeft: 2 },
	pickerBody: { flex: 1, minWidth: 0 },
	pickerName: { color: colors.text, fontSize: 13, fontWeight: '700' },
	pickerBranchRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
	pickerBranch: { color: colors.textDim, fontSize: 10.5, fontFamily: 'Menlo' },
	overlay: { backgroundColor: 'rgba(0,0,0,.5)' },
	sheet: {
		position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72%',
		backgroundColor: colors.panel, borderTopLeftRadius: 28, borderTopRightRadius: 28,
		borderWidth: 1, borderColor: colors.glassBorder, borderBottomWidth: 0,
	},
	sheetHandle: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
	sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 12 },
	sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
	sheetClose: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	sheetScroll: { paddingHorizontal: 14 },
	sheetScrollContent: { paddingBottom: 24 },
	sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, marginBottom: 6, borderWidth: 1, borderColor: 'transparent' },
	sheetRowActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	sheetIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	sheetDot: { position: 'absolute', bottom: -1, right: -1, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.panel },
	sheetBody: { flex: 1, minWidth: 0 },
	sheetName: { color: colors.text, fontSize: 14, fontWeight: '700' },
	sheetMeta: { color: colors.textDim, fontSize: 11, marginTop: 1, fontFamily: 'Menlo' },
	sheetBadge: { backgroundColor: colors.red, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
	sheetBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
