// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { useParaToast, type ParaToast } from '../paraToast.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { hapticImpact } from '../haptics.js';
import { colors, radius, space, type } from '../theme.js';

/**
 * 一時的なお知らせ（モックの `.toast`）。画面の下寄りに浮かぶ小さな札で、数秒で消える。
 *
 * 出すのは既存のストア（`src/paraToast.ts` の `useParaToast().show(...)`）で、表示はルートに1つだけ置く
 * {@link ToastHost} が受け持つ。画面から直接この部品を描かない。
 *
 * ```ts
 * useParaToast.getState().show({ key: 'copied', text: 'コピーしました', icon: 'copy-outline', tone: 'done' }, 1_900);
 * ```
 * （`icon` / `tone` は旧来のストアの形に合わせて渡すが、Orca の札はアイコンを出さない）
 */
export function Toast({ toast, onAction }: { toast: ParaToast; onAction?: () => void }) {
	return (
		<View style={styles.toast}>
			<View style={styles.textCol}>
				<Text style={styles.text} numberOfLines={2} accessibilityLiveRegion="polite">{toast.text}</Text>
				{toast.sub !== undefined && toast.sub.length > 0 ? <Text style={styles.sub} numberOfLines={1}>{toast.sub}</Text> : null}
			</View>
			{toast.action !== undefined ? (
				<Pressable onPress={onAction} hitSlop={space.md} accessibilityRole="button" accessibilityLabel={toast.action.label}>
					<Text style={styles.action}>{toast.action.label}</Text>
				</Pressable>
			) : null}
		</View>
	);
}

/**
 * 「別のPCへ切り替わりました」をお知らせに流す（通知のタップなどで自動で切り替わったとき）。
 * 旧 `src/components/paraToast.tsx` の同名の処理を引き継いだもの。旧ファイルは段階8で消す。
 */
function usePcSwitchToast(): void {
	const { notice, pcs, switchPc, dismissNotice } = useAppStore(useShallow(s => ({
		notice: s.pcSwitchNotice, pcs: s.pcs, switchPc: s.switchPc, dismissNotice: s.dismissPcSwitchNotice,
	})));
	const show = useParaToast(s => s.show);
	useEffect(() => {
		if (notice === undefined) {
			return;
		}
		const previous = notice.previousPcId !== undefined ? pcs.find(pc => pc.id === notice.previousPcId) : undefined;
		show({
			key: `pc-switch:${notice.pcId}`,
			text: `${notice.name} に切り替えました`,
			icon: 'desktop-outline',
			tone: 'info',
			...(previous !== undefined ? { action: { label: '戻る', onPress: () => switchPc(previous.id) } } : {}),
		}, 6_000);
		dismissNotice();
	}, [notice, pcs, show, switchPc, dismissNotice]);
}

/** 出入りの時間（ms。モックの `tin` は 0.2 秒）。 */
const IN_MS = 200;
const OUT_MS = 160;
/** 下からの位置（pt。モックの `bottom:196px` から、ホームインジケーターの 34 を引いた値）。 */
const BOTTOM_GAP = 162;

/** お知らせを出す唯一の場所。ルートレイアウト（`app/_layout.tsx`）に1つだけ置く。 */
export function ToastHost() {
	const insets = useStableInsets();
	const { current, hide } = useParaToast(useShallow(s => ({ current: s.current, hide: s.hide })));
	usePcSwitchToast();
	const anim = useRef(new Animated.Value(0)).current;
	// 消える動きの間も中身を描き続けるため、消え切るまで直前の内容を持つ。
	const [shown, setShown] = useState<ParaToast | undefined>(current);
	if (current !== undefined && current !== shown) {
		setShown(current);
	}

	useEffect(() => {
		if (current !== undefined) {
			const enter = Animated.timing(anim, { toValue: 1, duration: IN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true });
			enter.start();
			return () => enter.stop();
		}
		const leave = Animated.timing(anim, { toValue: 0, duration: OUT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true });
		leave.start();
		// 完了のコールバックで捨てると、木から外れた後に走ったときに落ちる経路を踏むのでタイマーにする。
		const timer = setTimeout(() => setShown(undefined), OUT_MS + 40);
		return () => {
			leave.stop();
			clearTimeout(timer);
		};
	}, [current, anim]);

	if (shown === undefined) {
		return null;
	}
	const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [6, 0] });
	return (
		<View style={[styles.host, { bottom: insets.bottom + BOTTOM_GAP }]} pointerEvents={current !== undefined && shown.action !== undefined ? 'box-none' : 'none'}>
			<Animated.View style={{ opacity: anim, transform: [{ translateY }] }}>
				<Toast
					toast={shown}
					onAction={() => {
						hapticImpact('light');
						shown.action?.onPress();
						hide();
					}}
				/>
			</Animated.View>
		</View>
	);
}

/** 札の最大幅（pt）。iPhone SE の 320pt でも左右に余白が残る。 */
const TOAST_MAX_WIDTH = 300;

const styles = StyleSheet.create({
	host: {
		position: 'absolute',
		left: 0,
		right: 0,
		alignItems: 'center',
	},
	toast: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		maxWidth: TOAST_MAX_WIDTH,
		backgroundColor: colors.raised,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		borderRadius: radius.button,
		paddingVertical: space.sm,
		paddingHorizontal: space.lg,
		shadowColor: colors.shadow,
		shadowOffset: { width: 0, height: 4 },
		shadowOpacity: 0.35,
		shadowRadius: 14,
		elevation: 6,
	},
	textCol: {
		flexShrink: 1,
	},
	text: {
		fontSize: type.label,
		color: colors.text,
	},
	sub: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: 2,
	},
	action: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.accent,
	},
});
