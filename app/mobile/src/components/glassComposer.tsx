// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme.js';

/**
 * Liquid Glass風の2段コンポーザー（mo.html 案A2/T1）。上段にテキスト入力、
 * 下段にツール列（左: 呼び出し側が渡す任意のツール、右: 送信ボタン）。
 * 面はBlurView+半透明オーバーレイで、タブバーと質感を揃える。
 * エージェントタブ（モデル/Effortピル）とターミナルタブ（特殊キー列）で共用する。
 */
export function GlassComposer({ value, onChangeText, onSubmit, placeholder, tools, sendIcon = 'arrow-up', sendDisabled = false, monospace = false }: {
	value: string;
	onChangeText: (text: string) => void;
	onSubmit: () => void;
	placeholder: string;
	/** 下段ツール列の左側（モデルピル・特殊キー列など）。横幅が余ればスペーサで送信ボタンを右端に押す。 */
	tools?: ReactNode;
	sendIcon?: 'arrow-up' | 'return-down-back';
	sendDisabled?: boolean;
	/** ターミナル入力等、等幅フォントで表示する場合。 */
	monospace?: boolean;
}) {
	return (
		<View style={styles.wrap}>
			<BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
			<View style={[StyleSheet.absoluteFill, styles.overlay]} />
			<TextInput
				style={[styles.input, monospace && styles.inputMono]}
				value={value}
				onChangeText={onChangeText}
				placeholder={placeholder}
				placeholderTextColor={colors.textDim}
				autoCapitalize="none"
				autoCorrect={false}
				multiline={!monospace}
				onSubmitEditing={monospace ? onSubmit : undefined}
				blurOnSubmit={false}
			/>
			<View style={styles.tools}>
				<View style={styles.toolsLeft}>{tools}</View>
				<Pressable
					style={({ pressed }) => [styles.sendBtn, sendDisabled && styles.sendBtnDisabled, pressed && styles.sendBtnPressed]}
					onPress={onSubmit}
					disabled={sendDisabled}
					accessibilityLabel="送信"
				>
					<Ionicons name={sendIcon} size={18} color="#fff" />
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: {
		borderRadius: 26, borderWidth: 1, borderColor: colors.glassBorder,
		overflow: 'hidden', paddingTop: 12, paddingBottom: 10, paddingHorizontal: 14,
	},
	overlay: { backgroundColor: colors.glassBg },
	input: { color: colors.text, fontSize: 15, paddingHorizontal: 4, paddingBottom: 12, maxHeight: 120 },
	inputMono: { fontFamily: 'Menlo', fontSize: 13 },
	tools: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	// 下段ツール列（特殊キー等）に送信ボタン以外の全幅を使わせる（キーが見切れないように）
	toolsLeft: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
	sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.accent2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
	sendBtnDisabled: { backgroundColor: colors.surface3 },
	sendBtnPressed: { opacity: 0.6 },
});
