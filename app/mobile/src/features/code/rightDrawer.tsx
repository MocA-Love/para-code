// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, PanResponder, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useShortcutSlot } from '../../ipad/shortcutRegistry.js';
import { colors, radius, space } from '../../theme.js';

/**
 * 右から出るパネル（Orca の RightDrawer。iPad の差分レビューのファイル一覧に使う）。
 * 見た目はモック（concept-orca-ipad.html の `.rdpanel`）: 幅 420、地は `colors.bg`、左の上下だけ角丸 16。
 * 背景を押すか、パネルを右へ 80pt 以上（または速く）ずらすと閉じる。
 *
 * 約束は `BottomDrawer` と同じ: 木から外さず `visible` を切り替える。閉じる動きが終わってから
 * `onAfterClose` を呼ぶ（画面を移るのはそこで行う）。
 *
 * 汎用の部品なので、段階8で `src/ui/` へ移したい。
 */

/** パネルの幅（pt。Orca の既定）。画面がこれより狭ければ画面の幅。 */
const PANEL_WIDTH = 420;
const SHOW_MS = 180;
const HIDE_MS = 150;
/** ここまで右へずらしたら閉じる（pt）。速さ（pt/ms）が乗っていればこれ未満でも閉じる。 */
const DISMISS_DISTANCE = 80;
const DISMISS_VELOCITY = 0.5;
/** 左（内側）へ引いたときは付いてこさせず、この割合だけ動かす。 */
const RUBBER_BAND = 0.25;
/** 横へのずらしとみなす移動量（pt）。 */
const DRAG_SLOP = 8;

export function RightDrawer({ visible, onClose, onAfterClose, children, accessibilityLabel }: {
	visible: boolean;
	onClose: () => void;
	onAfterClose?: () => void;
	children: ReactNode;
	accessibilityLabel?: string;
}) {
	const [mounted, setMounted] = useState(visible);
	if (visible && !mounted) {
		setMounted(true);
	}
	const progress = useRef(new Animated.Value(0)).current;
	const drag = useRef(new Animated.Value(0)).current;
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const onAfterCloseRef = useRef(onAfterClose);
	onAfterCloseRef.current = onAfterClose;
	// 外付けキーボードの Esc で閉じる（iPad）。
	useShortcutSlot('escape', visible ? { escape: () => onCloseRef.current() } : undefined);
	const { width } = useWindowDimensions();
	const insets = useStableInsets();
	const panelWidth = Math.min(PANEL_WIDTH, width);

	useEffect(() => {
		if (!mounted) {
			return;
		}
		if (visible) {
			drag.setValue(0);
			Animated.timing(progress, { toValue: 1, duration: SHOW_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
			return;
		}
		Animated.timing(progress, { toValue: 0, duration: HIDE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
			if (finished) {
				setMounted(false);
				onAfterCloseRef.current?.();
			}
		});
	}, [visible, mounted, progress, drag]);

	const pan = useRef(PanResponder.create({
		onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > DRAG_SLOP && Math.abs(gesture.dx) > Math.abs(gesture.dy),
		onPanResponderMove: (_, gesture) => {
			drag.setValue(gesture.dx > 0 ? gesture.dx : gesture.dx * RUBBER_BAND);
		},
		onPanResponderRelease: (_, gesture) => {
			if (gesture.dx > DISMISS_DISTANCE || gesture.vx > DISMISS_VELOCITY) {
				onCloseRef.current();
				return;
			}
			Animated.spring(drag, { toValue: 0, useNativeDriver: true, damping: 28, stiffness: 400 }).start();
		},
		onPanResponderTerminate: () => {
			Animated.spring(drag, { toValue: 0, useNativeDriver: true, damping: 28, stiffness: 400 }).start();
		},
	})).current;

	if (!mounted) {
		return null;
	}
	const translateX = Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [panelWidth, 0] }), drag);
	return (
		<Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
			<View style={styles.fill}>
				<Animated.View style={[styles.fill, styles.backdrop, { opacity: progress }]}>
					<Pressable style={styles.fill} onPress={onClose} accessibilityRole="button" accessibilityLabel="閉じる" />
				</Animated.View>
				<Animated.View
					{...pan.panHandlers}
					style={[
						styles.panel,
						{ width: panelWidth, paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md, transform: [{ translateX }] },
					]}
					accessibilityViewIsModal
					accessibilityLabel={accessibilityLabel}
				>
					<ScrollView style={styles.fill} showsVerticalScrollIndicator={false}>{children}</ScrollView>
				</Animated.View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	backdrop: {
		position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
		backgroundColor: colors.scrim,
	},
	panel: {
		position: 'absolute',
		top: 0,
		right: 0,
		bottom: 0,
		paddingHorizontal: space.md,
		backgroundColor: colors.bg,
		borderTopLeftRadius: radius.sheet,
		borderBottomLeftRadius: radius.sheet,
		borderLeftWidth: StyleSheet.hairlineWidth,
		borderLeftColor: colors.border,
		shadowColor: colors.shadow,
		shadowOffset: { width: -2, height: 0 },
		shadowOpacity: 0.2,
		shadowRadius: 10,
	},
});
