// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme.js';
import { useStableInsets } from '../hooks/useStableInsets.js';

/**
 * ボトムシート共通コンポーネント。Modalの標準アニメーション（animationType="slide"）は
 * オーバーレイ（暗幕）がシートより先に一括表示されて不自然なため、暗幕のフェードと
 * シートのスライドを同じAnimated値で同期させる（wsBarのシートと同じ挙動）。
 */
export function BottomSheet({ visible, onClose, title, children, fullHeight = false }: {
	visible: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	/** 既定は高さ72%固定。trueにするとセーフエリア上端まで広げたほぼ全画面表示になる（通知一覧など）。 */
	fullHeight?: boolean;
}) {
	const anim = useRef(new Animated.Value(0)).current;
	const [mounted, setMounted] = useState(visible);
	const insets = useStableInsets();

	useEffect(() => {
		if (visible) {
			setMounted(true);
			Animated.timing(anim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
		} else {
			Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setMounted(false));
		}
	}, [visible, anim]);

	if (!mounted) {
		return null;
	}

	const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [480, 0] });

	return (
		<Modal visible transparent animationType="none" onRequestClose={onClose}>
			<Animated.View style={[StyleSheet.absoluteFill, styles.overlay, { opacity: anim }]}>
				<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="閉じる" />
			</Animated.View>
			<Animated.View style={[styles.sheet, fullHeight && { maxHeight: undefined, top: insets.top }, { transform: [{ translateY }] }]}>
				<View style={styles.handle} />
				<View style={styles.head}>
					<Text style={styles.title}>{title}</Text>
					<Pressable style={styles.close} onPress={onClose} accessibilityLabel="閉じる">
						<Ionicons name="close" size={14} color={colors.textDim} />
					</Pressable>
				</View>
				{children}
			</Animated.View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: { backgroundColor: 'rgba(0,0,0,.5)' },
	sheet: {
		position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72%',
		backgroundColor: colors.panel, borderTopLeftRadius: 28, borderTopRightRadius: 28,
		borderWidth: 1, borderColor: colors.glassBorder, borderBottomWidth: 0,
	},
	handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
	head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 12 },
	title: { color: colors.text, fontSize: 16, fontWeight: '700' },
	close: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
});
