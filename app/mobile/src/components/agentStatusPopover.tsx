// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { BackHandler, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface, liquidGlass } from './glassSurface.js';
import { OverlayPortal, PopIn } from './overlayHost.js';
import { colors } from '../theme.js';
import { hapticImpact } from '../haptics.js';

export interface AgentStatusPopoverTarget {
	terminalKey: string;
	/** 現在のagentStatus（'permission' | 'question' | 'review' のとき開ける想定）。 */
	status: string;
}

const POPOVER_WIDTH = 200;

function statusLabel(status: string): string {
	return status === 'permission' ? '応答待ち' : status === 'question' ? '質問あり' : 'レビュー';
}

function statusDotColor(status: string): string {
	return status === 'permission' || status === 'question' ? colors.red : colors.yellow;
}

/**
 * ホーム一覧のステータスバッジをタップして開くポップオーバー（status.html 案B準拠）。
 * 「確認済みにする」でPC側のペイン既読と同じ処理を発火し、レビュー/応答待ちの
 * バッジをアイドルへ戻す。面はGlassSurface（iOS 26+はLiquid Glass）で、
 * terminalActionsMenuと同じくOverlayPortal＋scaleのみの出現演出を使う。
 */
export function AgentStatusPopover({ target, anchor, onClose, onAck }: {
	target: AgentStatusPopoverTarget | undefined;
	anchor: { x: number; y: number } | undefined;
	onClose: () => void;
	onAck: (terminalKey: string) => void;
}) {
	const open = target !== undefined && anchor !== undefined;

	// Android物理戻るボタンで閉じる
	useEffect(() => {
		if (!open) {
			return;
		}
		const sub = BackHandler.addEventListener('hardwareBackPress', () => {
			onClose();
			return true;
		});
		return () => sub.remove();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	if (!target || !anchor) {
		return null;
	}

	const { width: screenWidth } = Dimensions.get('window');
	// バッジは行の右端にあるため、タップ位置の右寄りにぶら下げる
	const left = Math.min(Math.max(anchor.x - POPOVER_WIDTH + 32, 16), screenWidth - POPOVER_WIDTH - 16);
	const top = anchor.y + 14;

	return (
		<OverlayPortal>
			<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="閉じる" />
			<PopIn style={[styles.pos, { top, left }]}>
				<GlassSurface style={[styles.popover, !liquidGlass && styles.popoverFallbackBorder]}>
					<Text style={styles.head}>このエージェントの状態</Text>
					<Pressable
						style={styles.item}
						onPress={() => { hapticImpact('light'); onAck(target.terminalKey); onClose(); }}
					>
						<View style={[styles.dot, styles.dotIdle]} />
						<Text style={styles.itemLabel}>確認済みにする</Text>
						<Ionicons name="checkmark" size={15} color={colors.accent} />
					</Pressable>
					<View style={styles.divider} />
					<View style={styles.item}>
						<View style={[styles.dot, { backgroundColor: statusDotColor(target.status) }]} />
						<Text style={[styles.itemLabel, styles.itemLabelDim]}>{statusLabel(target.status)}（現在）</Text>
					</View>
				</GlassSurface>
			</PopIn>
		</OverlayPortal>
	);
}

const styles = StyleSheet.create({
	pos: { position: 'absolute', width: POPOVER_WIDTH },
	// ネイティブglassは素材自体が縁の光を持つため、フォールバック時のみ枠線を描く
	popover: { borderRadius: 12, overflow: 'hidden' },
	popoverFallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	head: { color: colors.textDim, fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingTop: 9, paddingHorizontal: 13, paddingBottom: 5 },
	item: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 10, paddingHorizontal: 13 },
	itemLabel: { color: colors.text, fontSize: 13.5, flex: 1 },
	itemLabelDim: { color: colors.textDim },
	dot: { width: 8, height: 8, borderRadius: 4 },
	dotIdle: { backgroundColor: '#55555c' },
	divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder },
});
