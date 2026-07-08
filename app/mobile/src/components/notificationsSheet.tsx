// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import type { NotifyKind, NotifyPayload } from '@para/protocol';
import { BottomSheet } from './bottomSheet.js';
import { colors } from '../theme.js';

function dotColor(kind: NotifyKind): string {
	switch (kind) {
		case 'agent-question': return colors.red;
		case 'agent-done': return colors.green;
		case 'agent-error': return colors.red;
		case 'disconnected': return colors.yellow;
		default: return colors.textDim;
	}
}

function formatRelativeTime(at: number): string {
	const diffSec = Math.max(0, Math.floor((Date.now() - at) / 1000));
	if (diffSec < 60) {
		return '今';
	}
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) {
		return `${diffMin}分前`;
	}
	const diffHour = Math.floor(diffMin / 60);
	if (diffHour < 24) {
		return `${diffHour}時間前`;
	}
	return `${Math.floor(diffHour / 24)}日前`;
}

/**
 * ホーム右上の通知ボタン（Liquid Glassの丸ボタン、BeReal風）と、タップで開く
 * 通知一覧のボトムシート。応答待ち（agent-question）の通知が残っている間は
 * ベルに赤バッジを出す。
 */
export function NotificationsButton({ notifications, onOpenNotification }: {
	notifications: readonly NotifyPayload[];
	/** 通知行のタップ（ws/terminalIdがあるもののみ呼ばれる）。呼び出し側で遷移する。 */
	onOpenNotification: (payload: NotifyPayload) => void;
}) {
	const [open, setOpen] = useState(false);
	const questionCount = notifications.filter(n => n.kind === 'agent-question').length;

	return (
		<>
			<Pressable style={styles.bellBtn} onPress={() => setOpen(true)} accessibilityLabel="通知">
				<BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
				<View style={[StyleSheet.absoluteFill, styles.bellOverlay]} />
				<Ionicons name="notifications-outline" size={18} color={colors.text} />
				{questionCount > 0 ? (
					<View style={styles.bellBadge}><Text style={styles.bellBadgeText}>{questionCount}</Text></View>
				) : null}
			</Pressable>

			<BottomSheet visible={open} onClose={() => setOpen(false)} title="通知">
				<ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
					{notifications.length === 0 ? (
						<Text style={styles.empty}>通知はありません</Text>
					) : notifications.map(n => {
						const openable = n.ws !== undefined || n.terminalId !== undefined;
						return (
							<Pressable
								key={n.id}
								style={styles.row}
								disabled={!openable}
								onPress={() => { setOpen(false); onOpenNotification(n); }}
							>
								<View style={[styles.dot, { backgroundColor: dotColor(n.kind) }]} />
								<View style={styles.body}>
									<Text style={styles.rowTitle} numberOfLines={1}>{n.title}</Text>
									<Text style={styles.rowBody} numberOfLines={2}>{n.body}</Text>
								</View>
								<Text style={styles.time}>{formatRelativeTime(n.at)}</Text>
								{openable ? <Ionicons name="chevron-forward" size={13} color={colors.textDim} /> : null}
							</Pressable>
						);
					})}
				</ScrollView>
			</BottomSheet>
		</>
	);
}

const styles = StyleSheet.create({
	bellBtn: {
		width: 40, height: 40, borderRadius: 20, overflow: 'hidden',
		borderWidth: 1, borderColor: colors.glassBorder,
		alignItems: 'center', justifyContent: 'center',
	},
	bellOverlay: { backgroundColor: colors.glassBg },
	bellBadge: {
		position: 'absolute', top: 3, right: 3, minWidth: 15, height: 15, borderRadius: 8,
		backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
	},
	bellBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
	list: { paddingHorizontal: 14 },
	listContent: { paddingBottom: 32 },
	empty: { color: colors.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 32 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, marginBottom: 4 },
	dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
	body: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
	rowBody: { color: colors.textDim, fontSize: 11.5, marginTop: 1, lineHeight: 15 },
	time: { color: colors.textDim, fontSize: 10.5, flexShrink: 0 },
});
