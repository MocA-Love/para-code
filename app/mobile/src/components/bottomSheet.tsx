// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Keyboard, KeyboardEvent, LayoutAnimation, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassSurface } from './glassSurface.js';
import { colors } from '../theme.js';
import { hapticImpact } from '../haptics.js';
import { useStableInsets } from '../hooks/useStableInsets.js';

/**
 * ボトムシート共通コンポーネント。Modalの標準アニメーション（animationType="slide"）は
 * オーバーレイ（暗幕）がシートより先に一括表示されて不自然なため、暗幕のフェードと
 * シートのスライドを同じAnimated値で同期させる（wsBarのシートと同じ挙動）。
 *
 * キーボード対応: シートは画面下端に固定されているため、シート内のKeyboardAvoidingViewでは
 * シート自体が持ち上がらず、下部の入力欄がキーボードに完全に隠れる。iOSではキーボードの
 * 実フレーム（keyboardWillChangeFrame）を監視してシートの bottom をその高さぶん持ち上げ、
 * 併せて maxHeight を残りの表示領域に収まるよう縮める（useKeyboardVisible と同じ理由で
 * 80px以下の小フレームはハードウェアキーボードのアクセサリバーとして無視する）。
 * AndroidはwindowSoftInputMode=adjustResizeがModalごと縮めるため何もしない。
 */

/** iOSのキーボード被覆高さ（画面下端から）。シートの持ち上げ量に使う。 */
function useKeyboardInset(): number {
	const [inset, setInset] = useState(0);
	const windowHeight = useWindowDimensions().height;
	useEffect(() => {
		if (Platform.OS !== 'ios') {
			return;
		}
		const applyInset = (next: number, event: KeyboardEvent) => {
			setInset(current => {
				if (current === next) {
					return current;
				}
				// キーボードのアニメーションカーブに合わせてレイアウト変化を滑らかにする
				LayoutAnimation.configureNext({
					duration: event.duration > 0 ? event.duration : 250,
					update: { type: 'keyboard' },
				});
				return next;
			});
		};
		const change = Keyboard.addListener('keyboardWillChangeFrame', event => {
			const covered = Math.max(0, windowHeight - event.endCoordinates.screenY);
			applyInset(covered > 80 ? covered : 0, event);
		});
		const hide = Keyboard.addListener('keyboardWillHide', event => applyInset(0, event));
		return () => {
			change.remove();
			hide.remove();
		};
	}, [windowHeight]);
	return inset;
}
export function BottomSheet({ visible, onClose, onConfirm, title, children, fullHeight = false, glass = false }: {
	visible: boolean;
	/** 背景タップ・Androidバックボタン・（onConfirm未指定時は唯一の）閉じるボタンで呼ばれる「キャンセル」。 */
	onClose: () => void;
	/** 指定するとヘッダーが左✕（キャンセル=onClose）／右✓（確定）の2ボタン構成になる。未指定なら従来通り右上✕のみ。 */
	onConfirm?: () => void;
	title: string;
	children: ReactNode;
	/** 既定は高さ72%固定。trueにするとセーフエリア上端まで広げたほぼ全画面表示になる（通知一覧など）。 */
	fullHeight?: boolean;
	/** モーダル単位でLiquid Glassを有効化する。内部の操作要素は不透明のままにする。 */
	glass?: boolean;
}) {
	const anim = useRef(new Animated.Value(0)).current;
	const [mounted, setMounted] = useState(visible);
	const insets = useStableInsets();
	const keyboardInset = useKeyboardInset();
	const windowHeight = useWindowDimensions().height;

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
			<Animated.View
				style={[
					styles.sheet,
					glass && styles.glassSheet,
					fullHeight && { maxHeight: undefined, top: insets.top },
					// キーボード表示中はその高さぶん持ち上げ、残りの表示領域に収める
					// （fullHeightはtop固定なのでbottomの持ち上げだけで自然に縮む）
					keyboardInset > 0 && { bottom: keyboardInset },
					keyboardInset > 0 && !fullHeight && { maxHeight: Math.max(240, Math.min(windowHeight * 0.72, windowHeight - keyboardInset - insets.top - 12)) },
					{ transform: [{ translateY }] },
				]}
			>
				{glass ? <GlassSurface style={styles.glassBackdrop} /> : null}
				<View style={styles.handle} />
				<View style={styles.head}>
					{onConfirm ? (
						<>
							<Pressable style={styles.headerBtn} onPress={() => { hapticImpact('light'); onClose(); }} accessibilityRole="button" accessibilityLabel="キャンセル">
								<Ionicons name="close" size={16} color={colors.textDim} />
							</Pressable>
							<Text style={styles.title}>{title}</Text>
							<Pressable style={[styles.headerBtn, styles.confirmBtn]} onPress={() => { hapticImpact('light'); onConfirm(); }} accessibilityRole="button" accessibilityLabel="確定">
								<Ionicons name="checkmark" size={16} color={colors.bg} />
							</Pressable>
						</>
					) : (
						<>
							<Text style={styles.title}>{title}</Text>
							<Pressable style={styles.close} onPress={() => { hapticImpact('light'); onClose(); }} accessibilityLabel="閉じる">
								<Ionicons name="close" size={14} color={colors.textDim} />
							</Pressable>
						</>
					)}
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
	glassSheet: { backgroundColor: 'transparent', overflow: 'hidden' },
	glassBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
	handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
	head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 12 },
	title: { color: colors.text, fontSize: 16, fontWeight: '700' },
	close: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	headerBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	confirmBtn: { backgroundColor: colors.accent },
});
